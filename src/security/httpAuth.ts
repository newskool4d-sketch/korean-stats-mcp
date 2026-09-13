import { timingSafeEqual } from 'node:crypto';

export function assertHttpAuthConfigured(token: string, allowInsecurePublic: boolean): void {
  if (!token && !allowInsecurePublic) {
    throw new Error(
      'MCP_AUTH_TOKEN is required for the HTTP transport. ' +
        'Set MCP_ALLOW_INSECURE_PUBLIC=1 only for an explicitly public development server.'
    );
  }
}

export function isBearerAuthorized(authorization: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false;
  const suppliedToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
