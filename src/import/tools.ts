import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import open from 'open';
import { z } from 'zod';
import { loadPack, type DataModelPack } from '../dataModel/pack.ts';
import { apiBatch, apiPostMultipart } from '../lib/apiCall.ts';
import { UpstreamError } from '../lib/fetchPolicy.ts';
import { assertWriteAllowed } from '../lib/hostPolicy.ts';
import { getApiEndpoint, getProdWritesEnabled, inRequestContext, isConnected } from '../auth/session.ts';
import { KIT_DIR, PackageError, kitDir, loadPackage, readKitFile, writeKitFile } from './pkg.ts';
import { buildReport, normalizePackage, type Report } from './inspect.ts';
import { renderReview } from './review.ts';
import { ImportStop, verifyPackage, writePackage, type Counts, type Transport, type WriteError } from './writer.ts';

// The import tools of the local MCP (plan 130, site-agents#36 A4/A5), registered only on stdio with HDS_MCP_IMPORT=true.
// Their answers carry counts, item keys, problem codes and line numbers: no value, name or date of the record, and no
// folder path (it holds the person's home folder name). Every error goes through `safeError`.

type Text = { content: Array<{ type: 'text'; text: string }> };
const text = (...parts: string[]): Text => ({ content: parts.map((t) => ({ type: 'text' as const, text: t })) });
const json = (v: unknown) => '```json\n' + JSON.stringify(v, null, 2) + '\n```';

/** A refusal written by the kit itself: fixed text, safe to show. */
class KitError extends Error {}

/**
 * The error a tool returns: the kit's own messages as they are; a core error as its id and status; a file-system
 * error as its code only (Node's message holds the full path); anything else as its kind.
 */
export function safeError (err: unknown): Error {
  if (err instanceof KitError || err instanceof ImportStop) return err;
  if (err instanceof PackageError) return new Error(`Package refused (${err.code}): ${err.message}`);
  if (err instanceof UpstreamError) return new Error(`HDS refused the request (${err.errorId ?? 'error'}, HTTP ${err.status ?? '?'}).`);
  const code = (err as NodeJS.ErrnoException)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return new Error(`File error (${code}) in the package folder.`);
  return new Error(`Unexpected error (${err instanceof Error ? err.name : typeof err}).`);
}

function guarded<A> (fn: (a: A) => Promise<Text>): (a: A) => Promise<Text> {
  return async (a: A) => {
    try { return await fn(a); } catch (err) { throw safeError(err); }
  };
}

export const IMPORT_TOOL_NAMES = ['import_inspect', 'import_review', 'import_write', 'import_status', 'import_verify', 'import_cleanup'] as const;

const packagePath = z.string().min(1).max(4096).describe('The absolute path of the package folder on this computer (manifest.json, events.jsonl, files/).');

export const importInspectInput = { packagePath };
export const importReviewInput = { packagePath, lang: z.string().max(10).optional().describe('Language of the page: "en" (default), "fr", …') };
export const importWriteInput = {
  packagePath,
  confirm: z.literal(true).describe('true: the person reviewed the page and said to go ahead. Never set it on your own.')
};
export const importStatusInput = {};
export const importVerifyInput = { packagePath };
export const importCleanupInput = { packagePath };

/** The session's transport, bound to the account the job started on: a connect in the meantime stops the job. */
function boundTransport (): Transport {
  const endpoint = getApiEndpoint();
  const same = () => {
    if (getApiEndpoint() !== endpoint) throw new ImportStop('session-changed', 'The connection changed while the import ran (another connect); it stopped. Run import_write again on the account it is for.');
  };
  return {
    batch: async (calls) => { same(); return apiBatch(calls); },
    upload: async (eventId, file) => {
      same();
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
      return apiPostMultipart(`/events/${eventId}`, form);
    }
  };
}

const testing: { pack: DataModelPack | null; transport: Transport | null; open: ((url: string) => Promise<unknown>) | null } = { pack: null, transport: null, open: null };
/** Tests only: a fixture pack, a fake core, no browser. */
export function setImportTestHooks (hooks: Partial<typeof testing>): void { Object.assign(testing, hooks); }

function stdioOnly (): void {
  if (inRequestContext()) throw new KitError('The import tools run only on the local (stdio) HDS MCP: the hosted connector reads no file on your computer.');
}

async function check (packagePathArg: string) {
  stdioOnly();
  const pkg = await loadPackage(packagePathArg);
  const pack = testing.pack ?? await loadPack();
  const n = await normalizePackage(pkg, pack);
  const report = buildReport(pkg, pack, n);
  return { pkg, pack, n, report };
}

function reportText (report: Report): string {
  return [
    report.ok
      ? `Package checked on ${report.packVersion ? `data-model ${report.packVersion}` : 'the data model'}: ${report.events} event(s), no blocking problem.`
      : `Package checked: ${report.blocking} blocking problem(s)${report.blocking === 0 ? ' in the manifest' : ''}; nothing can be written until they are fixed in the package.`,
    `Kinds of data (the roots to pass to connect, with importName "${report.importName ?? '?'}"): ${report.roots.join(', ') || 'none'}.`,
    'The values stay out of this answer: show them to the person with import_review.'
  ].join('\n');
}

