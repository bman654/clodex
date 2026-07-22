import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJson(path: string, value: unknown): void {
  fs.writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for signal: ${path}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function waitForFileSync(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for signal: ${path}`);
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

const role = requiredEnv('REGISTRY_LOCK_WORKER_ROLE');
const root = process.env.REGISTRY_LOCK_WORKER_ROOT ?? requiredEnv('CLODEX_HOME');
const registryPath = join(requiredEnv('CLODEX_HOME'), 'providers.json');
const lockPath = `${registryPath}.lock`;

async function runHolder(): Promise<void> {
  const { withRegistryWriteLock } = await import('../../src/registry/lock.js');
  const { emptyRegistry, saveRegistry } =
    await import('../../src/registry/io.js');
  const readyPath = join(root, 'holder-ready.json');
  const releasePath = join(root, 'release-holder');
  const resultPath = join(root, 'holder-result.json');

  try {
    await withRegistryWriteLock(
      async () => {
        saveRegistry({ ...emptyRegistry(), importedAt: 'holder-initial' }, registryPath);
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
          pid: number;
          token: string;
        };
        writeJson(readyPath, { pid: owner.pid, token: owner.token });
        await waitForFile(releasePath, 10_000);
        saveRegistry({ ...emptyRegistry(), importedAt: 'holder-final' }, registryPath);
      },
      { lockPath, waitMs: 2_000, retryMs: 10 },
    );
    writeJson(resultPath, { ok: true });
  } catch (error) {
    writeJson(resultPath, { ok: false, error: errorMessage(error) });
    throw error;
  }
}

async function runContender(): Promise<void> {
  const { withRegistryWriteLock } = await import('../../src/registry/lock.js');
  const { emptyRegistry, saveRegistry } =
    await import('../../src/registry/io.js');
  const resultPath = join(root, 'contender-result.json');

  try {
    await withRegistryWriteLock(
      () => {
        saveRegistry({ ...emptyRegistry(), importedAt: 'contender' }, registryPath);
      },
      { lockPath, waitMs: 250, retryMs: 10 },
    );
    writeJson(resultPath, { acquired: true });
  } catch (error) {
    writeJson(resultPath, {
      acquired: false,
      error: errorMessage(error),
    });
  }
}

async function runLeaseLoss(): Promise<void> {
  const resultPath = join(root, 'lease-loss-result.json');
  const originalOpenSync = fs.openSync;
  const originalWriteSync = fs.writeSync;
  let registryTempFd: number | undefined;
  let replacementPublished = false;

  fs.openSync = ((...args: unknown[]) => {
    const fd = Reflect.apply(originalOpenSync, fs, args) as number;
    const path = args[0];
    if (
      typeof path === 'string' &&
      path.startsWith(`${registryPath}.${process.pid}.`) &&
      path.endsWith('.tmp')
    ) {
      registryTempFd = fd;
    }
    return fd;
  }) as typeof fs.openSync;
  fs.writeSync = ((...args: unknown[]) => {
    const written = Reflect.apply(originalWriteSync, fs, args) as number;
    if (args[0] === registryTempFd && !replacementPublished) {
      const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
        pid: number;
        startedAt: number;
        token: string;
      };
      fs.unlinkSync(lockPath);
      writeJson(lockPath, {
        ...owner,
        token: 'replacement-owner',
      });
      replacementPublished = true;
    }
    return written;
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();

  const { withRegistryWriteLockSync } =
    await import('../../src/registry/lock.js');
  const { emptyRegistry, saveRegistry } =
    await import('../../src/registry/io.js');
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify({ ...emptyRegistry(), importedAt: 'sentinel' })}\n`,
    {
      mode: 0o600,
    },
  );

  let error: unknown;
  try {
    withRegistryWriteLockSync(
      () => {
        saveRegistry({ ...emptyRegistry(), importedAt: 'unwanted' }, registryPath);
      },
      { lockPath },
    );
  } catch (caught) {
    error = caught;
  }

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
    importedAt?: string;
  };
  const replacement = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
    token?: string;
  };
  const temporaryArtifacts = fs.readdirSync(root).filter(name => name.endsWith('.tmp'));
  writeJson(resultPath, {
    errorName: error instanceof Error ? error.name : null,
    error: errorMessage(error),
    importedAt: registry.importedAt,
    replacementPublished,
    replacementToken: replacement.token,
    temporaryArtifacts,
  });
  fs.unlinkSync(lockPath);
}

