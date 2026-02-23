import { describe, it, expect, vi } from 'vitest';
import { handleRunningChats, extractRunningChatIds } from '../handlers/chat-sessions-running';
import type { RunningChatsContext } from '../handlers/chat-sessions-running';
import { ChatSessionsRunningMessage } from '$shared/ws-events';

function makeRunningChatsMsg(sessions: ChatSessionsRunningMessage['sessions']): ChatSessionsRunningMessage {
	return new ChatSessionsRunningMessage(sessions);
}

describe('extractRunningChatIds', () => {
	it('flattens provider-grouped sessions into a set of IDs', () => {
		const msg = new ChatSessionsRunningMessage({
			claude: [{ id: 'c1' }, { id: 'c2' }],
			codex: [{ id: 'x1' }],
			opencode: [],
		});

		const ids = extractRunningChatIds(msg);
		expect(ids).toEqual(new Set(['c1', 'c2', 'x1']));
	});

	it('filters out entries with missing IDs', () => {
		// Defensive: server contract guarantees id, but runtime data
		// could be malformed. Cast to exercise the guard path.
		const msg = {
			type: 'chat-sessions-running',
			sessions: {
				claude: [{ id: 'c1' }, { id: undefined }],
				codex: [{}],
				opencode: [],
			},
		} as unknown as ChatSessionsRunningMessage;

		const ids = extractRunningChatIds(msg);
		expect(ids).toEqual(new Set(['c1']));
	});

	it('handles empty sessions', () => {
		const msg = new ChatSessionsRunningMessage({ claude: [], codex: [], opencode: [] });

		const ids = extractRunningChatIds(msg);
		expect(ids.size).toBe(0);
	});

	it('handles missing sessions field', () => {
		// Defensive: cast to exercise the guard path.
		const msg = { type: 'chat-sessions-running' } as unknown as ChatSessionsRunningMessage;

		const ids = extractRunningChatIds(msg);
		expect(ids.size).toBe(0);
	});
});

describe('handleRunningChats', () => {
	it('calls reconcileProcessing with extracted chat IDs', () => {
		const reconcileProcessing = vi.fn();
		const ctx: RunningChatsContext = { reconcileProcessing };

		const msg = makeRunningChatsMsg({
			claude: [{ id: 'a' }],
			codex: [{ id: 'b' }],
			opencode: [],
		});

		handleRunningChats(msg, ctx);

		expect(reconcileProcessing).toHaveBeenCalledOnce();
		const receivedSet = reconcileProcessing.mock.calls[0][0] as Set<string>;
		expect(receivedSet).toEqual(new Set(['a', 'b']));
	});

	it('passes empty set when no running chats', () => {
		const reconcileProcessing = vi.fn();
		const ctx: RunningChatsContext = { reconcileProcessing };

		const msg = makeRunningChatsMsg({ claude: [], codex: [], opencode: [] });
		handleRunningChats(msg, ctx);

		const receivedSet = reconcileProcessing.mock.calls[0][0] as Set<string>;
		expect(receivedSet.size).toBe(0);
	});
});