export const importInspectHandler = guarded(async ({ packagePath: p }: { packagePath: string }): Promise<Text> => {
  const { pkg, report } = await check(p);
  // only a package with a valid manifest gets the kit's folder: never in an arbitrary folder
  if (pkg.valid) await writeKitFile(pkg.root, 'report.json', JSON.stringify(report, null, 2) + '\n');
  return text(reportText(report), json({ ...report, problems: report.problems.slice(0, 50), moreProblems: Math.max(0, report.problems.length - 50) }));
});

export const importReviewHandler = guarded(async ({ packagePath: p, lang }: { packagePath: string; lang?: string }): Promise<Text> => {
  const { pkg, pack, n, report } = await check(p);
  if (!pkg.valid) throw new KitError('The package manifest is not valid: run import_inspect and fix it first.');
  await writeKitFile(pkg.root, 'report.json', JSON.stringify(report, null, 2) + '\n');
  await writeKitFile(pkg.root, 'review.html', renderReview(pack, report, n, { lang }));
  // what the person reviewed: import_write writes only this exact package, on this data model
  await writeKitFile(pkg.root, 'reviewed.json', JSON.stringify({ digest: pkg.digest, packVersion: pack.version ?? null, ok: report.ok }) + '\n');
  let opened = true;
  const file = path.join(await kitDir(pkg.root), 'review.html');
  await (testing.open ?? open)(pathToFileURL(file).href).catch(() => { opened = false; });
  return text(
    (opened ? 'The review page is open in the person\'s browser' : 'The review page could not be opened automatically; it is') +
      ` ${KIT_DIR}/review.html in the package folder. Ask the person to check it and to tell you whether to go ahead; ` +
      'write only on their explicit go (import_write with confirm: true). ' +
      (report.ok ? '' : `It lists ${report.blocking} blocking problem(s) to fix first. `) +
      'Do not open or read the page yourself: it holds the values.'
  );
});

interface Job { state: 'starting' | 'running' | 'done' | 'stopped' | 'failed'; startedAt: number; endedAt?: number; counts: Counts; errors: WriteError[]; stop?: string; events: number }
let job: Job | null = null;
const busy = () => job?.state === 'starting' || job?.state === 'running';

function emptyCounts (): Counts {
  return { created: 0, updated: 0, unchanged: 0, trashed: 0, heldElsewhere: 0, filesUploaded: 0, orphans: 0, failed: 0 };
}

export const importWriteHandler = guarded(async ({ packagePath: p, confirm }: { packagePath: string; confirm: true }): Promise<Text> => {
  if (confirm !== true) throw new KitError('import_write needs confirm: true, given only after the person said to go ahead.');
  stdioOnly();
  // claimed before the first await: two calls at once never start two writers
  if (busy()) throw new KitError('An import is already running: follow it with import_status.');
  const previous = job;
  const current: Job = { state: 'starting', startedAt: Date.now(), counts: emptyCounts(), errors: [], events: 0 };
  job = current;
  try {
    if (!isConnected()) throw new KitError('Not connected. Call connect with the roots and importName that import_inspect gave, after telling the person what the access covers.');
    assertWriteAllowed(getApiEndpoint(), getProdWritesEnabled());
    const transport = testing.transport ?? boundTransport();
    const { pkg, pack, n, report } = await check(p);
    if (!report.ok) throw new KitError(`The package has ${report.blocking} blocking problem(s): run import_inspect, fix them, and review again. Nothing was written.`);
    const reviewed = await readKitFile(pkg.root, 'reviewed.json').then((s) => s ? JSON.parse(s) : null).catch(() => null);
    if (reviewed?.digest !== pkg.digest) {
      throw new KitError('The package was not reviewed as it is now (or never): run import_review and let the person check it again. Nothing was written.');
    }
    if (reviewed?.packVersion !== (pack.version ?? null)) {
      throw new KitError('The data model changed since the review: run import_review again before writing. Nothing was written.');
    }
    current.state = 'running';
    current.events = n.events.length;
    writePackage(pkg, pack, n, transport, (c, errors) => { current.counts = c; current.errors = errors; })
      .then((r) => { current.counts = r.counts; current.errors = r.errors; current.state = 'done'; })
      .catch((err) => {
        current.state = err instanceof ImportStop ? 'stopped' : 'failed';
        if (err instanceof ImportStop && err.errors.length > 0) current.errors = err.errors;
        current.stop = err instanceof ImportStop
          ? `${err.code}: ${err.message}`
          : `interrupted (${safeError(err).message}). Run import_write again: it reads the account first and resumes without duplicates.`;
      })
      .finally(() => { current.endedAt = Date.now(); });
    return text(`Import started: ${n.events.length} event(s). Follow it with import_status; when it is done, check it with import_verify.`);
  } catch (err) {
    job = previous;
    throw err;
  }
});

