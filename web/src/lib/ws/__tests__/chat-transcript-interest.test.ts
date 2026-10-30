import { describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { PrimaryWsClientMessage } from '$shared/ws-protocol';
import type { TranscriptInterestConnectionPort } from '../chat-transcript-interest.svelte.js';
import type { WsConnectionListener } from '../connection.svelte.js';
import { mountTranscriptInterest } from './chat-transcript-interest-harness.svelte.js';

function connectionDouble(connected = true) {
	const listeners = new Set<WsConnectionListener>();
	const sent: PrimaryWsClientMessage[] = [];
	const connection = {
		isConnected: connected,
		sendMessage: vi.fn((message: PrimaryWsClientMessage) => {
			if (!connection.isConnected) return false;
			sent.push(message);
			return true;
		}),
		onConnectionChange: vi.fn((listener: WsConnectionListener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	} satisfies TranscriptInterestConnectionPort;
	return {
		connection,
		declared: () => sent.map((message) => ('chatIds' in message ? message.chatIds : null)),
		transition(next: boolean) {
			connection.isConnected = next;
			for (const listener of listeners) listener(next);
		},
		listenerCount: () => listeners.size,
	};
}

describe('ChatTranscriptInterestController', () => {
	it('declares each changed displayed set once', () => {
		const socket = connectionDouble();
		const interest = mountTranscriptInterest(socket.connection);
		flushSync();

		interest.display(['chat-b', 'chat-a']);
		flushSync();
		interest.display(['chat-a', 'chat-b', 'chat-a']);
		flushSync();

		expect(socket.declared()).toEqual([['chat-a', 'chat-b']]);
		interest.cleanup();
	});

	it('sends only the latest set after rapid switching', () => {
		const socket = connectionDouble();
		const interest = mountTranscriptInterest(socket.connection);

		interest.display(['chat-a']);
		interest.display(['chat-b']);
		interest.display(['chat-c']);
		flushSync();

		expect(socket.declared().at(-1)).toEqual(['chat-c']);
		expect(socket.declared()).not.toContainEqual(['chat-a', 'chat-c']);
		interest.cleanup();
	});

	it('re-declares on every new socket and not on the old one', () => {
		const socket = connectionDouble();
		const interest = mountTranscriptInterest(socket.connection);
		interest.display(['chat-a']);
		flushSync();

		socket.transition(false);
		interest.display(['chat-a', 'chat-b']);
		flushSync();
		expect(socket.declared()).toEqual([['chat-a']]);

		socket.transition(true);
		expect(socket.declared()).toEqual([['chat-a'], ['chat-a', 'chat-b']]);
		socket.transition(false);
		socket.transition(true);
		expect(socket.declared()).toEqual([['chat-a'], ['chat-a', 'chat-b'], ['chat-a', 'chat-b']]);
		interest.cleanup();
	});

	it('does not announce an empty set to a fresh socket', () => {
		const socket = connectionDouble();
		const interest = mountTranscriptInterest(socket.connection);
		flushSync();
		socket.transition(false);
		socket.transition(true);

		expect(socket.declared()).toEqual([]);
		interest.cleanup();
	});

	it('withdraws interest and its listener when unmounted', () => {
		const socket = connectionDouble();
		const interest = mountTranscriptInterest(socket.connection);
		interest.display(['chat-a']);
		flushSync();

		interest.cleanup();

		expect(socket.declared()).toEqual([['chat-a'], []]);
		expect(socket.listenerCount()).toBe(0);
	});
});
