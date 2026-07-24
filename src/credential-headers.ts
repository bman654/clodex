const CREDENTIAL_BEARING_HEADER =
  /(?:^|[-_])(?:authorization|api[-_]?key|cookie|token|secret|credential)(?:$|[-_])/i;

export function isCredentialBearingHeader(name: string): boolean {
  return CREDENTIAL_BEARING_HEADER.test(name);
}
