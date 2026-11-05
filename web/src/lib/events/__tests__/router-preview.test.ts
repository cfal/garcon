import { describe, expect, it, vi } from 'vitest';
import { applyTranscriptHeadActivity } from '$lib/chat/sessions/chat-message-batch-activity.js';
import { ChatTranscriptHeadUpdatedMessage, emptyResponseClassOrdinals } from '$shared/transcript-display-events';

const timestamp = '2026-01-01T00:00:00.000Z';
const activity = '2026-01-01T00:00:01.000Z';

describe('compact transcript activity', () => {
	it('uses the presented activity timestamp when the newest preview is older', () => {
		const sessions = { patchPreview: vi.fn(), patchActivity: vi.fn() };
		const head = new ChatTranscriptHeadUpdatedMessage('instance', 'chat', 'view', 10, activity,
			{ ordinal: 3, text: 'Synthetic preview', timestamp }, emptyResponseClassOrdinals(), 0, 0);
		expect(applyTranscriptHeadActivity(sessions, head)).toBe(activity);
		expect(sessions.patchPreview).toHaveBeenCalledWith('chat', 'Synthetic preview', activity);
		expect(sessions.patchActivity).not.toHaveBeenCalled();
	});

	it('preserves previews on tool-only activity and lifecycle-only heads', () => {
		const sessions = { patchPreview: vi.fn(), patchActivity: vi.fn() };
		for (const at of [activity, null]) {
			const head = new ChatTranscriptHeadUpdatedMessage('instance', 'chat', 'view', 10, at, null,
				emptyResponseClassOrdinals(), 0, 0);
			expect(applyTranscriptHeadActivity(sessions, head)).toBe(at);
		}
		expect(sessions.patchActivity).toHaveBeenCalledExactlyOnceWith('chat', activity);
		expect(sessions.patchPreview).not.toHaveBeenCalled();
	});
});
