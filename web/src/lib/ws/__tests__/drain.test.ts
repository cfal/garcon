import { afterEach, describe, expect, it } from 'vitest';
import { WsConnection } from '../connection.svelte';
import { createDrainCursor } from '../drain';

const connections: WsConnection[] = [];

function connection() {
	const value = new WsConnection();
	connections.push(value);
	return value;
}

afterEach(() => {
	for (const value of connections.splice(0)) value.disconnect();
});

describe('WebSocket message retention', () => {
	it('releases one large consumed payload without waiting for more traffic', () => {
		const ws = connection();
		const reader = createDrainCursor(ws);
		const data = { type: 'synthetic', content: 'x'.repeat(200_000) };
		ws.messages.push({ data, timestamp: 0 });
		const drained = reader.drain();
		expect(drained[0].data).toBe(data);
		expect(ws.messages).toEqual([]);
		expect(ws.trimOffset).toBe(1);
		expect(reader.drain()).toEqual([]);
		reader.cleanup();
	});

	it('retains precisely the prefix still needed by another reader', () => {
		const ws = connection();
		const first = createDrainCursor(ws);
		const second = createDrainCursor(ws);
		ws.messages.push({ data: { id: 1 }, timestamp: 0 });
		expect(first.drain().map(({ data }) => data.id)).toEqual([1]);
		expect(ws.messages).toHaveLength(1);
		ws.messages.push({ data: { id: 2 }, timestamp: 0 });
		expect(second.drain().map(({ data }) => data.id)).toEqual([1, 2]);
		expect(ws.trimOffset).toBe(1);
		expect(ws.messages.map(({ data }) => data.id)).toEqual([2]);
		expect(first.drain().map(({ data }) => data.id)).toEqual([2]);
		expect(ws.messages).toEqual([]);
		expect(second.drain()).toEqual([]);
		first.cleanup();
		second.cleanup();
	});

	it("releases a removed reader's backlog and starts new readers at retained history", () => {
		const ws = connection();
		const first = createDrainCursor(ws);
		const removed = createDrainCursor(ws);
		ws.messages.push({ data: { id: 1 }, timestamp: 0 });
		first.drain();
		removed.cleanup();
		expect(ws.messages).toEqual([]);
		const next = createDrainCursor(ws);
		ws.messages.push({ data: { id: 2 }, timestamp: 0 });
		expect(next.drain().map(({ data }) => data.id)).toEqual([2]);
		first.cleanup();
		expect(ws.messages).toEqual([]);
		next.cleanup();
	});

	it('releases unread payloads on final disconnect', () => {
		const ws = connection();
		const reader = createDrainCursor(ws);
		ws.messages.push({ data: { id: 1 }, timestamp: 0 });
		ws.disconnect();
		expect(ws.messages).toEqual([]);
		expect(reader.drain()).toEqual([]);
		reader.cleanup();
	});
});
