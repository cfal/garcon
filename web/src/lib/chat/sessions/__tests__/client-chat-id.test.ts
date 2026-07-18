import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseChatId } from '$shared/chat-id';

const originalPerformance = globalThis.performance;

async function loadGenerator() {
	vi.resetModules();
	return import('$lib/chat/sessions/client-chat-id.js');
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.stubGlobal('performance', originalPerformance);
});

describe('createClientChatId', () => {
	it('uses the browser epoch clock and emits a canonical ID', async () => {
		vi.stubGlobal('performance', {
			timeOrigin: 1_783_725_900_000.25,
			now: () => 0.125,
		});
		const { createClientChatId } = await loadGenerator();

		const chatId = createClientChatId();

		expect(chatId).toBe('1783725900000375');
		expect(parseChatId(chatId)).toBe(chatId);
	});

	it('uses a canonical ID when the high-resolution clock is unavailable', async () => {
		vi.stubGlobal('performance', undefined);
		vi.spyOn(Date, 'now').mockReturnValue(1_783_725_900_000);
		const { createClientChatId } = await loadGenerator();

		expect(createClientChatId()).toBe('1783725900000000');
	});

	it('falls back to the epoch clock when the browser reports a non-epoch time origin', async () => {
		vi.stubGlobal('performance', {
			timeOrigin: 297_645_421.59,
			now: () => 32.755,
		});
		vi.spyOn(Date, 'now').mockReturnValue(1_783_725_900_000);
		const { createClientChatId } = await loadGenerator();

		expect(createClientChatId()).toBe('1783725900000000');
	});

	it('increments repeated observations monotonically', async () => {
		vi.stubGlobal('performance', {
			timeOrigin: 1_783_725_900_000,
			now: () => 0,
		});
		const { createClientChatId } = await loadGenerator();

		const first = createClientChatId();
		const second = createClientChatId();

		expect(BigInt(second)).toBe(BigInt(first) + 1n);
		expect(parseChatId(second)).toBe(second);
	});
});
