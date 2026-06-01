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
  )
};

export async function connectHandler (
  { host, level }: { host?: string; level?: 'read' | 'contribute' | 'manage' }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const serviceInfoUrl = resolveServiceInfoUrl(host);
  const permissions: RequestedPermission[] = [{
    streamId: '*',
    level: level ?? 'contribute',
    defaultName: 'All HDS data'
  }];
  const { apiEndpoint, username } = await runAuthFlow(serviceInfoUrl, permissions);
  setApiEndpoint(apiEndpoint);
  return {
    content: [{
      type: 'text',
      text: `Connected as ${username} (${new URL(apiEndpoint).hostname}). Permission level: ${permissions[0].level}.`
    }]
  };
}
