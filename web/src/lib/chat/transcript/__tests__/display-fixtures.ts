import { vi } from 'vitest';
import { AssistantMessage, type ChatMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import { displayCutsKey, displayProfileKey, type AvailableDisplayWindow, type DisplayCertificate, type DisplayDescriptor, type DisplayProfile, type RowDetails } from '$shared/transcript-display-contract';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { transcriptDisplayApi } from '$lib/api/transcript-display.js';
import type { ActiveTranscriptState } from '../active-transcript-state.svelte.js';

export const DISPLAY_TIME = '2026-01-01T00:00:00.000Z';
export const displayProfile: DisplayProfile = { combine: true, showThinking: true, hiddenToolGroups: [], bashRevision: 'patterns' };

export async function installDisplayOpen(transcript: ActiveTranscriptState, chatId: string): Promise<void> {
	if (transcript.activeChatId !== chatId) transcript.activateChat(chatId);
	transcript.installOpen(await transcriptDisplayApi.open({ chatId, reason: 'reconnect', outstandingClientMessageIds: [] }));
	await transcript.controller.refresh();
}

export function displayOpen(chatId = 'chat-1', view = 'view-1', head = 0, instance = 'instance-1'): DisplayOpenResponse {
	return {
		serverInstanceId: instance, transcriptViewId: view, sourceHead: head,
		chat: { id: chatId, title: 'Synthetic chat', agentId: 'claude', agentOwnershipEpoch: 'epoch-1', carryOverRevision: 'carry-1',
			model: null, apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
			projectPath: '/workspace', tags: [], canReloadFromNativeHistory: false, activity: { createdAt: DISPLAY_TIME, lastActivityAt: DISPLAY_TIME } },
		display: { policyRevision: 1, bashRevision: displayProfile.bashRevision, preparedThrough: head, phase: 'available', errorCode: null },
		processingPhase: null,
		control: { serverInstanceId: instance, version: 0, updatedAt: null,
			queue: { entries: [], steeringEntryId: null, recentlyDispatched: [], pause: null, reorderRevision: 0 } },
		transientFeed: { serverInstanceId: instance, chatId, transcriptViewId: view, transientRevision: 0, rows: [] },
		plan: { serverInstanceId: instance, chatId, transcriptViewId: view, revision: 0, latestEnterOrdinal: null, pendingExitCount: 0, exits: [], nextAfterOrdinal: null },
		submissions: [],
	};
}

export function displayCertificate(open = displayOpen(), profile = displayProfile): DisplayCertificate {
	return { serverInstanceId: open.serverInstanceId, chatId: open.chat.id, transcriptViewId: open.transcriptViewId,
		policyRevision: open.display.policyRevision, profileKey: displayProfileKey(profile), cutsKey: displayCutsKey([]),
		bashRevision: profile.bashRevision, watermark: open.sourceHead };
}

export function displayWindow(items: readonly DisplayDescriptor[] = [], certificate = displayCertificate()): AvailableDisplayWindow {
	return { kind: 'available', certificate, sourceHead: certificate.watermark, structuralPreparedThrough: certificate.watermark,
		bashPreparedThrough: certificate.watermark, items, interval: { after: 0, through: certificate.watermark },
		earlier: { kind: 'exhausted-through-watermark' }, later: { kind: 'exhausted-through-watermark' }, cutPlacements: [], publicTail: null };
}

export function displayDetail(ordinal: number, fields: Partial<RowDetails> = {}): RowDetails {
	return { ordinal, pairedUse: null, pairedResult: null, questionWrapper: null, permissionTerminal: null, commandFormat: null, ...fields };
}

export function displayRow(ordinal: number, message: ChatMessage = new AssistantMessage(DISPLAY_TIME, `Message ${ordinal}`)): TranscriptMessage {
	return { ordinal, message };
}

// Supplies pre-certified ordinary rows; dependency and grouping tests provide their own descriptors.
export function mockDisplayApi(initialRows: readonly TranscriptMessage[] = [], initialOpen = displayOpen('chat-1', 'view-1', initialRows.at(-1)?.ordinal ?? 0)) {
	let rows = initialRows, open = initialOpen;
	const chats = new Map([[open.chat.id, { rows, open }]]);
	const calls = {
		open: vi.spyOn(transcriptDisplayApi, 'open').mockImplementation(async request => chats.get(request.chatId)?.open ?? open),
		window: vi.spyOn(transcriptDisplayApi, 'window').mockImplementation(async request => {
			const { rows, open } = chats.get(request.chatId) ?? { rows: initialRows, open: initialOpen };
			const watermark = request.atWatermark ?? (request.anchor.kind === 'before' || request.anchor.kind === 'after'
				? request.anchor.cursor.certificate.watermark : open.sourceHead);
			let available = rows.filter(row => row.ordinal <= watermark);
			const anchor = request.anchor;
			if (anchor.kind === 'before') available = available.filter(row => row.ordinal < anchor.cursor.boundaryOrdinal);
			if (anchor.kind === 'after') available = available.filter(row => row.ordinal > anchor.cursor.boundaryOrdinal);
			if (anchor.kind === 'around') {
				const index = available.findIndex(row => row.ordinal >= anchor.ordinal);
				available = available.slice(Math.max(0, index - Math.floor(request.limit / 2)), Math.max(request.limit, index + Math.ceil(request.limit / 2)));
			} else if (anchor.kind === 'after') available = available.slice(0, request.limit);
			else available = available.slice(-request.limit);
			const certificate = { ...displayCertificate(open, request.profile), watermark, cutsKey: displayCutsKey(request.cuts) };
			const first = available[0]?.ordinal ?? 1, last = available.at(-1)?.ordinal ?? watermark;
			const earlier = rows.some(row => row.ordinal < first), later = rows.some(row => row.ordinal > last && row.ordinal <= watermark);
			return { ...displayWindow(available.map(row => ({ kind: 'row', ordinal: row.ordinal, messageType: row.message.type,
				layout: row.message.type === 'permission-request' ? 'permission' : 'standard', estimatedBodyBytes: 100, permissionOccurrenceId: null })), certificate),
				sourceHead: open.sourceHead, interval: { after: earlier ? first - 1 : 0, through: later ? last : watermark },
				earlier: earlier ? { kind: 'more', cursor: { certificate, boundaryOrdinal: first } } : { kind: 'exhausted-through-watermark' },
				later: later ? { kind: 'more', cursor: { certificate, boundaryOrdinal: last } } : { kind: 'exhausted-through-watermark' },
				cutPlacements: request.cuts.map(cut => ({ id: cut.id, placement: 'inline' as const })) };
		}),
		bodies: vi.spyOn(transcriptDisplayApi, 'bodies').mockImplementation(async request => ({
			certificate: request.certificate, details: request.seedOrdinals.map(ordinal => displayDetail(ordinal)),
			bodies: (chats.get(request.certificate.chatId)?.rows ?? []).filter(row => request.seedOrdinals.includes(row.ordinal) && !request.residentOrdinals.includes(row.ordinal))
				.map(row => ({ ...row, submissionClientMessageId: row.message.type === 'user-message' ? row.message.metadata?.clientMessageId ?? null : null })),
			deferredOrdinals: [], oversizedOrdinal: null, nonRenderedOrdinals: [],
		})),
		resolve: vi.spyOn(transcriptDisplayApi, 'resolve').mockImplementation(async request => ({ kind: 'visible-row', ordinal: request.ordinal, landedOrdinal: request.ordinal })),
		retry: vi.spyOn(transcriptDisplayApi, 'retry').mockResolvedValue({ success: true }),
	};
	return { ...calls, replace(nextRows: readonly TranscriptMessage[], nextOpen = { ...open, sourceHead: nextRows.at(-1)?.ordinal ?? 0 }) {
		rows = nextRows; open = nextOpen; chats.set(open.chat.id, { rows, open });
	} };
}
