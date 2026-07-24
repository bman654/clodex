export function routeUnavailableMessage(modelId: string): string {
  return `Clodex model route '${modelId}' is unavailable. Run \`clodex models --list\` to see available routes, or \`clodex patch\` to refresh saved aliases.`;
}
