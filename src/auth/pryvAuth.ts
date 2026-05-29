import open from 'open';
import { safeLog } from '../lib/scrubber.ts';

const APP_ID = 'hds-mcp';
const POLL_INTERVAL_MS_DEFAULT = 1000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

interface ServiceInfo {
  register: string;
  access: string;
  api: string;
  name?: string;
}

interface AuthRequestResponse {
  status: 'NEED_SIGNIN' | 'ACCEPTED' | 'REFUSED';
  key?: string;
  url?: string;
  authUrl?: string;
  poll?: string;
  pollRateMs?: number;
  apiEndpoint?: string;
  username?: string;
  token?: string;
  message?: string;
}

export interface RequestedPermission {
  streamId: string;
  level: 'read' | 'contribute' | 'manage';
  defaultName?: string;
}

export async function fetchServiceInfo (serviceInfoUrl: string): Promise<ServiceInfo> {
  const res = await fetch(serviceInfoUrl);
  if (!res.ok) throw new Error(`service-info fetch failed: HTTP ${res.status}`);
  const info = await res.json() as ServiceInfo;
  if (info.access == null) throw new Error('service-info missing `access` URL');
  return info;
}

export async function runAuthFlow (
  serviceInfoUrl: string,
  requestedPermissions: RequestedPermission[]
): Promise<{ apiEndpoint: string; username: string }> {
  const info = await fetchServiceInfo(serviceInfoUrl);

  const initRes = await fetch(info.access + APP_ID, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestingAppId: APP_ID,
      requestedPermissions,
      languageCode: 'en',
      returnURL: 'self'
    })
  });
  if (!initRes.ok) {
    throw new Error(`auth request failed: HTTP ${initRes.status} ${await safeText(initRes)}`);
  }
  const init = await initRes.json() as AuthRequestResponse;
  if (init.status !== 'NEED_SIGNIN' || !init.poll || !(init.authUrl ?? init.url)) {
    throw new Error(`auth request returned unexpected status: ${init.status}`);
  }

  const authUrl = init.authUrl ?? init.url!;
  safeLog(`Opening browser for HDS sign-in: ${authUrl}`);
  await open(authUrl);

  const pollUrl = init.poll;
  const intervalMs = init.pollRateMs ?? POLL_INTERVAL_MS_DEFAULT;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const pollRes = await fetch(pollUrl);
    if (!pollRes.ok) {
      safeLog(`poll non-OK (${pollRes.status}), continuing`);
      continue;
    }
    const data = await pollRes.json() as AuthRequestResponse;
    if (data.status === 'ACCEPTED') {
      if (!data.apiEndpoint || !data.username) {
        throw new Error('auth accepted but apiEndpoint/username missing');
      }
      return { apiEndpoint: data.apiEndpoint, username: data.username };
    }
    if (data.status === 'REFUSED') {
      throw new Error(`auth refused: ${data.message ?? 'no reason given'}`);
    }
  }
  throw new Error('auth timed out — please re-run hds.connect');
}

async function safeText (res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
