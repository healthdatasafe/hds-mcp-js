import { z } from 'zod';
import { resolveServiceInfoUrl } from '../lib/hostPolicy.ts';
import { setApiEndpoint } from '../auth/session.ts';
import { runAuthFlow, APP_ID, type RequestedPermission } from '../auth/pryvAuth.ts';
import { loadPack, localized } from '../dataModel/pack.ts';

type Level = 'read' | 'contribute' | 'manage';

export const connectInput = {
  host: z.string().optional().describe(
    "Which HDS platform to connect to. 'demo' (default, throwaway) or 'prod' (real data). " +
    'You can also pass a full service-info URL.'
  ),
  level: z.enum(['read', 'contribute', 'manage']).optional().describe(
    "Permission level requested. 'contribute' (default — read+write events; covers create_event / import_batch / the pilot scenario), " +
    "'read' (read-only), or 'manage' (also stream config). Pick 'read' only when the user explicitly asks for a read-only session. " +
    'With roots, the default level per root is manage (an import creates item streams under its roots).'
  ),
  enableWrites: z.boolean().optional().describe(
    'Unlock create_event / import_batch on the PRODUCTION host for this session. ' +
    "Only meaningful with host: 'prod' (demo writes are always allowed). " +
    'Pass true ONLY when the user explicitly asked to write to their real production account — ' +
    'never set it on your own initiative. The user still reviews and accepts the permission ' +
    'request on the sign-in consent screen.'
  ),
  roots: z.array(z.object({
    streamId: z.string().min(1),
    level: z.enum(['read', 'contribute', 'manage']).optional()
  })).min(1).optional().describe(
    'Request access to exactly these root streams (see list_model_streams) instead of all data. ' +
    'Required for an import: list only the roots it writes or reads. Missing roots are created at sign-in ' +
    'with their data-model name. Before calling, tell the user in plain words which kinds of data the ' +
    'access covers (the root names) and the level.'
  ),
  importName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional().describe(
    'For an import: a stable lowercase name (letters, digits, dashes), the same one used as the <tool> part of ' +
    'every clientData.sourceKey. The session then signs in as its own app access "hds-mcp-<importName>", so every ' +
    'event it writes names the import as its author, and the import can be found and removed later.'
  )
};

export async function connectHandler (
  { host, level, enableWrites, roots, importName }: {
    host?: string;
    level?: Level;
    enableWrites?: boolean;
    roots?: Array<{ streamId: string; level?: Level }>;
    importName?: string;
  }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const serviceInfoUrl = resolveServiceInfoUrl(host);
  const all = roots ? null : await allDataPermissions(level);
  const permissions = all ? all.permissions : await rootPermissions(roots!, level);
  const appId = importName ? `${APP_ID}-${importName}` : APP_ID;
  const { apiEndpoint, username } = await runAuthFlow(serviceInfoUrl, permissions, appId);
  setApiEndpoint(apiEndpoint, enableWrites === true, serviceInfoUrl);
  const prodWriteNote = enableWrites === true
    ? ' Production writes: enabled for this session.'
    : '';
  const scope = all
    ? `All HDS data${all.excluded.length > 0 ? ` except ${all.excluded.join(', ')}` : ''} (${permissions[0]?.level})`
    : permissions.map((p) => `${p.defaultName ?? p.streamId} (${p.level})`).join(', ');
  return {
    content: [{
      type: 'text',
      text: `Connected as ${username} (${new URL(apiEndpoint).hostname}) with app access "${appId}". ` +
        `Access: ${scope}.${prodWriteNote}`
    }]
  };
}

type PackRoot = { id: string; name?: string; label?: Record<string, string>; explicitGrantOnly?: boolean };

const rootName = (s: PackRoot): string => (s.label ? localized(s.label, 'en') : s.name) ?? s.id;

/**
 * "All data" without `*`: one permission per data-model root, minus the roots marked
 * `explicitGrantOnly` (genetics), which only an access naming them may reach (site-agents#37).
 * Not `[{ '*' }, { genetics, none }]`: the core requires a `defaultName` on the mask and then
 * creates the stream it masks (verified on demo, 2026-11-04).
 */
export async function allDataPermissions (level?: Level): Promise<{ permissions: RequestedPermission[]; excluded: string[] }> {
  const pack = await loadPack();
  const roots = (pack.streams ?? []) as PackRoot[];
  return {
    permissions: roots.filter((s) => s.explicitGrantOnly !== true)
      .map((s) => ({ streamId: s.id, level: level ?? 'contribute', defaultName: rootName(s) })),
    excluded: roots.filter((s) => s.explicitGrantOnly === true).map(rootName)
  };
}

/** Per-root permissions, named from the data model so the consent screen and the account show plain names. */
export async function rootPermissions (
  roots: Array<{ streamId: string; level?: Level }>,
  level?: Level
): Promise<RequestedPermission[]> {
  if (roots.some((r) => r.streamId === '*')) {
    throw new Error('roots must name streams; omit roots to request all data.');
  }
  const pack = await loadPack();
  const modelRoots = new Map(((pack.streams ?? []) as PackRoot[]).map((s) => [s.id, rootName(s)]));
  return roots.map((r) => ({
    streamId: r.streamId,
    level: r.level ?? level ?? 'manage',
    defaultName: modelRoots.get(r.streamId) ?? r.streamId
  }));
}
