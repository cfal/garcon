import { describe, expect, it } from 'bun:test';
import {
  GARCON_WS_AUTH_PROTOCOL_PREFIX,
  GARCON_WS_PROTOCOL,
} from '../../../common/ws-auth.ts';
import { getWebSocketAuthToken, webSocketUpgradeHeaders } from '../websocket-auth.ts';

describe('websocket auth', () => {
  it('reads the bearer token from the WebSocket subprotocol header', () => {
    const request = new Request('http://localhost/ws?token=query-token', {
      headers: {
        'Sec-WebSocket-Protocol': `${GARCON_WS_PROTOCOL}, ${GARCON_WS_AUTH_PROTOCOL_PREFIX}protocol-token`,
      },
    });

    expect(getWebSocketAuthToken(request)).toBe('protocol-token');
  });

  it('prefers the Authorization header for non-browser clients', () => {
    const request = new Request('http://localhost/ws', {
      headers: {
        Authorization: 'Bearer header-token',
        'Sec-WebSocket-Protocol': `${GARCON_WS_PROTOCOL}, ${GARCON_WS_AUTH_PROTOCOL_PREFIX}protocol-token`,
      },
    });

    expect(getWebSocketAuthToken(request)).toBe('header-token');
  });

  it('selects the application subprotocol without echoing the bearer token', () => {
    const request = new Request('http://localhost/ws', {
      headers: {
        'Sec-WebSocket-Protocol': `${GARCON_WS_PROTOCOL}, ${GARCON_WS_AUTH_PROTOCOL_PREFIX}protocol-token`,
      },
    });

    expect(webSocketUpgradeHeaders(request)).toEqual({
      'Sec-WebSocket-Protocol': GARCON_WS_PROTOCOL,
    });
  });
});
