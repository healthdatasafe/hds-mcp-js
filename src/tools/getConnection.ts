import { getApiEndpoint, getServiceInfoUrl, isConnected } from '../auth/session.ts';
import { platformNote, platformOf, SERVICE_INFO } from '../lib/hostPolicy.ts';

export const getConnectionInput = {};

/** Demo or production, connected or not: what the model should tell the person before it reads or writes. */
export async function getConnectionHandler (): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (isConnected()) {
    const api = new URL(getApiEndpoint());
    const platform = platformOf(api.href);
    return { content: [{ type: 'text', text: `Connected to the HDS ${platform} platform (${api.hostname}). ${platformNote(platform)}` }] };
  }
  const platform = platformOf(getServiceInfoUrl() ?? SERVICE_INFO.demo);
  return { content: [{ type: 'text', text: `Not connected yet; this session uses the HDS ${platform} platform. ${platformNote(platform)}` }] };
}
