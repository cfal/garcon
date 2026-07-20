import { describe, expect, it } from 'vitest';
import {
	GARCON_WS_AUTH_PROTOCOL_PREFIX,
	GARCON_WS_PROTOCOL,
	bearerTokenFromWebSocketProtocolHeader,
	webSocketProtocolsForAuth,
} from '$shared/ws-auth';

describe('WebSocket auth protocols', () => {
	it('formats bearer auth without putting the token in the URL', () => {
		expect(webSocketProtocolsForAuth('jwt-token')).toEqual([
			GARCON_WS_PROTOCOL,
			`${GARCON_WS_AUTH_PROTOCOL_PREFIX}jwt-token`,
		]);
	});

	it('omits invalid subprotocol tokens', () => {
		expect(webSocketProtocolsForAuth('bad token')).toEqual([GARCON_WS_PROTOCOL]);
	});

	it('parses the bearer token from the protocol header', () => {
		expect(
			bearerTokenFromWebSocketProtocolHeader(
				`${GARCON_WS_PROTOCOL}, ${GARCON_WS_AUTH_PROTOCOL_PREFIX}jwt-token`,
			),
		).toBe('jwt-token');
	});
});
