import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import type {
	ChatPreambleSelectionTargetResponse,
	UpdateChatPreambleSelectionRequest,
} from '$shared/chat-preamble-selection-contracts';
import type { UpdateChatPreambleSelectionOutcome } from '$lib/api/chat-preambles';
import {
	ChatPreambleSelectionController,
} from '$lib/preambles/chat-selection-controller.svelte';
import { createChatPreambleSelectionInvalidationHub } from '$lib/preambles/chat-selection-invalidation-hub';
import type { PreambleId, PreambleSelectionProjection } from '$shared/preambles';

const CHAT_ID = '1783725900000200';
const OTHER_CHAT_ID = '1783725900000299';
const VIEW_ID = '12345678-1234-4123-8123-123456789abc';
const OTHER_VIEW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_A: PreambleId = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const ID_B: PreambleId = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';

function projection(
	eligible: readonly { id: PreambleId; title: string }[] = [],
	unavailable: readonly { id: PreambleId; reason: 'missing' | 'disabled' | 'out-of-scope' }[] = [],
): PreambleSelectionProjection {
	return {
		catalogRevision: 1,
		eligiblePreambles: eligible,
		unavailable,
	};
}

function loadResponse(
	ids: readonly PreambleId[],
	revision: number,
	chatId = CHAT_ID,
	transcriptViewId = VIEW_ID,
) {
	return {
		success: true as const,
		chatId,
		transcriptViewId,
		canonicalProjectPath: '/repo',
		selection: { revision, orderedPreambleIds: ids },
		projection: projection(
			ids.map((id) => ({ id, title: `Title ${id}` })),
		),
	};
}

/** Seams matching the production transport ports. */
type LoadPort = (
	chatId: string,
	expectedTranscriptViewId?: string,
) => Promise<ChatPreambleSelectionTargetResponse>;
type SavePort = (
	request: UpdateChatPreambleSelectionRequest,
) => Promise<UpdateChatPreambleSelectionOutcome>;

function makeController(options: { load?: LoadPort; save?: SavePort } = {}) {
	const hub = createChatPreambleSelectionInvalidationHub();
	let requestCounter = 0;
	const controller = new ChatPreambleSelectionController({
		hub,
		newRequestId: () => `request-${++requestCounter}`,
		load: options.load ?? (async () => loadResponse([], 0)),
		save: options.save,
	});
	return { controller, hub };
}