export const importStatusHandler = guarded(async (): Promise<Text> => {
  stdioOnly();
  if (!job || job.state === 'starting') return text(job ? 'The import is starting.' : 'No import has run in this session.');
  const secs = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  const head = job.state === 'running'
    ? `Import running for ${secs} s.`
    : job.state === 'done'
      ? `Import done in ${secs} s${job.counts.failed ? `, with ${job.counts.failed} failure(s)` : ''}. Next: import_verify.`
      : `Import ${job.state} after ${secs} s: ${job.stop}`;
  return text(head, json({ state: job.state, events: job.events, counts: job.counts, errors: job.errors.slice(0, 50), moreErrors: Math.max(0, job.errors.length - 50) }));
});

export const importVerifyHandler = guarded(async ({ packagePath: p }: { packagePath: string }): Promise<Text> => {
  stdioOnly();
  if (busy()) throw new KitError('An import is still running: wait for import_status to say done.');
  if (!isConnected()) throw new KitError('Not connected. Call connect first.');
  const transport = testing.transport ?? boundTransport();
  const { pkg, n, report } = await check(p);
  if (!report.ok) throw new KitError(`The package has ${report.blocking} blocking problem(s): run import_inspect first.`);
  const r = await verifyPackage(pkg, n, transport);
  const clean = r.missing === 0 && r.different === 0 && r.documentsWithoutFile === 0 && r.documentsFileChanged === 0 && r.duplicateKeys === 0;
  return text(
    clean
      ? `Verified: the ${r.checked} event(s) of the package are in the account as written` +
        (r.trashed ? ` (${r.trashed} left in the trash, as the person removed them)` : '') +
        (r.heldElsewhere ? ` (${r.heldElsewhere} document(s) already held, linked)` : '') + '.'
      : `Differences found: ${r.missing} missing, ${r.different} different, ${r.documentsWithoutFile} document(s) without their file, ` +
        `${r.documentsFileChanged} document(s) whose file changed, ${r.duplicateKeys} duplicate key(s). Running import_write again fixes ` +
        'missing, different and file-less ones; a changed file is a new document version (a new event with supersedes).',
    json({ ...r, differences: r.differences.slice(0, 50) })
  );
});

export const importCleanupHandler = guarded(async ({ packagePath: p }: { packagePath: string }): Promise<Text> => {
  stdioOnly();
  if (busy()) throw new KitError('An import is still running.');
  const pkg = await loadPackage(p);
  if (!pkg.valid) throw new KitError('This folder is not an import package (no valid manifest.json): nothing was deleted.');
  const dir = path.join(pkg.root, KIT_DIR);
  const st = await fsp.lstat(dir).catch(() => null);
  if (st == null) return text(`Nothing to clean: no ${KIT_DIR} folder in the package.`);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new KitError(`${KIT_DIR} in the package is not a plain folder; nothing was deleted.`);
  await fsp.rm(dir, { recursive: true });
  return text(`Deleted the review page and reports (${KIT_DIR}). The package itself is a copy of the person's records on this computer: tell them they can delete the package folder when they no longer need it.`);
});

export const IMPORT_TOOL_DESCRIPTIONS: Record<(typeof IMPORT_TOOL_NAMES)[number], string> = {
  import_inspect: 'Check an import package on this computer (local MCP only): manifest.json + events.jsonl (one event per line: sourceKey, itemKey or streamIds+type, content, time, optional duration, description, clientData, relatedKeys, attachment "files/…", evidence {file, page}) + files/. Use { "$ref": "<sourceKey>" } wherever an event id of the same package is expected. Every event is checked against the HDS data model; returns counts, the roots to pass to connect, and problems with line numbers. Never returns values: show them with import_review. Run it again after every change to the package.',
  import_review: 'Write the review page of an import package and open it in the person\'s browser (local MCP only): a summary per kind of data, then every value next to its source page. The person checks it there. Then ask whether to go ahead. Do not read the page yourself. import_write writes only the package as reviewed: after any change, review again.',
  import_write: 'Write a reviewed package to the connected HDS account (local MCP only), only after the person said to go ahead: confirm: true. Connect first with the roots and importName import_inspect gave. Starts in the background and returns at once; follow it with import_status. Re-running it is safe: it reads the account first, creates what is missing, updates what changed, leaves what the person put in the trash, and uploads documents\' files. Refuses on production until the production-write gate is opened.',
  import_status: 'Progress of the import started by import_write: counts of created, updated, unchanged, trashed and failed events, uploaded files, and the errors by line number.',
  import_verify: 'Read an import back from the connected account and compare it with the package: counts of missing, different and file-less events (line numbers, no values).',
  import_cleanup: 'Delete the review page and reports the import tools wrote in the package folder (.hds-import/). Offer it once the person is done reviewing and the import is verified.'
};
