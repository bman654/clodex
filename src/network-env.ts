export const PROXY_ENV_VARS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
] as const;

export const CHILD_NETWORK_ENV_VARS = [
  ...PROXY_ENV_VARS,
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const;

export const NETWORK_ENV_CONTRACT_VAR = 'CLAUDE_CODE_CLODEX_NETWORK_ENV';

type ChildNetworkEnvVar = typeof CHILD_NETWORK_ENV_VARS[number];
type NetworkEnvValue = string | null;

interface NetworkEnvContract {
  version: 1;
  original: Partial<Record<ChildNetworkEnvVar, NetworkEnvValue>>;
  injected: Partial<Record<ChildNetworkEnvVar, NetworkEnvValue>>;
}

const childNetworkEnvVarSet = new Set<string>(CHILD_NETWORK_ENV_VARS);

function networkEnvValue(env: NodeJS.ProcessEnv, name: ChildNetworkEnvVar): NetworkEnvValue {
  return typeof env[name] === 'string' ? env[name]! : null;
}

function isNetworkValueRecord(value: unknown): value is Record<string, NetworkEnvValue> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, entry]) =>
      childNetworkEnvVarSet.has(key) && (typeof entry === 'string' || entry === null)));
}

function parseNetworkEnvContract(value: string | undefined): NetworkEnvContract | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Partial<NetworkEnvContract>;
    const original = candidate.original;
    const injected = candidate.injected;
    if (candidate.version !== 1
      || !isNetworkValueRecord(original)
      || !isNetworkValueRecord(injected)) {
      return undefined;
    }
    if (!Object.keys(original).every(key => key in injected)
      || !Object.keys(injected).every(key => key in original)) {
      return undefined;
    }
    return { version: 1, original, injected };
  } catch {
    return undefined;
  }
}

function setNetworkEnvValue(
  env: NodeJS.ProcessEnv,
  name: ChildNetworkEnvVar,
  value: NetworkEnvValue,
): void {
  if (value === null) delete env[name];
  else env[name] = value;
}

/**
 * Recover the external network environment only where the inherited values
 * still equal a prior Clodex injection. Values changed by settings or another
 * wrapper layer remain authoritative.
 */
export function networkEnvBaseline(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const contract = parseNetworkEnvContract(baseEnv[NETWORK_ENV_CONTRACT_VAR]);
  delete env[NETWORK_ENV_CONTRACT_VAR];
  if (!contract) return env;

  for (const name of CHILD_NETWORK_ENV_VARS) {
    if (!(name in contract.original) || !(name in contract.injected)) continue;
    if (networkEnvValue(baseEnv, name) !== contract.injected[name]) continue;
    setNetworkEnvValue(env, name, contract.original[name] ?? null);
  }
  return env;
}

/**
 * Attach a compare-before-revert contract for the network values changed
 * between an external baseline and the child environment Clodex will launch.
 */
export function recordNetworkEnvMutation(
  baseline: NodeJS.ProcessEnv,
  injectedEnv: NodeJS.ProcessEnv,
): void {
  const original: NetworkEnvContract['original'] = {};
  const injected: NetworkEnvContract['injected'] = {};
  for (const name of CHILD_NETWORK_ENV_VARS) {
    const before = networkEnvValue(baseline, name);
    const after = networkEnvValue(injectedEnv, name);
    if (before === after) continue;
    original[name] = before;
    injected[name] = after;
  }
  if (Object.keys(original).length === 0) {
    delete injectedEnv[NETWORK_ENV_CONTRACT_VAR];
    return;
  }
  injectedEnv[NETWORK_ENV_CONTRACT_VAR] = JSON.stringify({
    version: 1,
    original,
    injected,
  } satisfies NetworkEnvContract);
}
