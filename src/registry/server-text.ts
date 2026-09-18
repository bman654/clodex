// src/registry/server-text.ts — text a provider's server chose, made safe to store and print

/**
 * C0 controls, DEL and the C1 range (code 0x9b is an 8-bit CSI introducer, so
 * removing ESC alone is not enough). Anything else, including bidirectional and
 * zero-width characters, can only mislead a label and is left alone.
 */
function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** True when the value has a character a terminal could act on. */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControlCode(value.charCodeAt(i))) return true;
  }
  return false;
}

/** Server text made safe to print: each control character becomes a space. */
export function printableServerText(value: string): string {
  let out = '';
  for (const ch of value) out += isControlCode(ch.charCodeAt(0)) ? ' ' : ch;
  return out.trim();
}
