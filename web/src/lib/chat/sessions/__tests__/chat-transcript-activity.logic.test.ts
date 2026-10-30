import { describe, expect, it, vi } from 'vitest';
import type { ChatTranscriptActivity } from '$shared/chat-transcript-activity';
import {
	applyChatTranscriptActivity,
	type ChatTranscriptActivityPort,
} from '../chat-transcript-activity.js';

function sessionsDouble() {
	return {
		patchPreview: vi.fn(),
		patchActivity: vi.fn(),
	} satisfies ChatTranscriptActivityPort;
}

function activity(overrides: Partial<ChatTranscriptActivity> = {}): ChatTranscriptActivity {
	return {
		preview: null,
		lastActivityAt: null,
		planModeEntered: false,
		planExitRequests: [],
		...overrides,
	};
}

describe('applyChatTranscriptActivity', () => {
	it('patches the preview at the span activity time', () => {
		const sessions = sessionsDouble();

		const latest = applyChatTranscriptActivity(
			sessions,
			'chat-1',
			activity({
				preview: { content: 'answer', timestamp: '2024-01-01T00:00:01Z' },
				lastActivityAt: '2024-01-01T00:00:02Z',
			}),
		);

		expect(latest).toBe('2024-01-01T00:00:02Z');
		expect(sessions.patchPreview).toHaveBeenCalledWith('chat-1', 'answer', '2024-01-01T00:00:02Z');
		expect(sessions.patchActivity).not.toHaveBeenCalled();
	});

	it('advances activity without a preview', () => {
		const sessions = sessionsDouble();

		applyChatTranscriptActivity(
			sessions,
			'chat-1',
			activity({ lastActivityAt: '2024-01-01T00:00:02Z' }),
		);

		expect(sessions.patchPreview).not.toHaveBeenCalled();
		expect(sessions.patchActivity).toHaveBeenCalledWith('chat-1', '2024-01-01T00:00:02Z');
	});

	it('leaves the chat list untouched for spans without activity', () => {
		const sessions = sessionsDouble();

		expect(applyChatTranscriptActivity(sessions, 'chat-1', activity())).toBeNull();
		expect(sessions.patchPreview).not.toHaveBeenCalled();
		expect(sessions.patchActivity).not.toHaveBeenCalled();
	});
});
