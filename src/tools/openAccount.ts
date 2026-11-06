import { z } from 'zod';
import { apiGet } from '../lib/apiCall.ts';
import { getApiEndpoint, getServiceInfoUrl, isConnected } from '../auth/session.ts';
import { ACCOUNT_URL, platformOf, SERVICE_INFO } from '../lib/hostPolicy.ts';

// Account app pages per task (app-web-user-account routes). Signed out, a page bounces to sign-in and keeps `username`.
const PAGES = {
  profile: 'account/profile',
  change_email: 'account/profile',
  change_password: 'change-password',
  reset_password: 'reset-password',
  security: 'account/security',
  preferences: 'account/preferences',
  connected_apps: 'account/apps',
  delegation: 'account/delegation',
  memberships: 'account/memberships',
  privacy: 'account/privacy',
  data: 'account/data',
  delete_account: 'account/data',
  ai_assistant: 'account/ai-assistant'
} as const;

type Task = keyof typeof PAGES;

export const openAccountInput = {
  task: z.enum(Object.keys(PAGES) as [Task, ...Task[]]).describe(
    'The account task: change_email, change_password, reset_password (forgotten password), security (two-step sign-in), ' +
    'preferences, connected_apps (see or revoke app accesses), delegation, memberships, privacy (consents), ' +
    'data or delete_account (export or delete the account), ai_assistant (AI connector settings), profile.'
  )
};

/** The connected account's username, or null (not connected, or the access does not say). */
async function connectedUsername (): Promise<string | null> {
  if (!isConnected()) return null;
  try {
    const info = await apiGet('access-info');
    return typeof info?.user?.username === 'string' ? info.user.username : null;
  } catch {
    return null;
  }
}

/**
 * A link to the HDS account panel for tasks these tools do not do (perki 2026-11-06): the account app of the session's
 * platform, at the task's page, with the username prefilled at sign-in.
 */
export async function openAccountHandler ({ task }: { task: Task }): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const platform = platformOf(isConnected() ? getApiEndpoint() : (getServiceInfoUrl() ?? SERVICE_INFO.demo));
  const url = new URL(PAGES[task], ACCOUNT_URL[platform]);
  const username = await connectedUsername();
  if (username) url.searchParams.set('username', username);
  return {
    content: [{
      type: 'text',
      text: `Give the person this link to the HDS account panel (${platform} platform); they do it there themselves, ` +
        `signing in if asked${username ? ` (their username "${username}" is filled in)` : ''}. ` +
        (task === 'reset_password' && username ? `On that page they enter their username, "${username}". ` : '') +
        'Nothing has been changed.\n\n' + url.href
    }]
  };
}
