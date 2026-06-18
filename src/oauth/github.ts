// github.ts — native GitHub Copilot OAuth (RFC 8628 device code)
// Uses the same public client ID as the VS Code Copilot extension.
// Flow: device code → ghu_ access token → exchange for short-lived Copilot session token.
// The ghu_ token is stored as the "refresh token" and re-exchanged when the Copilot token expires.

import { positiveSecondsToMs, sleepMs } from './pkce.js';
import type { OAuthTokenResponse } from './types.js';
import { VERSION } from '../constants.js';

// Public OAuth App client ID used by VS Code GitHub Copilot extension
const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const SCOPE = 'copilot';

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 15 * 60 * 1000; // 15 minutes
const OAUTH_POLLING_SAFETY_MARGIN_MS = 1_000;

export interface GithubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in?: number;
  interval?: number;
}

function commonHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': `relay-ai/${VERSION}`,
  };
}

export async function requestGithubDeviceCode(): Promise<GithubDeviceCodeResponse> {
  const response = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: commonHeaders(),
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`GitHub device code request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const json = await response.json() as GithubDeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error('GitHub device code response is missing required fields');
  }
  return json;
}

/** Exchange a ghu_ GitHub OAuth user token for a short-lived Copilot session token. */
export async function exchangeForCopilotToken(ghuToken: string): Promise<OAuthTokenResponse> {
  const response = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${ghuToken}`,
      'User-Agent': `relay-ai/${VERSION}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const msg = await response.text().catch(() => '');
    throw new Error(`GitHub Copilot token exchange failed (${response.status})${msg ? `: ${msg}` : ''}`);
  }
  const json = await response.json() as { token?: string; expires_at?: string };
  if (!json.token) {
    throw new Error('GitHub Copilot token exchange response missing token field — is Copilot subscription active?');
  }
  // expires_at is an ISO string; convert to expires_in seconds
  let expiresIn = 1800; // default 30 min
  if (json.expires_at) {
    const expiresMs = new Date(json.expires_at).getTime() - Date.now();
    if (expiresMs > 0) expiresIn = Math.floor(expiresMs / 1000);
  }
  return { access_token: json.token, expires_in: expiresIn };
}

/**
 * Refresh: the stored "refresh token" is actually the long-lived ghu_ OAuth token.
 * We just re-exchange it for a new short-lived Copilot session token.
 */
export async function refreshGithubCopilotToken(ghuToken: string): Promise<OAuthTokenResponse> {
  const copilot = await exchangeForCopilotToken(ghuToken);
  return {
    ...copilot,
    refresh_token: ghuToken, // keep the same ghu_ token as refresh
  };
}

export async function pollGithubDeviceCodeToken(
  device: GithubDeviceCodeResponse,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<OAuthTokenResponse> {
  const sleep = opts?.sleep ?? sleepMs;
  const now = opts?.now ?? (() => Date.now());
  const deadline = now() + positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS);
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    1_000,
  );

  while (now() < deadline) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: commonHeaders(),
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });

    const body = await response.json().catch(() => ({}) as Record<string, unknown>) as Record<string, unknown>;
    const error = body['error'] as string | undefined;

    if (!error && body['access_token']) {
      const ghuToken = body['access_token'] as string;
      // Exchange ghu_ token for a Copilot session token
      const copilot = await exchangeForCopilotToken(ghuToken);
      return {
        access_token: copilot.access_token,
        refresh_token: ghuToken, // store ghu_ as refresh for re-exchange later
        expires_in: copilot.expires_in,
      };
    }

    if (error === 'authorization_pending') {
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, Math.max(0, deadline - now())));
      continue;
    }
    if (error === 'slow_down') {
      intervalMs += 5_000;
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, Math.max(0, deadline - now())));
      continue;
    }
    if (error === 'expired_token') {
      throw new Error('GitHub device code expired — please run relay-ai providers auth github-copilot again');
    }
    throw new Error(`GitHub device authorization failed${error ? `: ${error}` : ''}`);
  }
  throw new Error('GitHub device authorization timed out');
}

export async function runGithubDeviceCodeFlow(
  onDeviceCode: (info: { url: string; userCode: string }) => void,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<OAuthTokenResponse> {
  const device = await requestGithubDeviceCode();
  onDeviceCode({ url: device.verification_uri, userCode: device.user_code });
  return pollGithubDeviceCodeToken(device, opts);
}
