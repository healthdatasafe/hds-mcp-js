import { constants, promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { apiBatch, apiPostMultipart } from '../lib/apiCall.ts';
import { assertWriteAllowed } from '../lib/hostPolicy.ts';
import { getApiEndpoint, getProdWritesEnabled, inRequestContext } from '../auth/session.ts';

// The one filesystem read of hds-mcp (perki 2026-11-17, site-agents#36): one file the user named, stdio MCP only.

/** Under the core's 50 MB upload limit (uploads.maxSizeMb) and demo nginx's 55m client-max-body-size. */
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_EVENT_TYPE = 'file/xds-v1';

export interface FileFormat { label: string; mime: string; ext: string[]; magic: number[] }
export const FORMATS: FileFormat[] = [
  { label: 'PDF', mime: 'application/pdf', ext: ['.pdf'], magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { label: 'JPEG', mime: 'image/jpeg', ext: ['.jpg', '.jpeg'], magic: [0xff, 0xd8, 0xff] },
  { label: 'PNG', mime: 'image/png', ext: ['.png'], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }
];

// A Pryv id is one path segment: no "/", ".", "?" or "#" that could move the upload to another URL.
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

export const attachFileInput = {
  eventId: z.string().min(1).describe(
    'The id of the file/xds-v1 document event to attach the file to (returned by create_event), with no attachment yet.'
  ),
  path: z.string().min(1).describe(
    'The absolute path of the file on this computer, as the user gave it. Only its base name is sent to HDS.'
  )
};

export interface LocalFile { name: string; mime: string; data: Buffer }

const refused = (what: string) => new Error(`File refused, nothing written: ${what}`);

// Never the error's own message: it holds the full path.
function fsError (name: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return refused(`"${name}" was not found.`);
  if (code === 'EACCES' || code === 'EPERM') return refused(`"${name}" cannot be read (permission denied).`);
  if (code === 'ELOOP') return refused(`"${name}" is a symbolic link; give the path of the file itself.`);
  return refused(`"${name}" cannot be read${code ? ` (${code})` : ''}.`);
}

function notRegular (name: string, st: Stats): Error | null {
  if (st.isSymbolicLink()) return refused(`"${name}" is a symbolic link; give the path of the file itself.`);
  if (st.isDirectory()) return refused(`"${name}" is a folder, not a file.`);
  if (!st.isFile()) return refused(`"${name}" is not a regular file.`);
  return null;
}

const tooBig = (name: string) => refused(`"${name}" is larger than ${ATTACH_MAX_BYTES / (1024 * 1024)} MB.`);

/**
 * Reads one local file, once, into memory: an absolute path to a regular file (not a symlink, folder or device), at
 * most ATTACH_MAX_BYTES, a PDF, JPEG or PNG by its first bytes, with an extension that agrees. Errors name the base
 * name only.
 */
export async function readLocalFile (filePath: string): Promise<LocalFile> {
  if (!path.isAbsolute(filePath)) throw refused('give the absolute path of the file (a relative path is not accepted).');
  const name = path.basename(filePath);
  let st: Stats;
  try { st = await fsp.lstat(filePath); } catch (err) { throw fsError(name, err); }
  const bad = notRegular(name, st);
  if (bad) throw bad;
  if (st.size > ATTACH_MAX_BYTES) throw tooBig(name);

  let data: Buffer;
  let fh: fsp.FileHandle;
  // O_NOFOLLOW: a symlink swapped in after lstat is not followed.
  try { fh = await fsp.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch (err) { throw fsError(name, err); }
  try {
    const fst = await fh.stat();
    if (fst.dev !== st.dev || fst.ino !== st.ino) throw refused(`"${name}" changed while it was read.`);
    const badNow = notRegular(name, fst);
    if (badNow) throw badNow;
    const buf = Buffer.alloc(Math.min(fst.size, ATTACH_MAX_BYTES) + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > ATTACH_MAX_BYTES) throw tooBig(name);
    data = buf.subarray(0, n);
  } catch (err) {
    throw (err instanceof Error && err.message.startsWith('File refused')) ? err : fsError(name, err);
  } finally {
    await fh.close().catch(() => {});
  }

  const format = FORMATS.find((f) => data.length >= f.magic.length && f.magic.every((b, i) => data[i] === b));
  if (!format) throw refused(`"${name}" is not a PDF, JPEG or PNG file (checked from its content, not its name).`);
  const ext = path.extname(name).toLowerCase();
  if (!format.ext.includes(ext)) {
    throw refused(`"${name}" holds a ${format.label} file but its extension is ${ext ? `"${ext}"` : 'missing'}; the extension must agree with the content (${format.ext.join(' or ')}).`);
  }
  return { name, mime: format.mime, data };
}

export async function attachFileHandler (
  { eventId, path: filePath }: { eventId: string; path: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // Not registered over HTTP; refused there all the same: a hosted server never reads its own disk for a caller.
  if (inRequestContext()) throw new Error('attach_file is only available on the local (stdio) HDS MCP: the hosted connector reads no file on your computer.');
  assertWriteAllowed(getApiEndpoint(), getProdWritesEnabled());
  if (!EVENT_ID_RE.test(eventId)) throw new Error(`Attachment refused, nothing written: "${eventId}" is not an event id.`);

  const file = await readLocalFile(filePath);

  const [cur] = await apiBatch([{ method: 'events.getOne', params: { id: eventId } }]);
  if (cur?.error) throw new Error(`Pryv events.getOne failed: ${cur.error.message ?? cur.error.id}`);
  const event = cur?.event;
  if (!event) throw new Error('Pryv events.getOne failed: no event in the answer');
  if (event.trashed === true) throw new Error(`Attachment refused, nothing written: event ${eventId} is in the trash (the person removed it).`);
  if (event.type !== DOCUMENT_EVENT_TYPE) {
    throw new Error(`Attachment refused, nothing written: event ${eventId} is of type "${event.type}"; attach_file only adds the file of a ${DOCUMENT_EVENT_TYPE} document event.`);
  }
  if (Array.isArray(event.attachments) && event.attachments.length > 0) {
    throw new Error(`Attachment refused, nothing written: event ${eventId} already has an attachment. A document keeps its file; a new version is a new event listing this one in supersedes.`);
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
  const res = await apiPostMultipart(`/events/${eventId}`, form);
  const updated = (res as any).event ?? res;
  const attachments: any[] = Array.isArray(updated?.attachments) ? updated.attachments : [];
  const att = attachments.filter((a) => a?.fileName === file.name).pop() ?? attachments[attachments.length - 1];
  // Never the attachment's readToken: a credential to the file.
  const summary = { eventId, attachment: { id: att?.id ?? null, fileName: file.name, size: file.data.length, type: file.mime } };
  return {
    content: [{
      type: 'text',
      text: `Attached "${file.name}" (${file.data.length} bytes, ${file.mime}) to document event ${eventId} as attachment ${att?.id ?? '(no id)'}. ` +
        'Re-read the event with get_events (stream documents, type file/xds-v1) to check the file is there.'
    }, {
      type: 'text',
      text: '```json\n' + JSON.stringify(summary, null, 2) + '\n```'
    }]
  };
}
