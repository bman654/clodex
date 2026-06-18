/** When true, relay-ai must not write UI to stdout (child owns NDJSON/JSONL). */

let agentStdoutMode = false;

export function setAgentStdoutMode(enabled: boolean): void {
  agentStdoutMode = enabled;
}

export function isAgentStdoutMode(): boolean {
  return agentStdoutMode;
}