describe('ChatPreambleSelectionController', () => {
	it('loads the saved selection and marks the editor ready', async () => {
		const load = vi.fn(async () => loadResponse([ID_A], 3));
		const { controller } = makeController({ load });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		expect(load).toHaveBeenCalledWith(CHAT_ID, VIEW_ID);
		expect(controller.status).toBe('ready');
		expect(controller.draftIds).toEqual([ID_A]);
		expect(controller.dirty).toBe(false);
		expect(controller.canonicalProjectPath).toBe('/repo');
	});

	it('ignores a stale load response after retargeting', async () => {
		let releaseFirst: ((value: unknown) => void) | undefined;
		const first = new Promise((resolve) => {
			releaseFirst = resolve;
		});
		const load = vi.fn()
			.mockImplementationOnce(() => first)
			.mockImplementationOnce(async () => loadResponse(
				[ID_B],
				1,
				OTHER_CHAT_ID,
				OTHER_VIEW_ID,
			));
		const { controller } = makeController({ load });
		const opening = controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		void controller.open({ chatId: OTHER_CHAT_ID, transcriptViewId: OTHER_VIEW_ID });
		releaseFirst?.(loadResponse([ID_A], 9));
		await opening;
		expect(controller.chatId).toBe(OTHER_CHAT_ID);
		expect(controller.draftIds).toEqual([ID_B]);
	});

	it('keeps a dirty draft and reports a conflict on external invalidation', async () => {
		const { controller, hub } = makeController();
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		controller.add(ID_A);
		expect(controller.dirty).toBe(true);

		hub.publish({ kind: 'selection', chatId: CHAT_ID, revision: 1 });
		expect(controller.conflict).toEqual({ revision: 1 });
		expect(controller.draftIds).toEqual([ID_A]);
		expect(controller.status).toBe('ready');
	});

	it('refreshes a clean editor on external invalidation', async () => {
		let latest = loadResponse([], 0);
		const load = vi.fn(async () => latest);
		const { controller, hub } = makeController({ load });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		expect(load).toHaveBeenCalledTimes(1);

		latest = loadResponse([ID_B], 2);
		hub.publish({ kind: 'selection', chatId: CHAT_ID, revision: 2 });
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(controller.baseRevision).toBe(2));
		expect(controller.draftIds).toEqual([ID_B]);
		expect(controller.conflict).toBeNull();
	});

	it('ignores stale revisions and foreign chats', async () => {
		const load = vi.fn(async () => loadResponse([ID_A], 5));
		const { controller, hub } = makeController({ load });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		hub.publish({ kind: 'selection', chatId: CHAT_ID, revision: 4 });
		hub.publish({ kind: 'selection', chatId: OTHER_CHAT_ID, revision: 9 });
		expect(controller.conflict).toBeNull();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('treats a same-revision self-invalidation as a no-op', async () => {
		const load = vi.fn(async () => loadResponse([ID_A], 1));
		const { controller, hub } = makeController({ load });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		hub.publish({ kind: 'selection', chatId: CHAT_ID, revision: 1 });
		expect(load).toHaveBeenCalledTimes(1);
		expect(controller.conflict).toBeNull();
	});

	it('adopts a committed save before reconciling a deferred invalidation', async () => {
		let releaseSave: ((outcome: UpdateChatPreambleSelectionOutcome) => void) | undefined;
		const save = vi.fn<SavePort>(() => new Promise((resolve) => {
			releaseSave = resolve;
		}));
		const load = vi.fn(async () => loadResponse([], 0));
		const { controller, hub } = makeController({ load, save });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		controller.add(ID_A);
		const saving = controller.save();
		hub.publish({ kind: 'selection', chatId: CHAT_ID, revision: 1 });
		releaseSave?.({
			kind: 'committed',
			response: {
				success: true,
				commandType: 'chat-preambles-update',
				clientRequestId: 'request-1',
				clientMessageId: 'request-2',
				chatId: CHAT_ID,
				transcriptViewId: VIEW_ID,
				status: 'updated',
				mutationRevision: 1,
				noticeOrdinal: 4,
				selection: { revision: 1, orderedPreambleIds: [ID_A] },
				projection: projection([{ id: ID_A, title: `Title ${ID_A}` }]),
			},
		});
		await expect(saving).resolves.toBe(true);
		expect(controller.baseRevision).toBe(1);
		expect(controller.conflict).toBeNull();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('refreshes after a higher revision arrives during a committed save', async () => {
		let releaseSave: ((outcome: UpdateChatPreambleSelectionOutcome) => void) | undefined;
		const save = vi.fn<SavePort>(() => new Promise((resolve) => {
			releaseSave = resolve;
		}));
		const load = vi.fn<LoadPort>()
			.mockResolvedValueOnce(loadResponse([], 0))
			.mockResolvedValueOnce(loadResponse([ID_B], 2));
		const { controller, hub } = makeController({ load, save });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		controller.add(ID_A);
		const saving = controller.save();
		hub.publish({ kind: 'selection', chatId: CHAT_ID, revision: 2 });
		releaseSave?.({
			kind: 'committed',
			response: {
				success: true,
				commandType: 'chat-preambles-update',
				clientRequestId: 'request-1',
				clientMessageId: 'request-2',
				chatId: CHAT_ID,
				transcriptViewId: VIEW_ID,
				status: 'updated',
				mutationRevision: 1,
				noticeOrdinal: 4,
				selection: { revision: 1, orderedPreambleIds: [ID_A] },
				projection: projection([{ id: ID_A, title: `Title ${ID_A}` }]),
			},
		});
		await saving;
		await vi.waitFor(() => expect(controller.baseRevision).toBe(2));
		expect(controller.draftIds).toEqual([ID_B]);
	});

	it('refreshes on reconnect while preserving a dirty draft', async () => {
		const load = vi.fn<LoadPort>()
			.mockResolvedValueOnce(loadResponse([], 0))
			.mockResolvedValueOnce(loadResponse([ID_B], 1));
		const { controller, hub } = makeController({ load });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		controller.add(ID_A);
		hub.publishReconnect();
		await vi.waitFor(() => expect(controller.baseRevision).toBe(1));
		expect(controller.draftIds).toEqual([ID_A]);
		expect(controller.conflict).toEqual({ revision: 1 });
	});

	it('retains save identity and payload across a transport-ambiguous retry', async () => {
		const save = vi.fn<SavePort>()
			.mockImplementationOnce(async () => {
				throw new Error('network dropped');
			})
			.mockImplementationOnce(async () => ({
				kind: 'committed' as const,
				response: {
					success: true as const,
					commandType: 'chat-preambles-update' as const,
					clientRequestId: 'request-1',
					clientMessageId: 'request-2',
					chatId: CHAT_ID,
					transcriptViewId: VIEW_ID,
					status: 'duplicate' as const,
					mutationRevision: 1,
					noticeOrdinal: 4,
					selection: { revision: 1, orderedPreambleIds: [ID_A] },
					projection: projection([{ id: ID_A, title: `Title ${ID_A}` }]),
				},
			}));
		const { controller } = makeController({ save });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		controller.add(ID_A);

		await expect(controller.save()).resolves.toBe(false);
		expect(controller.status).toBe('ready');
		expect(controller.error).toBe('network dropped');
		await expect(controller.save()).resolves.toBe(true);

		const first = save.mock.calls[0]?.[0] as UpdateChatPreambleSelectionRequest;
		const second = save.mock.calls[1]?.[0] as UpdateChatPreambleSelectionRequest;
		expect(second.clientRequestId).toBe(first.clientRequestId);
		expect(second.clientMessageId).toBe(first.clientMessageId);
		expect(second.orderedPreambleIds).toEqual(first.orderedPreambleIds);
		expect(second.expectedRevision).toBe(first.expectedRevision);
	});

	it('starts a new intent when the draft changes after a failed attempt', async () => {
		const save = vi.fn<SavePort>(async () => {
			throw new Error('network dropped');
		});
		const { controller } = makeController({ save });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		controller.add(ID_A);
		await expect(controller.save()).resolves.toBe(false);
		controller.add(ID_B);
		await expect(controller.save()).resolves.toBe(false);
		const secondRequest = save.mock.calls[1]?.[0] as UpdateChatPreambleSelectionRequest;
		const firstRequest = save.mock.calls[0]?.[0] as UpdateChatPreambleSelectionRequest;
		expect(secondRequest.clientRequestId).not.toBe(firstRequest.clientRequestId);
	});

	it('adopts a committed selection after a notice failure and stays editable', async () => {
		const save = vi.fn(async () => ({
			kind: 'partial' as const,
			partial: {
				success: false as const,
				errorCode: 'PREAMBLE_SELECTION_NOTICE_FAILED' as const,
				message: 'The selection was saved, but its transcript notice could not be recorded.',
				retryable: false,
				selectionCommitted: true as const,
				selection: { revision: 1, orderedPreambleIds: [ID_A] },
			},
		}));
		const { controller } = makeController({ save });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		controller.add(ID_A);
		await expect(controller.save()).resolves.toBe(false);
		expect(controller.status).toBe('ready');
		expect(controller.partialWarning).toMatchObject({ committed: true });
		expect(controller.baseRevision).toBe(1);
		expect(controller.draftIds).toEqual([ID_A]);
	});

	it('gates editing after unknown durability and recovers through refresh', async () => {
		let saveOutcome: unknown = {
			kind: 'partial',
			partial: {
				success: false,
				errorCode: 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
				message: 'The selection was saved, but its durability could not be confirmed.',
				retryable: false,
				selectionCommitted: 'unknown',
			},
		};
		const save = vi.fn<SavePort>(async () => saveOutcome as UpdateChatPreambleSelectionOutcome);
		let failReconcile = false;
		let reconciledOnce = false;
		const load = vi.fn(async () => {
			if (failReconcile) throw new Error('reconciliation unavailable');
			// Until reconciliation succeeds, the server keeps reporting the
			// original saved state; afterwards it reflects the committed one.
			if (!reconciledOnce) return loadResponse([], 0);
			return loadResponse([ID_A], 1);
		});
		const { controller } = makeController({ load, save });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		controller.add(ID_A);

		await expect(controller.save()).resolves.toBe(false);
		expect(controller.status).toBe('refresh-required');
		expect(controller.canSave).toBe(false);
		// A dirty draft is preserved through the refresh-gated state.
		expect(controller.draftIds).toEqual([ID_A]);

		// Reconciliation still failing keeps the gate closed.
		failReconcile = true;
		await expect(controller.refreshBase()).resolves.toBe(false);
		expect(controller.status).toBe('refresh-required');
		failReconcile = false;

		saveOutcome = {
			kind: 'committed',
			response: {
				success: true,
				commandType: 'chat-preambles-update',
				clientRequestId: 'request-3',
				clientMessageId: 'request-4',
				chatId: CHAT_ID,
				transcriptViewId: VIEW_ID,
				status: 'updated',
				mutationRevision: 2,
				noticeOrdinal: 5,
				selection: { revision: 2, orderedPreambleIds: [ID_A] },
				projection: projection([{ id: ID_A, title: `Title ${ID_A}` }]),
			},
		};
		reconciledOnce = true;
		await expect(controller.refreshBase()).resolves.toBe(true);
		expect(controller.status).toBe('ready');
		expect(controller.baseRevision).toBe(1);
		// The pending identity from the ambiguous attempt is cleared by the
		// reconciled base; a new edit saves against the reconciled revision.
		controller.add(ID_B);
		await expect(controller.save()).resolves.toBe(true);
		expect(save.mock.calls[1]![0].expectedRevision).toBe(1);
		const secondRequest = save.mock.calls[1]?.[0] as UpdateChatPreambleSelectionRequest;
		const firstRequest = save.mock.calls[0]?.[0] as UpdateChatPreambleSelectionRequest;
		expect(secondRequest.clientRequestId).not.toBe(firstRequest.clientRequestId);
	});

	it('maps revision and idempotency conflicts to a rebasable conflict state', async () => {
		const save = vi.fn<SavePort>(async () => {
			throw new ApiError(409, 'changed', 'PREAMBLE_SELECTION_REVISION_CONFLICT');
		});
		const { controller } = makeController({ save });
		await controller.open({ chatId: CHAT_ID, transcriptViewId: VIEW_ID });
		controller.add(ID_A);
		await expect(controller.save()).resolves.toBe(false);
		expect(controller.status).toBe('ready');
		expect(controller.error).toBeNull();
		expect(controller.conflict).toEqual({ revision: 0 });
		// Refresh preserves the dirty draft while rebasing the revision.
		await expect(controller.refreshBase()).resolves.toBe(true);
		expect(controller.draftIds).toEqual([ID_A]);
		expect(controller.dirty).toBe(true);
	});
});