async function runAtomicAcquire(): Promise<void> {
  const readyPath = join(root, 'atomic-acquire-ready.json');
  const releasePath = join(root, 'release-atomic-acquire');
  const resultPath = join(root, 'atomic-acquire-result.json');
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  let recordFd: number | undefined;
  let candidatePath: string | undefined;
  let paused = false;

  fs.openSync = ((...args: unknown[]) => {
    const fd = Reflect.apply(originalOpenSync, fs, args) as number;
    const path = args[0];
    const flags = args[1];
    if (
      typeof path === 'string' &&
      flags === 'wx' &&
      (path === lockPath || path.startsWith(`${lockPath}.`))
    ) {
      recordFd = fd;
      candidatePath = path;
    }
    return fd;
  }) as typeof fs.openSync;
  fs.writeFileSync = ((...args: unknown[]) => {
    if (args[0] === recordFd && !paused) {
      paused = true;
      writeJson(readyPath, { candidatePath, pid: process.pid });
      waitForFileSync(releasePath, 5_000);
    }
    return Reflect.apply(originalWriteFileSync, fs, args) as void;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();

  const { tryAcquireRegistryLock } = await import('../../src/registry/lock.js');
  const lease = tryAcquireRegistryLock(lockPath);
  if (!lease) throw new Error('Atomic acquisition worker did not get the lock');
  const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
    pid: number;
    token: string;
  };
  lease.release();
  writeJson(resultPath, {
    acquired: true,
    ownerPid: owner.pid,
    ownerToken: owner.token,
  });
}

function credentialAuthRef(): string {
  return requiredEnv('REGISTRY_LOCK_CREDENTIAL_REF');
}

async function runCredentialHolder(): Promise<void> {
  const {
    getCredentialMutationLockPath,
    getCredentialStateRoot,
    withCredentialMutationLock,
  } = await import('../../src/registry/lock.js');
  const authRef = credentialAuthRef();
  const readyPath = join(root, 'credential-holder-ready.json');
  const releasePath = join(root, 'release-credential-holder');
  const resultPath = join(root, 'credential-holder-result.json');

  await withCredentialMutationLock(authRef, async () => {
    writeJson(readyPath, {
      pid: process.pid,
      lockPath: getCredentialMutationLockPath(authRef),
      stateRoot: getCredentialStateRoot(),
    });
    await waitForFile(releasePath, 5_000);
  });
  writeJson(resultPath, { ok: true });
}

async function runCredentialContender(): Promise<void> {
  const {
    getCredentialMutationLockPath,
    getCredentialStateRoot,
    withCredentialMutationLock,
  } = await import('../../src/registry/lock.js');
  const authRef = credentialAuthRef();
  const readyPath = join(root, 'credential-contender-ready.json');
  const enteredPath = join(root, 'credential-contender-entered.json');
  const resultPath = join(root, 'credential-contender-result.json');

  writeJson(readyPath, {
    pid: process.pid,
    lockPath: getCredentialMutationLockPath(authRef),
    stateRoot: getCredentialStateRoot(),
  });
  await withCredentialMutationLock(authRef, () => {
    writeJson(enteredPath, { pid: process.pid });
  });
  writeJson(resultPath, { ok: true });
}

switch (role) {
  case 'holder':
    await runHolder();
    break;
  case 'contender':
    await runContender();
    break;
  case 'lease-loss':
    await runLeaseLoss();
    break;
  case 'atomic-acquire':
    await runAtomicAcquire();
    break;
  case 'credential-holder':
    await runCredentialHolder();
    break;
  case 'credential-contender':
    await runCredentialContender();
    break;
  default:
    throw new Error(`Unsupported registry lock worker role: ${role}`);
}
