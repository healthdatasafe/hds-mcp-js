import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import open from 'open';
import { z } from 'zod';
import { loadPack } from '../dataModel/pack.ts';
import { apiBatch, apiPostMultipart } from '../lib/apiCall.ts';
import { assertWriteAllowed } from '../lib/hostPolicy.ts';
import { getApiEndpoint, getProdWritesEnabled, inRequestContext, isConnected } from '../auth/session.ts';
import { KIT_DIR, PackageError, kitDir, loadPackage } from './pkg.ts';
import { buildReport, normalizePackage, type Report } from './inspect.ts';
import { renderReview } from './review.ts';
import { ImportStop, verifyPackage, writePackage, type Counts, type Transport } from './writer.ts';

// The import tools of the local MCP (plan 130, site-agents#36 A4/A5), registered only on stdio with HDS_MCP_IMPORT=true.
// Their answers carry counts, item keys, problem codes and line numbers: no value, name or date of the record, and no
// folder path (it holds the person's home folder name).

type Text = { content: Array<{ type: 'text'; text: string }> };
const text = (...parts: string[]): Text => ({ content: parts.map((t) => ({ type: 'text' as const, text: t })) });
const json = (v: unknown) => '```json\n' + JSON.stringify(v, null, 2) + '\n```';

export const IMPORT_TOOL_NAMES = ['import_inspect', 'import_review', 'import_write', 'import_status', 'import_verify', 'import_cleanup'] as const;

const packagePath = z.string().min(1).describe('The absolute path of the package folder on this computer (manifest.json, events.jsonl, files/).');

export const importInspectInput = { packagePath };
export const importReviewInput = { packagePath, lang: z.string().optional().describe('Language of the page: "en" (default), "fr", …') };
export const importWriteInput = {
  packagePath,
  confirm: z.literal(true).describe('true: the person reviewed the page and said to go ahead. Never set it on your own.')
};
export const importStatusInput = {};
export const importVerifyInput = { packagePath };
export const importCleanupInput = { packagePath };

const transport: Transport = {
  batch: (calls) => apiBatch(calls),
  upload: (eventId, file) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
    return apiPostMultipart(`/events/${eventId}`, form);
  }
};

function stdioOnly (): void {
  if (inRequestContext()) throw new Error('The import tools run only on the local (stdio) HDS MCP: the hosted connector reads no file on your computer.');
}

async function check (packagePathArg: string) {
  stdioOnly();
  let pkg;
  try { pkg = await loadPackage(packagePathArg); } catch (err) {
    if (err instanceof PackageError) throw new Error(`Package refused (${err.code}): ${err.message}`);
    throw err;
  }
  const pack = await loadPack();
  const n = await normalizePackage(pkg, pack);
  const report = buildReport(pkg, pack, n);
  return { pkg, pack, n, report };
}

async function saveReport (root: string, report: Report): Promise<void> {
  const dir = await kitDir(root);
  await fsp.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}

function reportText (report: Report): string {
  const lines = [
    report.ok
      ? `Package checked on ${report.packVersion ? `data-model ${report.packVersion}` : 'the data model'}: ${report.events} event(s), no blocking problem.`
      : `Package checked: ${report.blocking} blocking problem(s); nothing can be written until they are fixed in the package.`,
    `Kinds of data (the roots to pass to connect, with importName "${report.importName ?? '?'}"): ${report.roots.join(', ') || 'none'}.`,
    'The values stay out of this answer: show them to the person with import_review.'
  ];
  return lines.join('\n');
}

export async function importInspectHandler ({ packagePath: p }: { packagePath: string }): Promise<Text> {
  const { pkg, report } = await check(p);
  await saveReport(pkg.root, report);
  return text(reportText(report), json({ ...report, problems: report.problems.slice(0, 50), moreProblems: Math.max(0, report.problems.length - 50) }));
}

export async function importReviewHandler ({ packagePath: p, lang }: { packagePath: string; lang?: string }): Promise<Text> {
  const { pkg, pack, n, report } = await check(p);
  await saveReport(pkg.root, report);
  const dir = await kitDir(pkg.root);
  const file = path.join(dir, 'review.html');
  await fsp.writeFile(file, renderReview(pack, report, n, { lang }), { mode: 0o600 });
  let opened = true;
  await open(pathToFileURL(file).href).catch(() => { opened = false; });
  return text(
    (opened ? 'The review page is open in the person\'s browser' : 'The review page could not be opened automatically') +
      ` (${KIT_DIR}/review.html in the package folder). Ask the person to check it and to tell you whether to go ahead; ` +
      'write only on their explicit go (import_write with confirm: true). ' +
      (report.ok ? '' : `It lists ${report.blocking} blocking problem(s) to fix first. `) +
      'Do not open or read the page yourself: it holds the values.'
  );
}

interface Job { state: 'running' | 'done' | 'stopped' | 'failed'; startedAt: number; endedAt?: number; counts: Counts; errors: Array<{ code: string; line: number }>; stop?: string; events: number }
let job: Job | null = null;

