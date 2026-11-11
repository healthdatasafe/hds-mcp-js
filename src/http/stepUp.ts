import type { DataModelPack } from '../dataModel/pack.ts';

/** Write tools whose target streams are in their arguments: the ones an import uses. */
const WRITE_TOOLS: Record<string, (args: any) => string[]> = {
  create_event: (a) => a?.streamIds ?? [],
  import_batch: (a) => (Array.isArray(a?.events) ? a.events.flatMap((e: any) => e?.streamIds ?? []) : [])
};

type StreamNode = { id: string; children?: StreamNode[] };

/** Model path root → stream (ids), or null for a stream the model does not know. */
function modelPath (roots: StreamNode[], streamId: string): string[] | null {
  for (const node of roots) {
    if (node.id === streamId) return [node.id];
    const sub = node.children?.length ? modelPath(node.children, streamId) : null;
    if (sub) return [node.id, ...sub];
  }
  return null;
}

/** Whether a JSON-RPC body is a call to a write tool (cheap: no data model needed). */
export function isWriteCall (body: any): boolean {
  return body?.method === 'tools/call' && typeof body.params?.name === 'string' && Object.hasOwn(WRITE_TOOLS, body.params.name);
}

const canWrite = (scopes: Set<string>, id: string) =>
  scopes.has(`hds/stream/${id}.contribute`) || scopes.has(`hds/stream/${id}.manage`);

function rootName (node: { id: string; name?: unknown }): string {
  const n = node.name as string | { en?: string } | undefined;
  return (typeof n === 'string' ? n : n?.en) ?? node.id;
}

/**
 * How the person extends a connection to writes (perki 2026-11-06: uploading is the first use case, and clients
 * that ignore the step-up challenge, e.g. Claude.ai, only show "Forbidden"). The MCP advertises write scopes, so
 * reconnecting brings the consent screen back with them.
 */
export function extendWriteHint (names: string[]): string {
  return `To add data${names.length ? ` to ${names.map((n) => `"${n}"`).join(', ')}` : ''}, the person reconnects the ` +
    'HDS connector in their AI assistant\'s connector settings (disconnect, then connect) and, on the HDS consent ' +
    `screen, ticks "Add and modify${names.length === 1 ? ` ${names[0]}` : ''}" (genetic results are unticked unless they ` +
    'tick them). Do not retry the write before they have.';
}

/** The model roots this connection may add to and those it may only read, by name. */
export function writeAccess (tokenScopes: string[], pack: DataModelPack): { write: string[]; readOnly: string[] } {
  const scopes = new Set(tokenScopes);
  const write: string[] = [];
  const readOnly: string[] = [];
  for (const root of (pack.streams ?? []) as Array<StreamNode & { name?: unknown }>) {
    if (canWrite(scopes, root.id)) write.push(rootName(root));
    else if (scopes.has(`hds/stream/${root.id}.read`)) readOnly.push(rootName(root));
  }
  return { write, readOnly };
}

/** Root names for `hds/stream/<root>.contribute` scopes, for the messages above. */
export function rootNames (scopes: string[], pack: DataModelPack): string[] {
  const roots = (pack.streams ?? []) as Array<StreamNode & { name?: unknown }>;
  return scopes.map((s) => {
    const id = s.replace(/^hds\/stream\//, '').replace(/\.[a-z]+$/, '');
    const root = roots.find((r) => r.id === id);
    return root ? rootName(root) : id;
  });
}

/**
 * Step-up (plan 118 D-J3): the `hds/stream/<root>.contribute` scopes a JSON-RPC write call needs and the token
 * lacks. Empty when the call is not a write, when the token covers every target (on the root or any model ancestor),
 * or for streams outside the model (the core decides those).
 */
export function missingWriteScopes (body: any, tokenScopes: string[], pack: DataModelPack): string[] {
  if (!isWriteCall(body)) return [];
  const targets = WRITE_TOOLS[body.params.name](body.params.arguments);
  const scopes = new Set(tokenScopes);
  const missing = new Set<string>();
  for (const streamId of targets) {
    const path = modelPath((pack.streams ?? []) as StreamNode[], streamId);
    if (path && !path.some((id) => canWrite(scopes, id))) missing.add(`hds/stream/${path[0]}.contribute`);
  }
  return [...missing];
}
