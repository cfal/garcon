import { WsConnection } from '../connection.svelte.js';

export function openPushFixture() {
	const original = globalThis.WebSocket;
	let deliver: ((data: unknown) => void) | undefined;
	class TestSocket extends EventTarget {
		static readonly CLOSED = 3;
		readonly readyState = 1;
		onmessage: ((event: MessageEvent) => void) | null = null;

		constructor() {
			super();
			deliver = (data) =>
				this.onmessage?.(
					new MessageEvent('message', {
						data: JSON.stringify(data),
					}),
				);
		}

		close() {}
	}
	Object.defineProperty(globalThis, 'WebSocket', {
		configurable: true,
		writable: true,
		value: TestSocket,
	});
	const ws = new WsConnection();
	ws.connect(null, true);
	return {
		ws,
		send(data: unknown) {
			if (!deliver) throw new Error('WebSocket was not created');
			deliver(data);
		},
		close() {
			ws.disconnect();
			Object.defineProperty(globalThis, 'WebSocket', {
				configurable: true,
				writable: true,
				value: original,
			});
		},
	};
}