export async function importWriteHandler ({ packagePath: p, confirm }: { packagePath: string; confirm: true }): Promise<Text> {
  if (confirm !== true) throw new Error('import_write needs confirm: true, given only after the person said to go ahead.');
  if (job?.state === 'running') throw new Error('An import is already running: follow it with import_status.');
  if (!isConnected()) throw new Error('Not connected. Call connect with the roots and importName that import_inspect gave, after telling the person what the access covers.');
  assertWriteAllowed(getApiEndpoint(), getProdWritesEnabled());
  const { pkg, pack, n, report } = await check(p);
  if (!report.ok) throw new Error(`The package has ${report.blocking} blocking problem(s): run import_inspect, fix them, and review again. Nothing was written.`);
  // the pack the person reviewed against: a newer one may read the package differently
  const saved = await fsp.readFile(path.join(pkg.root, KIT_DIR, 'report.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (saved?.packVersion !== (pack.version ?? null)) {
    throw new Error('The data model changed since the package was inspected (or it was never inspected): run import_inspect and import_review again before writing. Nothing was written.');
  }
  const current: Job = { state: 'running', startedAt: Date.now(), counts: emptyCounts(), errors: [], events: n.events.length };
  job = current;
  writePackage(pkg, pack, n, transport, (c) => { current.counts = c; })
    .then((r) => { current.counts = r.counts; current.errors = r.errors; current.state = 'done'; })
    .catch((err) => {
      current.state = err instanceof ImportStop ? 'stopped' : 'failed';
      current.stop = err instanceof ImportStop ? `${err.code}: ${err.message}` : 'interrupted (network or server error). Run import_write again: it reads the account first and resumes without duplicates.';
    })
    .finally(() => { current.endedAt = Date.now(); });
  return text(`Import started: ${n.events.length} event(s). Follow it with import_status; when it is done, check it with import_verify.`);
}

function emptyCounts (): Counts {
  return { created: 0, updated: 0, unchanged: 0, trashed: 0, heldElsewhere: 0, filesUploaded: 0, orphans: 0, failed: 0 };
}

export async function importStatusHandler (): Promise<Text> {
  stdioOnly();
  if (!job) return text('No import has run in this session.');
  const secs = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  const head = job.state === 'running'
    ? `Import running for ${secs} s.`
    : job.state === 'done'
      ? `Import done in ${secs} s${job.counts.failed ? `, with ${job.counts.failed} failure(s)` : ''}. Next: import_verify.`
      : `Import ${job.state} after ${secs} s: ${job.stop}`;
  return text(head, json({ state: job.state, events: job.events, counts: job.counts, errors: job.errors.slice(0, 50) }));
}

export async function importVerifyHandler ({ packagePath: p }: { packagePath: string }): Promise<Text> {
  if (job?.state === 'running') throw new Error('An import is still running: wait for import_status to say done.');
  if (!isConnected()) throw new Error('Not connected. Call connect first.');
  const { pkg, n, report } = await check(p);
  if (!report.ok) throw new Error(`The package has ${report.blocking} blocking problem(s): run import_inspect first.`);
  const r = await verifyPackage(pkg, n, transport);
  const clean = r.missing === 0 && r.different === 0 && r.documentsWithoutFile === 0 && r.duplicateKeys === 0;
  return text(
    clean
      ? `Verified: the ${r.checked} event(s) of the package are in the account as written` + (r.trashed ? ` (${r.trashed} left in the trash, as the person removed them)` : '') + '.'
      : `Differences found: ${r.missing} missing, ${r.different} different, ${r.documentsWithoutFile} document(s) without their file, ${r.duplicateKeys} duplicate key(s). Running import_write again fixes missing, different and file-less ones.`,
    json({ ...r, differences: r.differences.slice(0, 50) })
  );
}

export async function importCleanupHandler ({ packagePath: p }: { packagePath: string }): Promise<Text> {
  stdioOnly();
  if (job?.state === 'running') throw new Error('An import is still running.');
  const { root } = await loadPackage(p).catch((err) => {
    throw new Error(err instanceof PackageError ? `Package refused (${err.code}): ${err.message}` : 'Package refused.');
  });
  const dir = path.join(root, KIT_DIR);
  const st = await fsp.lstat(dir).catch(() => null);
  if (st == null) return text(`Nothing to clean: no ${KIT_DIR} folder in the package.`);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${KIT_DIR} in the package is not a folder; nothing was deleted.`);
  await fsp.rm(dir, { recursive: true });
  return text(`Deleted the review page and reports (${KIT_DIR}). The package itself is a copy of the person's records on this computer: tell them they can delete the package folder when they no longer need it.`);
}

export const IMPORT_TOOL_DESCRIPTIONS: Record<(typeof IMPORT_TOOL_NAMES)[number], string> = {
  import_inspect: 'Check an import package on this computer (local MCP only): manifest.json + events.jsonl (one event per line: sourceKey, itemKey or streamIds+type, content, time, optional duration, description, clientData, relatedKeys, attachment "files/…", evidence {file, page}) + files/. Use { "$ref": "<sourceKey>" } wherever an event id of the same package is expected. Every event is checked against the HDS data model; returns counts, the roots to pass to connect, and problems with line numbers. Never returns values: show them with import_review. Run it again after every change to the package.',
  import_review: 'Write the review page of an import package and open it in the person\'s browser (local MCP only): a summary per kind of data, then every value next to its source page. The person checks it there. Then ask whether to go ahead. Do not read the page yourself.',
  import_write: 'Write an inspected and reviewed package to the connected HDS account (local MCP only), only after the person said to go ahead: confirm: true. Connect first with the roots and importName import_inspect gave. Starts in the background and returns at once; follow it with import_status. Re-running it is safe: it reads the account first, creates what is missing, updates what changed, leaves what the person put in the trash, and uploads documents\' files. Refuses on production until the production-write gate is opened.',
  import_status: 'Progress of the import started by import_write: counts of created, updated, unchanged, trashed and failed events, uploaded files.',
  import_verify: 'Read an import back from the connected account and compare it with the package: counts of missing, different and file-less events (line numbers, no values).',
  import_cleanup: 'Delete the review page and reports the import tools wrote in the package folder (.hds-import/). Offer it once the person is done reviewing and the import is verified.'
};
