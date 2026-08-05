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

export const ORIGINAL_NETWORK_ENV_VAR = 'CLODEX_ORIGINAL_NETWORK_ENV';
