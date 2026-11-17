import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { attachFileHandler, readLocalFile, ATTACH_MAX_BYTES } from '../src/tools/attachFile.ts';
import { clearApiEndpoint, runWithCredentials, setApiEndpoint } from '../src/auth/session.ts';
import { buildServer } from '../src/server.ts';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 0x20)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const DEMO = 'https://tok123@demo.datasafe.dev/alice/';

let dir: string;
const file = (name: string) => path.join(dir, name);

before(async () => {
  // A folder name that stands for a person's: it must never reach an error or the server.
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'Alice-Private-Folder-'));
  await fsp.writeFile(file('report.pdf'), PDF);
  await fsp.writeFile(file('photo.JPG'), JPEG);
  await fsp.writeFile(file('scan.png'), PNG);
  await fsp.writeFile(file('report.png'), PDF);
  await fsp.writeFile(file('notes.txt'), 'hello');
  await fsp.writeFile(file('noext'), PDF);
  await fsp.symlink(file('report.pdf'), file('link.pdf'));
  await fsp.mkdir(file('folder.pdf'));
  const big = await fsp.open(file('big.pdf'), 'w');
  await big.write(PDF, 0, PDF.length, 0);
  await big.truncate(ATTACH_MAX_BYTES + 1);
  await big.close();
});

after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

beforeEach(() => { setApiEndpoint(DEMO); });

type Call = { url: string; init?: RequestInit };

/** Mocks the core: events.getOne answers `event` (or an error), the multipart POST answers the event with its new file. */
function mockCore (t: any, event: any) {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://demo.datasafe.dev/alice/') {
      return new Response(JSON.stringify({ results: [event?.error ? event : { event }] }), { status: 200 });
    }
    const f = (init?.body as FormData).get('file') as File;
    return new Response(JSON.stringify({
      event: { ...event, attachments: [{ id: 'att1', fileName: f.name, type: f.type, size: f.size, readToken: 'secret-read-token' }] }
    }), { status: 200 });
  });
  return calls;
}

const doc = { id: 'evdoc1', type: 'file/xds-v1', streamIds: ['documents'], attachments: [] };

async function refusal (p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { return (err as Error).message; }
  assert.fail('expected a refusal');
}

test('attach_file: uploads the file as multipart to events/<id>, base name and detected type only', async (t) => {
  const calls = mockCore(t, doc);
  const res = await attachFileHandler({ eventId: 'evdoc1', path: file('report.pdf') });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), [{ method: 'events.getOne', params: { id: 'evdoc1' } }]);
  const up = calls[1];
  assert.equal(up.url, 'https://demo.datasafe.dev/alice/events/evdoc1');
  assert.equal(up.init?.method, 'POST');
  assert.equal((up.init?.headers as Record<string, string>).Authorization, 'tok123');
  assert.equal((up.init?.headers as Record<string, string>)['content-type'], undefined);
  const form = up.init?.body as FormData;
  assert.ok(form instanceof FormData);
  assert.deepEqual([...form.keys()], ['file']);
  const part = form.get('file') as File;
  assert.equal(part.name, 'report.pdf');
  assert.equal(part.type, 'application/pdf');
  assert.equal(part.size, PDF.length);
  // The bytes on the wire: the multipart body names the base name and the type, never the folder.
  const wire = await new Response(form).text();
  assert.match(wire, /Content-Disposition: form-data; name="file"; filename="report\.pdf"/);
  assert.match(wire, /Content-Type: application\/pdf/);
  assert.ok(!wire.includes(dir) && !wire.includes('Alice-Private-Folder'));

  const text = res.content.map((c) => c.text).join('\n');
  assert.match(text, /Attached "report\.pdf" \(\d+ bytes, application\/pdf\) to document event evdoc1 as attachment att1\./);
  assert.match(text, /Re-read the event with get_events/);
  assert.ok(!text.includes('secret-read-token'), 'never the readToken');
  assert.ok(!text.includes(dir));
});

test('readLocalFile: JPEG and PNG from their magic bytes, extension in any case', async () => {
  assert.equal((await readLocalFile(file('photo.JPG'))).mime, 'image/jpeg');
  assert.equal((await readLocalFile(file('scan.png'))).mime, 'image/png');
});

test('attach_file: refuses a relative path, a symlink, a folder, a device, a missing file and a too-big file, before any call', async (t) => {
  const calls = mockCore(t, doc);
  const cases: Array<[string, RegExp]> = [
    ['report.pdf', /File refused, nothing written: give the absolute path of the file/],
    [path.join('..', path.basename(dir), 'report.pdf'), /give the absolute path/],
    [file('link.pdf'), /"link\.pdf" is a symbolic link/],
    [file('folder.pdf'), /"folder\.pdf" is a folder, not a file/],
    ['/dev/null', /"null" is not a regular file/],
    [file('missing.pdf'), /"missing\.pdf" was not found/],
    [file('big.pdf'), /"big\.pdf" is larger than 20 MB/]
  ];
  for (const [p, re] of cases) {
    const msg = await refusal(attachFileHandler({ eventId: 'evdoc1', path: p }));
    assert.match(msg, re, p);
    assert.ok(!msg.includes(dir), `full path echoed for ${p}: ${msg}`);
  }
  assert.equal(calls.length, 0);
});

