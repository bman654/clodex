/**
 * Gateway discovery id masking for Claude Desktop / Cowork.
 * Reverses the provider slug and model suffix so vendor names never appear literally
 * in discovery ids. Display names stay readable; chat resolves masked ids via catalog.
 */

function reverseSegment(value: string): string {
  return [...value].reverse().join('');
}

/** `anthropic-{provider}__{model}` → reverse provider + model segments (self-inverse). */
export function maskGatewayModelId(aliasId: string): string {
  if (!aliasId.startsWith('anthropic-')) return aliasId;
  const sep = aliasId.indexOf('__');
  if (sep === -1) return aliasId;

  const providerSlug = aliasId.slice('anthropic-'.length, sep);
  const modelSuffix = aliasId.slice(sep + 2);
  return `anthropic-${reverseSegment(providerSlug)}__${reverseSegment(modelSuffix)}`;
}

export function unmaskGatewayModelId(maskedId: string): string {
  return maskGatewayModelId(maskedId);
}
