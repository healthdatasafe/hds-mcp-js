import { promises as fsp, constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// The local import kit (plan 130, site-agents#36 A4/A5): a package on the person's disk, written by the agent, read
// here. Stdio MCP only, behind HDS_MCP_IMPORT=true. Every message names a line number, a code or a base name, never a
// folder path (it holds the person's home folder name) and never a value. A package may come from anywhere (a
// download), so nothing in it is trusted: no symbolic link is followed, for reading or for writing.

export const PACKAGE_FORMAT = 'hds-import-package/1';
export const KIT_DIR = '.hds-import';
const MANIFEST_MAX_BYTES = 1024 * 1024;
export const EVENTS_MAX_BYTES = 32 * 1024 * 1024;
export const EVENTS_MAX_LINES = 100_000;
const KIT_FILE_MAX_BYTES = 8 * 1024 * 1024;

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
  /** structural detail only, filtered by `safeDetail`: never a value */
  detail?: string;
  /** false: reported, does not stop the import */
  blocking: boolean;
}

export interface LoadedPackage {
  root: string;
  manifest: Manifest | null;
  /** the manifest is a valid `hds-import-package/1` one: only then does the kit write in the folder */
  valid: boolean;
  lines: RawLine[];
  problems: Problem[];
  /** sha256 of manifest.json + events.jsonl: what the person reviewed must be what is written */
  digest: string;
}

/** A refusal whose message is safe to show: a code and fixed text, no path, no value. */
export class PackageError extends Error {
  code: string;
  constructor (code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Text from the package shown back only when it is a plain identifier (an item key, a type, a field path). */
export function safeDetail (s: unknown): string | undefined {
  return typeof s === 'string' && /^[a-zA-Z0-9:._/-]{1,80}$/.test(s) ? s : undefined;
}

/** Reads manifest.json and events.jsonl of the package folder at `dir` (an absolute path, not a symbolic link). */
export async function loadPackage (dir: string): Promise<LoadedPackage> {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new PackageError('package-path-relative', 'Give the absolute path of the package folder.');
  let st: Stats;
  try { st = await fsp.lstat(dir); } catch { throw new PackageError('package-not-found', 'The package folder was not found.'); }
  if (st.isSymbolicLink()) throw new PackageError('package-symlink', 'The package folder is a symbolic link; give the folder itself.');
  if (!st.isDirectory()) throw new PackageError('package-not-folder', 'The package path is not a folder.');
  let root: string;
  try { root = await fsp.realpath(dir); } catch { throw new PackageError('package-unreadable', 'The package folder cannot be read.'); }
  const problems: Problem[] = [];
  const hash = createHash('sha256');

  let manifest: Manifest | null = null;
  const manifestBuf = await readInside(root, 'manifest.json', MANIFEST_MAX_BYTES).catch((e) => { problems.push(fileProblem(e, 'manifest.json')); return null; });
  if (manifestBuf != null) {
    hash.update(manifestBuf);
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestBuf.toString('utf8'));
    } catch {
      problems.push({ code: 'manifest-not-json', blocking: true });
    }
    if (parsed !== undefined) {
      if (checkManifest(parsed, problems)) manifest = parsed as Manifest;
    }
  }
  hash.update('\n--\n');

  const lines: RawLine[] = [];
  const eventsBuf = await readInside(root, 'events.jsonl', EVENTS_MAX_BYTES).catch((e) => { problems.push(fileProblem(e, 'events.jsonl')); return null; });
  if (eventsBuf != null) {
    hash.update(eventsBuf);
    const all = eventsBuf.toString('utf8').split('\n');
    if (all.length > EVENTS_MAX_LINES + 1) {
      problems.push({ code: 'package-too-many-lines', detail: `at most ${EVENTS_MAX_LINES}`, blocking: true });
    } else {
      all.forEach((l, i) => {
        if (l.trim() === '') return;
        try {
          lines.push({ line: i + 1, value: JSON.parse(l) });
        } catch {
          problems.push({ code: 'line-not-json', line: i + 1, blocking: true });
        }
      });
      if (lines.length === 0 && problems.length === 0) problems.push({ code: 'package-empty', blocking: true });
    }
  }
  return { root, manifest, valid: manifest != null, lines, problems, digest: hash.digest('hex') };
}

/** True when the manifest can be used; its problems otherwise. */
function checkManifest (m: any, problems: Problem[]): boolean {
  if (m == null || typeof m !== 'object' || Array.isArray(m)) {
    problems.push({ code: 'manifest-not-object', blocking: true });
    return false;
  }
  let ok = true;
  if (m.format !== PACKAGE_FORMAT) { problems.push({ code: 'manifest-format', detail: PACKAGE_FORMAT, blocking: true }); ok = false; }
  if (typeof m.importName !== 'string' || !TOOL_RE.test(m.importName)) {
    problems.push({ code: 'manifest-import-name', detail: 'a-z0-9-, 1-40 characters', blocking: true });
    ok = false;
  }
  if (typeof m.tool !== 'string' || !TOOL_RE.test(m.tool)) {
    problems.push({ code: 'manifest-tool', detail: 'a-z0-9-, 1-40 characters', blocking: true });
    ok = false;
  } else if (RESERVED_TOOLS.has(m.tool) || m.tool.startsWith('bridge-')) {
    problems.push({ code: 'manifest-tool-reserved', detail: m.tool, blocking: true });
    ok = false;
  }
  return ok;
}

