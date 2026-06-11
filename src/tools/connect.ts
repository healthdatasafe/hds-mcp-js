import { z } from 'zod';
import { resolveServiceInfoUrl } from '../lib/hostPolicy.ts';
import { setApiEndpoint } from '../auth/session.ts';
import { runAuthFlow, type RequestedPermission } from '../auth/pryvAuth.ts';

export const connectInput = {
  host: z.string().optional().describe(
    "Which HDS platform to connect to. 'demo' (default, throwaway) or 'prod' (real data). " +
    'You can also pass a full service-info URL.'
  ),
  level: z.enum(['read', 'contribute', 'manage']).optional().describe(
    "Permission level requested. 'contribute' (default — read+write events; covers create_event / import_batch / the pilot scenario), " +
    "'read' (read-only), or 'manage' (also stream config). Pick 'read' only when the user explicitly asks for a read-only session."
  ),
  enableWrites: z.boolean().optional().describe(
    'Unlock create_event / import_batch on the PRODUCTION host for this session. ' +
    "Only meaningful with host: 'prod' (demo writes are always allowed). " +
    'Pass true ONLY when the user explicitly asked to write to their real production account — ' +
    'never set it on your own initiative. The user still reviews and accepts the permission ' +
    'request on the sign-in consent screen.'
  )
};

export async function connectHandler (
  { host, level, enableWrites }: { host?: string; level?: 'read' | 'contribute' | 'manage'; enableWrites?: boolean }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const serviceInfoUrl = resolveServiceInfoUrl(host);
  const permissions: RequestedPermission[] = [{
    streamId: '*',
    level: level ?? 'contribute',
    defaultName: 'All HDS data'
  }];
  const { apiEndpoint, username } = await runAuthFlow(serviceInfoUrl, permissions);
  setApiEndpoint(apiEndpoint, enableWrites === true);
  const prodWriteNote = enableWrites === true
    ? ' Production writes: enabled for this session.'
    : '';
  return {
    content: [{
      type: 'text',
      text: `Connected as ${username} (${new URL(apiEndpoint).hostname}). Permission level: ${permissions[0].level}.${prodWriteNote}`
    }]
  };
}
