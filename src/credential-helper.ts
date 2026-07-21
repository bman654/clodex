import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

export const CREDENTIAL_HELPER_ENV = 'CLODEX_CREDENTIAL_HELPER';
export const CREDENTIAL_HELPER_SERVICE = 'clodex';

const HELPER_TIMEOUT_MS = 10_000;
const HELPER_MAX_OUTPUT_BYTES = 1024 * 1024;

type HelperOperation = 'get' | 'set' | 'delete';

interface HelperResult {
  code: number;
  stdout: string;
}

export interface ConfiguredCredentialHelper {
  path: string;
  id: string;
}

export function credentialHelperIdForPath(path: string): string {
  return createHash('sha256')
    .update('clodex-credential-helper\0')
    .update(normalize(path))
    .digest('hex');
}

export function configuredCredentialHelperPath(): string | null {
  const value = process.env[CREDENTIAL_HELPER_ENV]?.trim();
  if (!value) return null;
  if (!isAbsolute(value)) {
    throw new Error(`${CREDENTIAL_HELPER_ENV} must be an absolute executable path`);
  }
  try {
    const stat = statSync(value);
    if (!stat.isFile()) {
      throw new Error(`${CREDENTIAL_HELPER_ENV} must point to a file`);
    }
    accessSync(value, constants.X_OK);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(CREDENTIAL_HELPER_ENV)) throw err;
    throw new Error(`${CREDENTIAL_HELPER_ENV} is not an executable file`);
  }
  return value;
}

export function configuredCredentialHelper(): ConfiguredCredentialHelper | null {
  const path = configuredCredentialHelperPath();
  return path ? { path, id: credentialHelperIdForPath(path) } : null;
}

export function credentialAuthRef(account: string): string {
  const helper = configuredCredentialHelper();
  return helper
    ? `helper:v1:${helper.id}:${account}`
    : `keyring:${account}`;
}

async function runCredentialHelper(
  operation: HelperOperation,
  account: string,
  input?: string,
  expectedHelperId?: string,
): Promise<HelperResult> {
  const helper = configuredCredentialHelper();
  if (!helper) {
    throw new Error(`${CREDENTIAL_HELPER_ENV} is required for helper credentials`);
  }
  if (expectedHelperId && helper.id !== expectedHelperId) {
    throw new Error(
      `${CREDENTIAL_HELPER_ENV} does not match the helper that owns this credential; restore the prior helper or reauthenticate`,
    );
  }

  return new Promise<HelperResult>((resolve, reject) => {
    const child = spawn(
      helper.path,
      [operation, CREDENTIAL_HELPER_SERVICE, account],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const finishReject = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill('SIGKILL');
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      finishReject(`credential helper ${operation} timed out`);
    }, HELPER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > HELPER_MAX_OUTPUT_BYTES) {
        finishReject(`credential helper ${operation} returned too much output`);
        return;
      }
      stdout.push(buffer);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {
      // The exit status remains authoritative when a helper closes stdin early.
    });
    child.on('error', () => {
      finishReject(`credential helper ${operation} could not start`);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8') });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function readCredentialHelperAccount(account: string, helperId?: string): Promise<string | null> {
  const result = await runCredentialHelper('get', account, undefined, helperId);
  if (result.code === 2) return null;
  if (result.code !== 0) {
    throw new Error(`credential helper get failed with exit code ${result.code}`);
  }
  return result.stdout;
}

export async function writeCredentialHelperAccount(account: string, value: string, helperId?: string): Promise<void> {
  const result = await runCredentialHelper('set', account, value, helperId);
  if (result.code !== 0) {
    throw new Error(`credential helper set failed with exit code ${result.code}`);
  }
}

export async function deleteCredentialHelperAccount(account: string, helperId?: string): Promise<void> {
  const result = await runCredentialHelper('delete', account, undefined, helperId);
  if (result.code !== 0 && result.code !== 2) {
    throw new Error(`credential helper delete failed with exit code ${result.code}`);
  }
}
