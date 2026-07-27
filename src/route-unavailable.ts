export function routeUnavailableMessage(modelId: string, reason?: string): string {
  const detail = reason ? `: ${reason}` : '';
  return `Clodex model route '${modelId}' is unavailable${detail}. Run \`clodex models --list\` to inspect saved routes and aliases.`;
}
