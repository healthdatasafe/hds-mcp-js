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
