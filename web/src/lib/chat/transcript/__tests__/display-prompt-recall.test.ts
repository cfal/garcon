import { expect, it, vi } from 'vitest';
import { AssistantMessage, UserMessage } from '$shared/chat-types';
import type { TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import { displayPromptRecall, displayPromptRecallIdentity } from '../display-prompt-recall.js';
import { PromptRecallController } from '$lib/chat/composer/prompt-recall.js';
import { displayOpen, displayCertificate, displayWindow, displayDetail, displayProfile, DISPLAY_TIME } from './display-fixtures.js';

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
	const source = displayPromptRecall(open, () => revision, api);
	const signal = new AbortController().signal;
	const [prompt] = await source.list(signal);
	revision = 'updated-patterns';
	expect(await source.load(prompt, signal)).toBe('Synthetic prompt');
	expect(api.bodies.mock.calls[0][0].profile.bashRevision).toBe('updated-patterns');
	expect(api.window.mock.calls[0][0].profile.bashRevision).toBe('updated-patterns');
});

it('waits for a finite source goal before freezing recall references across new source objects', async () => {
	const open = displayOpen('chat-1', 'view-1', 10);
	let prepared = 5;
	const api = {
		userRows: vi.fn<TranscriptDisplayApi['userRows']>(async request => ({ kind: 'available', serverInstanceId: open.serverInstanceId,
			chatId: open.chat.id, transcriptViewId: open.transcriptViewId, watermark: Math.min(prepared, request.atWatermark ?? prepared), sourceHead: prepared === 5 ? 10 : 20,
			rows: (prepared === 5 ? [2, 1] : [10, 2, 1]).map(ordinal => ({ ordinal, preview: `Prompt ${ordinal}`, timestamp: DISPLAY_TIME, attachmentCount: 0 })), nextBeforeOrdinal: null })),
		window: vi.fn<TranscriptDisplayApi['window']>(async request => displayWindow([], {
			...displayCertificate(open, request.profile), watermark: request.atWatermark!,
		})),
		bodies: vi.fn<TranscriptDisplayApi['bodies']>(async request => ({ certificate: request.certificate,
			details: request.seedOrdinals.map(ordinal => displayDetail(ordinal)),
			bodies: request.seedOrdinals.map(ordinal => ({ ordinal, message: new UserMessage(DISPLAY_TIME, `Prompt ${ordinal}`), submissionClientMessageId: null })),
			deferredOrdinals: [], oversizedOrdinal: null, nonRenderedOrdinals: [] })),
	} satisfies Pick<TranscriptDisplayApi, 'userRows' | 'window' | 'bodies'>;
	const history = new PromptRecallController();
	expect(await history.navigate('ArrowUp', 'chat:view', displayPromptRecall(open, () => 'patterns', api))).toBeNull();
	prepared = 20;
	expect(await history.navigate('ArrowUp', 'chat:view', displayPromptRecall({ ...open, sourceHead: 20 }, () => 'patterns', api))).toBe('Prompt 10');
	expect(await history.navigate('ArrowUp', 'chat:view', displayPromptRecall({ ...open, sourceHead: 30 }, () => 'patterns', api))).toBe('Prompt 2');
	expect(api.userRows.mock.calls[0][0]).not.toHaveProperty('atWatermark');
	expect(api.userRows.mock.calls[1][0].atWatermark).toBe(10);
	expect(api.userRows).toHaveBeenCalledTimes(2);
	expect(api.window.mock.calls.map(([request]) => request.atWatermark)).toEqual([10, 10]);
});

it('treats preparing recall as a quiet, retryable no-op', async () => {
	const open = displayOpen('chat-1', 'view-1', 10);
	const api = {
		userRows: vi.fn<TranscriptDisplayApi['userRows']>().mockResolvedValueOnce({ kind: 'preparing', serverInstanceId: open.serverInstanceId,
			chatId: open.chat.id, transcriptViewId: open.transcriptViewId, watermark: 0, sourceHead: 10, errorCode: null })
			.mockResolvedValue({ kind: 'available', serverInstanceId: open.serverInstanceId,
				chatId: open.chat.id, transcriptViewId: open.transcriptViewId, watermark: 10, sourceHead: 10,
				rows: [{ ordinal: 1, preview: 'Prompt', timestamp: DISPLAY_TIME, attachmentCount: 0 }], nextBeforeOrdinal: null }),
		window: vi.fn<TranscriptDisplayApi['window']>(), bodies: vi.fn<TranscriptDisplayApi['bodies']>(),
	} satisfies Pick<TranscriptDisplayApi, 'userRows' | 'window' | 'bodies'>;
	const source = displayPromptRecall(open, () => 'patterns', api), signal = new AbortController().signal;
	expect(await source.list(signal)).toEqual([]);
	expect(await source.list(signal)).toMatchObject([{ ordinal: 1 }]);
	expect(api.window).not.toHaveBeenCalled();
});

