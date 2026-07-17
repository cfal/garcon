import { describe, it, expect } from 'vitest';
import { extractRunningChatIds } from '$lib/ws/reconnect-state';
import { ReconnectStateMessage } from '$shared/ws-events';

describe('extractRunningChatIds', () => {
	it('flattens provider-grouped sessions into a set of IDs', () => {
		const msg = new ReconnectStateMessage({
			claude: [{ id: 'c1' }, { id: 'c2' }],
			codex: [{ id: 'x1' }],
			'direct-anthropic-compatible': [{ id: 'a1' }],
			'direct-openai-compatible': [{ id: 'd1' }],
			'direct-openai-responses-compatible': [{ id: 'r1' }],
			custom_provider: [{ id: 'custom-1' }],
		}, []);

		const ids = extractRunningChatIds(msg);
		expect(ids).toEqual(new Set(['c1', 'c2', 'x1', 'a1', 'd1', 'r1', 'custom-1']));
	});

	it('filters out entries with missing IDs', () => {
		// Defensive: server contract guarantees id, but runtime data
		// could be malformed. Cast to exercise the guard path.
		const msg = {
			type: 'reconnect-state',
			sessions: {
				claude: [{ id: 'c1' }, { id: undefined }],
				codex: [{}],
				opencode: [],
			},
		} as unknown as ReconnectStateMessage;

		const ids = extractRunningChatIds(msg);
		expect(ids).toEqual(new Set(['c1']));
	});

	it('handles empty sessions', () => {
		const msg = new ReconnectStateMessage({}, []);

		const ids = extractRunningChatIds(msg);
		expect(ids.size).toBe(0);
	});

	it('handles missing sessions field', () => {
		// Defensive: cast to exercise the guard path.
		const msg = { type: 'reconnect-state' } as unknown as ReconnectStateMessage;

		const ids = extractRunningChatIds(msg);
		expect(ids.size).toBe(0);
	});
});
