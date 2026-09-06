import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getChatPreambleSelection,
	preambleSelectionPreview,
	updateChatPreambleSelection,
} from '../chat-preambles.js';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

const CHAT_ID = '1783725900000200';
const VIEW_ID = '12345678-1234-4123-8123-123456789abc';
const PREAMBLE_ID = '3502b645-222b-49d2-ac39-1c91f9fb1174';

function projection() {
	return {
		catalogRevision: 1,
		eligiblePreambles: [{ id: PREAMBLE_ID, title: 'Repository conventions' }],
		unavailable: [],
	};
}

function targetResponse(overrides: Record<string, unknown> = {}) {
	return {
		success: true,
		chatId: CHAT_ID,
		transcriptViewId: VIEW_ID,
		canonicalProjectPath: '/repo',
		selection: { revision: 1, orderedPreambleIds: [PREAMBLE_ID] },
		projection: projection(),
		...overrides,
	};
}

function updateResponse(overrides: Record<string, unknown> = {}) {
	return {
		success: true,
		commandType: 'chat-preambles-update',
		clientRequestId: 'request-1',
		clientMessageId: 'message-1',
		chatId: CHAT_ID,
		transcriptViewId: VIEW_ID,
		status: 'updated',
		mutationRevision: 1,
		noticeOrdinal: 4,
		selection: { revision: 1, orderedPreambleIds: [PREAMBLE_ID] },
		projection: projection(),
		...overrides,
	};
}

describe('chat preamble selection API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => vi.restoreAllMocks());

	it('requires the captured chat and transcript view on target reads', async () => {
		fetchMock.mockResolvedValueOnce(Response.json(targetResponse()));
		await expect(getChatPreambleSelection(CHAT_ID, VIEW_ID)).resolves.toMatchObject({
			chatId: CHAT_ID,
			transcriptViewId: VIEW_ID,
		});

		fetchMock.mockResolvedValueOnce(Response.json(targetResponse({ chatId: '1783725900000299' })));
		await expect(getChatPreambleSelection(CHAT_ID, VIEW_ID)).rejects.toThrow(
			'Invalid chat preamble selection response',
		);
		fetchMock.mockResolvedValueOnce(Response.json(targetResponse({
			transcriptViewId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		})));
		await expect(getChatPreambleSelection(CHAT_ID, VIEW_ID)).rejects.toThrow(
			'Invalid chat preamble selection response',
		);
	});

	it('requires every echoed update identity', async () => {
		const request = {
			chatId: CHAT_ID,
			transcriptViewId: VIEW_ID,
			clientRequestId: 'request-1',
			clientMessageId: 'message-1',
			expectedRevision: 0,
			orderedPreambleIds: [PREAMBLE_ID],
		};
		fetchMock.mockResolvedValueOnce(Response.json(updateResponse()));
		await expect(updateChatPreambleSelection(request)).resolves.toMatchObject({ kind: 'committed' });

		for (const mismatch of [
			{ chatId: '1783725900000299' },
			{ transcriptViewId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
			{ clientRequestId: 'request-2' },
			{ clientMessageId: 'message-2' },
		]) {
			fetchMock.mockResolvedValueOnce(Response.json(updateResponse(mismatch)));
			await expect(updateChatPreambleSelection(request)).rejects.toThrow(
				'Invalid chat preamble selection update response',
			);
		}
	});

	it('requires an explicit preview to echo the exact requested order', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({
			success: true,
			canonicalProjectPath: '/repo',
			orderedPreambleIds: [],
			projection: { catalogRevision: 1, eligiblePreambles: [], unavailable: [] },
		}));
		await expect(preambleSelectionPreview({
			projectPath: '/repo',
			orderedPreambleIds: [PREAMBLE_ID],
		})).rejects.toThrow('Invalid preamble selection preview response');
	});
});