it('releases a partial recall source across a same-view process restart', async () => {
	let open = displayOpen('chat-1', 'view-1', 10);
	const api = {
		userRows: vi.fn<TranscriptDisplayApi['userRows']>(async () => ({ kind: 'available', serverInstanceId: open.serverInstanceId,
			chatId: open.chat.id, transcriptViewId: open.transcriptViewId, watermark: open.serverInstanceId === 'instance-1' ? 5 : 10, sourceHead: 10,
			rows: [{ ordinal: 1, preview: 'Prompt', timestamp: DISPLAY_TIME, attachmentCount: 0 }], nextBeforeOrdinal: null })),
		window: vi.fn<TranscriptDisplayApi['window']>(async request => displayWindow([], displayCertificate(open, request.profile))),
		bodies: vi.fn<TranscriptDisplayApi['bodies']>(async request => ({ certificate: request.certificate,
			details: [displayDetail(1)], bodies: [{ ordinal: 1, message: new UserMessage(DISPLAY_TIME, 'Prompt'), submissionClientMessageId: null }],
			deferredOrdinals: [], oversizedOrdinal: null, nonRenderedOrdinals: [] })),
	} satisfies Pick<TranscriptDisplayApi, 'userRows' | 'window' | 'bodies'>;
	const history = new PromptRecallController();
	const initialIdentity = displayPromptRecallIdentity(open)!;
	expect(history.canNavigate('ArrowUp', initialIdentity, '')).toBe(true);
	expect(await history.navigate('ArrowUp', initialIdentity, displayPromptRecall(open, () => 'patterns', api))).toBeNull();
	open = { ...open, serverInstanceId: 'instance-2' };
	const restartedIdentity = displayPromptRecallIdentity(open)!;
	expect(restartedIdentity).not.toBe(initialIdentity);
	expect(history.canNavigate('ArrowUp', restartedIdentity, '')).toBe(true);
	expect(await history.navigate('ArrowUp', restartedIdentity, displayPromptRecall(open, () => 'patterns', api))).toBe('Prompt');
	expect(api.userRows.mock.calls[1][0]).not.toHaveProperty('atWatermark');
});

it.each(['preparing', 'lagging', 'busy'] as const)('does not report %s prompt hydration as an error', async kind => {
	const open = displayOpen('chat-1', 'view-1', 10);
	const api = {
		userRows: vi.fn<TranscriptDisplayApi['userRows']>(),
		window: vi.fn<TranscriptDisplayApi['window']>(async request => ({ kind,
			...displayCertificate(open, request.profile), sourceHead: 10, preparedThrough: 0, errorCode: null, retryAfterMs: 1500 })),
		bodies: vi.fn<TranscriptDisplayApi['bodies']>(),
	} satisfies Pick<TranscriptDisplayApi, 'userRows' | 'window' | 'bodies'>;
	const source = displayPromptRecall(open, () => displayProfile.bashRevision, api);
	expect(await source.load({ ordinal: 1, watermark: 5 }, new AbortController().signal)).toBeNull();
	expect(api.bodies).not.toHaveBeenCalled();
});

it.each(['list-instance', 'list-view', 'window-instance', 'window-view', 'watermark', 'non-user'] as const)('rejects %s recall evidence', async defect => {
	const open = displayOpen('chat-1', 'view-1', 10);
	const api = {
		userRows: vi.fn<TranscriptDisplayApi['userRows']>(async () => ({ kind: 'available',
			serverInstanceId: defect === 'list-instance' ? 'foreign' : open.serverInstanceId, chatId: open.chat.id,
			transcriptViewId: defect === 'list-view' ? 'foreign' : open.transcriptViewId, watermark: 10, sourceHead: 10,
			rows: [{ ordinal: 1, preview: 'Synthetic prompt', timestamp: DISPLAY_TIME, attachmentCount: 0 }], nextBeforeOrdinal: null })),
		window: vi.fn<TranscriptDisplayApi['window']>(async request => displayWindow([], {
			...displayCertificate(open, request.profile), serverInstanceId: defect === 'window-instance' ? 'foreign' : open.serverInstanceId,
			transcriptViewId: defect === 'window-view' ? 'foreign' : open.transcriptViewId, watermark: defect === 'watermark' ? 9 : 10,
		})),
		bodies: vi.fn<TranscriptDisplayApi['bodies']>(async request => ({ certificate: request.certificate, details: [displayDetail(1)],
			bodies: [{ ordinal: 1, message: new AssistantMessage(DISPLAY_TIME, 'Not a user prompt'), submissionClientMessageId: null }],
			deferredOrdinals: [], oversizedOrdinal: null, nonRenderedOrdinals: [] })),
	} satisfies Pick<TranscriptDisplayApi, 'userRows' | 'window' | 'bodies'>;
	const source = displayPromptRecall(open, () => 'patterns', api), signal = new AbortController().signal;
	if (defect.startsWith('list')) await expect(source.list(signal)).rejects.toThrow('Transcript changed');
	else {
		const [prompt] = await source.list(signal);
		await expect(source.load(prompt, signal)).rejects.toThrow(defect === 'non-user' ? 'Prompt unavailable' : 'Transcript changed');
	}
	if (defect !== 'non-user') expect(api.bodies).not.toHaveBeenCalled();
});