function fileProblem (err: unknown, rel: string): Problem {
  return { code: err instanceof PackageError ? err.code : 'file-unreadable', detail: rel, blocking: true };
}

/**
 * The absolute path of `rel` inside the package: refused when it leaves the folder, when any part of the path is a
 * symbolic link, or when it is not a regular file. Containment is checked per path component (`lstat` each), not by
 * comparing `realpath` strings, which differ on macOS for a name in another Unicode form.
 */
export async function resolveInside (root: string, rel: unknown): Promise<string> {
  if (typeof rel !== 'string' || rel === '' || rel.length > 512 || path.isAbsolute(rel) || rel.includes('\0')) {
    throw new PackageError('file-path-outside', 'A file path must be relative to the package folder.');
  }
  const parts = rel.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) throw new PackageError('file-path-outside', 'A file path must stay inside the package folder, without "..".');
  const full = path.join(root, ...parts);
  if (path.relative(root, full).startsWith('..')) throw new PackageError('file-path-outside', 'A file path must stay inside the package folder.');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st: Stats;
    try { st = await fsp.lstat(cur); } catch { throw new PackageError('file-missing', 'A file named in the package is missing.'); }
    if (st.isSymbolicLink()) throw new PackageError('file-symlink', 'A file named in the package is, or is reached through, a symbolic link.');
    if (i < parts.length - 1 && !st.isDirectory()) throw new PackageError('file-missing', 'A file named in the package is missing.');
    if (i === parts.length - 1 && !st.isFile()) throw new PackageError('file-not-regular', 'A file named in the package is not a regular file.');
  }
  return full;
}

/** Opens a regular file inside the package for reading, the same file `resolveInside` checked (dev/ino). */
export async function openInside (root: string, rel: unknown): Promise<{ fh: fsp.FileHandle; size: number; full: string }> {
  const full = await resolveInside(root, rel);
  const before = await fsp.lstat(full);
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw new PackageError('file-unreadable', 'A file named in the package cannot be read.');
  }
  const st = await fh.stat();
  if (st.dev !== before.dev || st.ino !== before.ino || !st.isFile()) {
    await fh.close().catch(() => {});
    throw new PackageError('file-changed', 'A file named in the package changed while it was read.');
  }
  return { fh, size: st.size, full };
}

/** Reads a whole file inside the package, at most `max` bytes, never following a symbolic link. */
export async function readInside (root: string, rel: string, max: number): Promise<Buffer> {
  const { fh, size, full } = await openInside(root, rel);
  try {
    if (size > max) throw new PackageError('file-too-large', `${path.basename(full)} is larger than ${Math.max(1, Math.round(max / (1024 * 1024)))} MB.`);
    const buf = Buffer.alloc(size);
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

/** The kit's own folder inside the package (created), refused when it is anything but a plain folder there. */
export async function kitDir (root: string): Promise<string> {
  const dir = path.join(root, KIT_DIR);
  let st: Stats | null = null;
  try { st = await fsp.lstat(dir); } catch { st = null; }
  if (st == null) {
    await fsp.mkdir(dir, { mode: 0o700 });
    st = await fsp.lstat(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PackageError('kit-dir-invalid', `${KIT_DIR} in the package is not a plain folder; nothing was written.`);
  if (await fsp.realpath(dir) !== dir) throw new PackageError('kit-dir-invalid', `${KIT_DIR} in the package is reached through a link; nothing was written.`);
  return dir;
}

/**
 * Writes one file of the kit's folder: whatever sits at that name (a file, or a symbolic link a downloaded package
 * shipped) is removed first, then the file is created anew (O_EXCL | O_NOFOLLOW), so a link is never followed.
 */
export async function writeKitFile (root: string, name: string, data: string): Promise<void> {
  const dir = await kitDir(root);
  const full = path.join(dir, name);
  const st = await fsp.lstat(full).catch(() => null);
  if (st != null) {
    if (st.isDirectory()) throw new PackageError('kit-file-invalid', `${KIT_DIR}/${name} is a folder; nothing was written.`);
    await fsp.unlink(full);
  }
  const fh = await fsp.open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Reads one file of the kit's folder written by writeKitFile, or null when absent or not a plain file. */
export async function readKitFile (root: string, name: string): Promise<string | null> {
  try {
    return (await readInside(root, `${KIT_DIR}/${name}`, KIT_FILE_MAX_BYTES)).toString('utf8');
  } catch {
    return null;
  }
}
