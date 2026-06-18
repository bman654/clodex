// xai.ts — native xAI SuperGrok OAuth (RFC 8628 device code, ported from OpenCode)

import { positiveSecondsToMs, sleepMs } from './pkce.js';
import type { OAuthTokenResponse } from './types.js';
import { VERSION } from '../constants.js';

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const DEVICE_AUTHORIZATION_URL = 'https://auth.x.ai/oauth2/device/code';
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

export interface XaiDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'User-Agent': `relay-ai/${VERSION}`,
  };
}

export async function requestXaiDeviceCode(): Promise<XaiDeviceCodeResponse> {
  const response = await fetch(DEVICE_AUTHORIZATION_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }).toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`xAI device code request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const json = await response.json() as XaiDeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error('xAI device code response is missing required fields');
  }
  return json;
}

export async function pollXaiDeviceCodeToken(
  device: XaiDeviceCodeResponse,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<OAuthTokenResponse> {
  const sleep = opts?.sleep ?? sleepMs;
  const now = opts?.now ?? (() => Date.now());
  const deadline = now() + positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS);
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS,
  );

  while (now() < deadline) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.device_code,
      }).toString(),
    });
    if (response.ok) return response.json() as Promise<OAuthTokenResponse>;

    const body = await response.json().catch(() => ({})) as { error?: string };
    const remaining = Math.max(0, deadline - now());
    if (body.error === 'authorization_pending') {
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    if (body.error === 'slow_down') {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    throw new Error(`xAI device authorization failed${body.error ? `: ${body.error}` : ''}`);
  }
  throw new Error('xAI device authorization timed out');
}

export async function refreshXaiAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`xAI token refresh failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return response.json() as Promise<OAuthTokenResponse>;
}

export async function runXaiDeviceCodeFlow(
  onDeviceCode: (info: { url: string; userCode: string }) => void,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<OAuthTokenResponse> {
  const device = await requestXaiDeviceCode();
  onDeviceCode({
    url: device.verification_uri_complete ?? device.verification_uri,
    userCode: device.user_code,
  });
  return pollXaiDeviceCodeToken(device, opts);
}
