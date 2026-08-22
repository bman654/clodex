// openai.ts — native OpenAI ChatGPT Plus/Pro OAuth (device code, ported from OpenCode)

import { generatePkce, generateOAuthState, positiveSecondsToMs, sleepMs } from './pkce.js';
import type { OAuthTokenResponse } from './types.js';
import { VERSION } from '../constants.js';
import { postOAuthRefresh } from './refresh-http.js';
import { startCallbackServer } from './callback-server.js';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
// The only redirect URIs registered for this client id (shared with the Codex
// CLI): http://localhost:{1455|1457}/auth/callback. Any other port is rejected
// by auth.openai.com, so the callback server must win one of these two.
const BROWSER_CALLBACK_PORTS = [1455, 1457] as const;
const BROWSER_CALLBACK_PATH = '/auth/callback';

export interface OpenAiIdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
}

export interface OpenAiDeviceCodeData {
  device_auth_id: string;
  user_code: string;
  interval: string;
  expires_in?: number;
}

export function extractOpenAiAccountId(tokens: OAuthTokenResponse): string | undefined {
  const token = tokens.id_token ?? tokens.access_token;
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as OpenAiIdTokenClaims;
    return claims.chatgpt_account_id
      ?? claims['https://api.openai.com/auth']?.chatgpt_account_id
      ?? claims.organizations?.[0]?.id;
  } catch {
    return undefined;
  }
}

export async function requestOpenAiDeviceCode(): Promise<OpenAiDeviceCodeData> {
  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `clodex/${VERSION}`,
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!response.ok) {
    throw new Error('Failed to initiate OpenAI device authorization');
  }
  return response.json() as Promise<OpenAiDeviceCodeData>;
}

export function openAiDeviceCodeUrl(): string {
  return `${ISSUER}/codex/device`;
}

export async function pollOpenAiDeviceCodeToken(
  deviceData: OpenAiDeviceCodeData,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ tokens: OAuthTokenResponse; accountId?: string }> {
  const sleep = opts?.sleep ?? sleepMs;
  const now = opts?.now ?? (() => Date.now());
  const intervalMs = Math.max(parseInt(deviceData.interval, 10) || 5, 1) * 1000;
  const deadline = now() + positiveSecondsToMs(deviceData.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS);

  while (now() < deadline) {
    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `clodex/${VERSION}`,
      },
      body: JSON.stringify({
        device_auth_id: deviceData.device_auth_id,
        user_code: deviceData.user_code,
      }),
    });

    if (response.ok) {
      const data = await response.json() as { authorization_code: string; code_verifier: string };
      const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: data.authorization_code,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: data.code_verifier,
        }).toString(),
      });
      if (!tokenResponse.ok) {
        throw new Error(`OpenAI token exchange failed (${tokenResponse.status})`);
      }
      const tokens = await tokenResponse.json() as OAuthTokenResponse;
      return { tokens, accountId: extractOpenAiAccountId(tokens) };
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`OpenAI device authorization failed (${response.status})`);
    }

    await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, Math.max(0, deadline - now())));
  }
  throw new Error('OpenAI device authorization timed out');
}

export async function refreshOpenAiAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
  return postOAuthRefresh(
    `${ISSUER}/oauth/token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    {
      contentType: 'form',
      errorPrefix: 'OpenAI token refresh failed',
      includeStatus: true,
    },
  );
}

export function buildOpenAiAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
  });
  return `${ISSUER}/oauth/authorize?${qs.toString()}`;
}

export async function exchangeOpenAiAuthorizationCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<OAuthTokenResponse> {
  return postOAuthRefresh(
    `${ISSUER}/oauth/token`,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
    {
      contentType: 'form',
      errorPrefix: 'OpenAI token exchange failed',
      includeStatus: true,
    },
  );
}

/**
 * Browser PKCE sign-in — for ChatGPT workspaces whose admin has disabled
 * device-code authorization. Needs a browser that can reach this machine's
 * loopback, so it does not work over plain SSH.
 */
export async function runOpenAiBrowserFlow(
  onAuthorizeUrl: (info: { url: string }) => void,
  opts?: { ports?: readonly number[]; timeoutMs?: number },
): Promise<{ tokens: OAuthTokenResponse; accountId?: string }> {
  const { verifier, challenge } = await generatePkce();
  const state = generateOAuthState();

  const ports = opts?.ports ?? BROWSER_CALLBACK_PORTS;
  let server;
  try {
    server = await startCallbackServer({
      ports,
      path: BROWSER_CALLBACK_PATH,
      redirectHost: 'localhost',
      expectedState: state,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        `Ports ${ports.join(' and ')} are in use — close any other OpenAI sign-in `
        + '(e.g. codex login) and try again.',
      );
    }
    throw new Error(
      `Could not start the OAuth callback listener: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    onAuthorizeUrl({ url: buildOpenAiAuthorizeUrl(server.redirectUri, challenge, state) });
    const params = await server.waitForCallback(opts?.timeoutMs);
    if (params.error) throw new Error(`OpenAI sign-in failed: ${params.error}`);
    if (!params.code) throw new Error('OpenAI sign-in returned no authorization code');
    // Defense in depth: the callback server already filters on expectedState.
    if (params.state !== state) {
      throw new Error('OpenAI sign-in returned a mismatched state — try again');
    }
    const tokens = await exchangeOpenAiAuthorizationCode(params.code, server.redirectUri, verifier);
    return { tokens, accountId: extractOpenAiAccountId(tokens) };
  } finally {
    server.close();
  }
}

export async function runOpenAiDeviceCodeFlow(
  onDeviceCode: (info: { url: string; userCode: string }) => void,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ tokens: OAuthTokenResponse; accountId?: string }> {
  const deviceData = await requestOpenAiDeviceCode();
  onDeviceCode({ url: openAiDeviceCodeUrl(), userCode: deviceData.user_code });
  return pollOpenAiDeviceCodeToken(deviceData, opts);
}