test('attach_file: refuses unknown content and an extension that disagrees with it', async (t) => {
  const calls = mockCore(t, doc);
  assert.match(await refusal(attachFileHandler({ eventId: 'evdoc1', path: file('notes.txt') })),
    /"notes\.txt" is not a PDF, JPEG or PNG file \(checked from its content, not its name\)/);
  assert.match(await refusal(attachFileHandler({ eventId: 'evdoc1', path: file('report.png') })),
    /"report\.png" holds a PDF file but its extension is "\.png"; the extension must agree with the content \(\.pdf\)/);
  assert.match(await refusal(attachFileHandler({ eventId: 'evdoc1', path: file('noext') })), /extension is missing/);
  assert.equal(calls.length, 0);
});

test('attach_file: refuses another type, an event with a file, a trashed event; nothing uploaded', async (t) => {
  for (const [event, re] of [
    [{ ...doc, type: 'note/txt' }, /Attachment refused, nothing written: event evdoc1 is of type "note\/txt"; attach_file only adds the file of a file\/xds-v1 document event\./],
    [{ ...doc, attachments: [{ id: 'old', fileName: 'a.pdf' }] }, /event evdoc1 already has an attachment/],
    [{ ...doc, trashed: true }, /event evdoc1 is in the trash/],
    [{ error: { id: 'unknown-resource', message: 'Unknown event "evdoc1"' } }, /Pryv events\.getOne failed: Unknown event/]
  ] as const) {
    const calls = mockCore(t, event);
    assert.match(await refusal(attachFileHandler({ eventId: 'evdoc1', path: file('report.pdf') })), re);
    assert.equal(calls.length, 1, 'only the read');
  }
});

test('attach_file: an id that is not one path segment is refused', async (t) => {
  const calls = mockCore(t, doc);
  assert.match(await refusal(attachFileHandler({ eventId: '..', path: file('report.pdf') })), /is not an event id/);
  assert.match(await refusal(attachFileHandler({ eventId: 'a/b', path: file('report.pdf') })), /is not an event id/);
  assert.equal(calls.length, 0);
});

test('attach_file: production refused without enableWrites, before the file is read', async (t) => {
  const calls = mockCore(t, doc);
  setApiEndpoint('https://tok@core-ch1.api.datasafe.dev/alice/', false);
  assert.match(await refusal(attachFileHandler({ eventId: 'evdoc1', path: file('missing.pdf') })),
    /Writes to the production HDS host are disabled for this session/);
  assert.equal(calls.length, 0);
  clearApiEndpoint();
  assert.match(await refusal(attachFileHandler({ eventId: 'evdoc1', path: file('report.pdf') })), /Not connected/);
});

test('attach_file: an upstream refusal keeps the POST error shape and no path', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: URL | string) => String(url).endsWith('/events/evdoc1')
    ? new Response(JSON.stringify({ error: { id: 'payload-too-large', message: 'Uploaded data exceeds the maximum allowed size' } }), { status: 413 })
    : new Response(JSON.stringify({ results: [{ event: doc }] }), { status: 200 }));
  const msg = await refusal(attachFileHandler({ eventId: 'evdoc1', path: file('report.pdf') }));
  assert.equal(msg, 'Pryv POST /events/evdoc1 failed: Uploaded data exceeds the maximum allowed size');
});

test('attach_file: offered on stdio only, never by the hosted MCP (OAuth or raw mode), and refused inside a request', async () => {
  const has = (s: any) => 'attach_file' in s._registeredTools;
  assert.equal(has(buildServer()), true);
  assert.equal(has(buildServer({ http: true, platform: 'demo' })), false);
  assert.equal(has(buildServer({ http: true, oauth: true, platform: 'production' })), false);
  const msg = await refusal(runWithCredentials({ apiEndpoint: DEMO, serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info', prodWritesEnabled: true },
    () => attachFileHandler({ eventId: 'evdoc1', path: file('report.pdf') })));
  assert.match(msg, /only available on the local \(stdio\) HDS MCP/);
});

test('attach_file through the server: the tool error names the base name only', async () => {
  const server = buildServer();
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: 'attach_file', arguments: { eventId: 'evdoc1', path: file('missing.pdf') } });
    assert.equal(res.isError, true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    assert.match(text, /"missing\.pdf" was not found/);
    assert.ok(!text.includes(dir));
  } finally { await client.close(); }
});
