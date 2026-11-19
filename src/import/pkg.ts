import { promises as fsp, constants, type Stats } from 'node:fs';
import path from 'node:path';

// The local import kit (plan 130, site-agents#36 A4/A5): a package on the person's disk, written by the agent, read
// here. Stdio MCP only, behind HDS_MCP_IMPORT=true. Every message names a line number, a code or a base name, never a
// folder path (it holds the person's home folder name) and never a value.

export const PACKAGE_FORMAT = 'hds-import-package/1';
export const KIT_DIR = '.hds-import';
const MANIFEST_MAX_BYTES = 1024 * 1024;
const EVENTS_MAX_BYTES = 256 * 1024 * 1024;

/** sourceKey prefixes other writers own: an import using one would update their events (PROVENANCE.md). */
const RESERVED_TOOLS = new Set(['femm', 'cyclefem', 'medication', 'photo', 'custom-line', 'hds', 'hds-mcp']);
const TOOL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface Manifest {
  format: string;
  importName: string;
  tool: string;
  [k: string]: unknown;
}

export interface RawLine { line: number; value: any }

export interface Problem {
  code: string;
  /** 1-based line of events.jsonl, when the problem is about one event */
  line?: number;
  /** structural detail only: a field path, an item key, a type, a code; never a value */
  detail?: string;
  /** false: reported, does not stop the import */
  blocking: boolean;
}

export interface LoadedPackage {
  root: string;
  manifest: Manifest | null;
  lines: RawLine[];
  problems: Problem[];
}

export class PackageError extends Error {
  code: string;
  constructor (code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Reads manifest.json and events.jsonl of the package folder at `dir` (an absolute path, not a symbolic link). */
export async function loadPackage (dir: string): Promise<LoadedPackage> {
  if (!path.isAbsolute(dir)) throw new PackageError('package-path-relative', 'Give the absolute path of the package folder.');
  let st: Stats;
  try { st = await fsp.lstat(dir); } catch { throw new PackageError('package-not-found', 'The package folder was not found.'); }
  if (st.isSymbolicLink()) throw new PackageError('package-symlink', 'The package folder is a symbolic link; give the folder itself.');
  if (!st.isDirectory()) throw new PackageError('package-not-folder', 'The package path is not a folder.');
  const root = await fsp.realpath(dir);
  const problems: Problem[] = [];

  let manifest: Manifest | null = null;
  const manifestText = await readInside(root, 'manifest.json', MANIFEST_MAX_BYTES).catch((e) => { problems.push(fileProblem(e, 'manifest.json')); return null; });
  if (manifestText != null) {
    try {
      manifest = JSON.parse(manifestText.toString('utf8'));
    } catch {
      problems.push({ code: 'manifest-not-json', blocking: true });
    }
  }
  if (manifest != null) checkManifest(manifest, problems);

  const lines: RawLine[] = [];
  const eventsText = await readInside(root, 'events.jsonl', EVENTS_MAX_BYTES).catch((e) => { problems.push(fileProblem(e, 'events.jsonl')); return null; });
  if (eventsText != null) {
    const text = eventsText.toString('utf8');
    text.split('\n').forEach((l, i) => {
      if (l.trim() === '') return;
      try {
        lines.push({ line: i + 1, value: JSON.parse(l) });
      } catch {
        problems.push({ code: 'line-not-json', line: i + 1, blocking: true });
      }
    });
    if (lines.length === 0 && problems.length === 0) problems.push({ code: 'package-empty', blocking: true });
  }
  return { root, manifest, lines, problems };
}

function checkManifest (m: any, problems: Problem[]): void {
  if (m == null || typeof m !== 'object' || Array.isArray(m)) {
    problems.push({ code: 'manifest-not-object', blocking: true });
    return;
  }
  if (m.format !== PACKAGE_FORMAT) problems.push({ code: 'manifest-format', detail: `expected "${PACKAGE_FORMAT}"`, blocking: true });
  if (typeof m.importName !== 'string' || !TOOL_RE.test(m.importName)) {
    problems.push({ code: 'manifest-import-name', detail: 'lowercase letters, digits and "-", 1-40 characters', blocking: true });
  }
  if (typeof m.tool !== 'string' || !TOOL_RE.test(m.tool)) {
    problems.push({ code: 'manifest-tool', detail: 'lowercase letters, digits and "-", 1-40 characters (the sourceKey prefix)', blocking: true });
  } else if (RESERVED_TOOLS.has(m.tool) || m.tool.startsWith('bridge-')) {
    problems.push({ code: 'manifest-tool-reserved', detail: `"${m.tool}" is another writer's sourceKey prefix`, blocking: true });
  }
}

function fileProblem (err: unknown, rel: string): Problem {
  return { code: err instanceof PackageError ? err.code : 'file-unreadable', detail: rel, blocking: true };
}

/**
 * The absolute path of `rel` inside the package, refused when it leaves the folder, goes through a symbolic link or
 * is not a regular file.
 */
export async function resolveInside (root: string, rel: unknown): Promise<string> {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new PackageError('file-path-outside', 'A file path must be relative to the package folder, without "..".');
  }
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new PackageError('file-path-outside', 'A file path must stay inside the package folder.');
  let st: Stats;
  try { st = await fsp.lstat(full); } catch { throw new PackageError('file-missing', 'A file named in the package is missing.'); }
  if (st.isSymbolicLink()) throw new PackageError('file-symlink', 'A file named in the package is a symbolic link.');
  if (!st.isFile()) throw new PackageError('file-not-regular', 'A file named in the package is not a regular file.');
  // A symbolic link in a parent folder: the real path moved.
  if (await fsp.realpath(full) !== full) throw new PackageError('file-symlink', 'A file named in the package is reached through a symbolic link.');
  return full;
}

/** Reads a whole file inside the package, at most `max` bytes, never following a symbolic link. */
export async function readInside (root: string, rel: string, max: number): Promise<Buffer> {
  const full = await resolveInside(root, rel);
  const fh = await fsp.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = await fh.stat();
    if (st.size > max) throw new PackageError('file-too-large', `${path.basename(full)} is larger than ${Math.round(max / (1024 * 1024))} MB.`);
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return buf.subarray(0, n);
  } finally {
    await fh.close().catch(() => {});
  }
}

/** The kit's own folder inside the package (created), refused when something else sits there. */
export async function kitDir (root: string): Promise<string> {
  const dir = path.join(root, KIT_DIR);
  try {
    const st = await fsp.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new PackageError('kit-dir-invalid', `${KIT_DIR} in the package is not a folder.`);
  } catch (err) {
    if (err instanceof PackageError) throw err;
    await fsp.mkdir(dir, { mode: 0o700 });
  }
  return dir;
}
