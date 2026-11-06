import { getApiEndpoint, getGrantedScopes, getServiceInfoUrl, isConnected } from '../auth/session.ts';
import { loadPack } from '../dataModel/pack.ts';
import { extendWriteHint, writeAccess } from '../http/stepUp.ts';
import { platformNote, platformOf, SERVICE_INFO } from '../lib/hostPolicy.ts';

export const getConnectionInput = {};

/** What this OAuth connection may add to and only read, and how the person extends it. Empty outside OAuth. */
async function accessNote (): Promise<string> {
  const scopes = getGrantedScopes();
  if (!scopes) return '';
  const { write, readOnly } = writeAccess(scopes, await loadPack());
  return ` May add data to: ${write.length ? write.join(', ') : 'nothing yet'}.` +
    (readOnly.length ? ` Read only: ${readOnly.join(', ')}.` : '') +
    (readOnly.length || !write.length ? ` ${extendWriteHint([])}` : '');
}

/** Demo or production, connected or not: what the model should tell the person before it reads or writes. */
export async function getConnectionHandler (): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (isConnected()) {
    const api = new URL(getApiEndpoint());
    const platform = platformOf(api.href);
    return { content: [{ type: 'text', text: `Connected to the HDS ${platform} platform (${api.hostname}). ${platformNote(platform)}${await accessNote()}` }] };
  }
  const platform = platformOf(getServiceInfoUrl() ?? SERVICE_INFO.demo);
  return { content: [{ type: 'text', text: `Not connected yet; this session uses the HDS ${platform} platform. ${platformNote(platform)}` }] };
}
