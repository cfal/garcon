export const GARCON_WS_PROTOCOL = 'garcon-v1';
export const GARCON_WS_AUTH_PROTOCOL_PREFIX = 'garcon-auth.';

const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function webSocketProtocolsForAuth(token: string | null | undefined): string[] {
  const protocols = [GARCON_WS_PROTOCOL];
  const trimmed = token?.trim();
  if (!trimmed) return protocols;

  const authProtocol = `${GARCON_WS_AUTH_PROTOCOL_PREFIX}${trimmed}`;
  if (HTTP_TOKEN_PATTERN.test(authProtocol)) {
    protocols.push(authProtocol);
  }
  return protocols;
}

export function parseWebSocketProtocolHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

export function webSocketProtocolHeaderContains(
  header: string | null | undefined,
  protocol: string,
): boolean {
  return parseWebSocketProtocolHeader(header).includes(protocol);
}

export function bearerTokenFromWebSocketProtocolHeader(
  header: string | null | undefined,
): string | null {
  const authProtocol = parseWebSocketProtocolHeader(header).find((protocol) =>
    protocol.startsWith(GARCON_WS_AUTH_PROTOCOL_PREFIX),
  );
  if (!authProtocol || authProtocol.length <= GARCON_WS_AUTH_PROTOCOL_PREFIX.length) return null;
  return authProtocol.slice(GARCON_WS_AUTH_PROTOCOL_PREFIX.length);
}
