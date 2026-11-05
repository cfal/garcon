import { expect, it, vi } from 'vitest';
import { UserMessage } from '$shared/chat-types';
import type { TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import { displayPromptRecall } from '../display-prompt-recall.js';
import { displayOpen, displayCertificate, displayWindow, displayDetail, DISPLAY_TIME } from './display-fixtures.js';

it('reads recalled bodies using the live Bash revision rather than the activation snapshot', async () => {
	const open = displayOpen('chat-1', 'view-1', 10);
	let revision = open.display.bashRevision;
	const api = {
		userRows: vi.fn<TranscriptDisplayApi['userRows']>(async () => ({ kind: 'available', serverInstanceId: open.serverInstanceId,
			chatId: open.chat.id, transcriptViewId: open.transcriptViewId, watermark: 10, sourceHead: 10,
			rows: [{ ordinal: 1, preview: 'Synthetic prompt', timestamp: DISPLAY_TIME, attachmentCount: 0 }], nextBeforeOrdinal: null })),
		window: vi.fn<TranscriptDisplayApi['window']>(async request => displayWindow([], displayCertificate(open, request.profile))),
		bodies: vi.fn<TranscriptDisplayApi['bodies']>(async request => ({ certificate: request.certificate,
			details: [displayDetail(1)], bodies: [{ ordinal: 1, message: new UserMessage(DISPLAY_TIME, 'Synthetic prompt'), submissionClientMessageId: null }],
			deferredOrdinals: [], oversizedOrdinal: null, nonRenderedOrdinals: [] })),
	} satisfies Pick<TranscriptDisplayApi, 'userRows' | 'window' | 'bodies'>;
	const source = displayPromptRecall(open, 10, () => revision, api);
	const signal = new AbortController().signal;
	await source.list(signal);
	revision = 'updated-patterns';
	expect(await source.load(1, signal)).toBe('Synthetic prompt');
	expect(api.bodies.mock.calls[0][0].profile.bashRevision).toBe('updated-patterns');
	expect(api.window.mock.calls[0][0].profile.bashRevision).toBe('updated-patterns');
});
