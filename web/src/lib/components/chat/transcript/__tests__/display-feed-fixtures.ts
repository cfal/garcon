import type { TranscriptMessage } from '$shared/chat-view';
import type { DisplayCertificate, DisplayDescriptor, GroupDescriptor } from '$shared/transcript-display-contract';
import { DisplayBodyStore } from '$lib/chat/transcript/display-body-store.js';
import { displayRenderModel } from '$lib/chat/transcript/display-render-model.js';
import { emptyDisplayWindow, type DisplayWindowSnapshot } from '$lib/chat/transcript/display-window-controller.js';
import { displayCertificate, displayDetail, displayOpen, displayWindow } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import type { ConversationVirtualFeedInput } from '../conversation-feed-virtual-items.js';

export function displayGroup(first: number, last: number, count: number): GroupDescriptor {
	return { kind: 'tool-group', base: { afterBreaker: first - 1, beforeBreaker: last + 1, firstMember: first, lastMember: last, openAtWatermark: false },
		fragment: { after: first - 1, through: last }, firstMember: first, lastMember: last, count,
		totals: { commands: count, fileReads: 0, fileEdits: 0, other: 0 }, categoryOrder: ['commands'] };
}

export function certifiedFeed(rows: readonly TranscriptMessage[], options: {
	certificate?: DisplayCertificate;
	items?: readonly DisplayDescriptor[];
	display?: Partial<DisplayWindowSnapshot>;
	input?: Partial<ConversationVirtualFeedInput>;
} = {}): ConversationVirtualFeedInput {
	const items = options.items ?? rows.map(({ ordinal, message }): DisplayDescriptor => ({
		kind: 'row', ordinal, messageType: message.type, layout: message.type === 'permission-request' ? 'permission' : 'standard',
		estimatedBodyBytes: 100, permissionOccurrenceId: message.type === 'permission-request' ? message.permissionOccurrenceId : null,
	}));
	const head = Math.max(0, ...rows.map(row => row.ordinal), ...items.map(item => item.kind === 'row' ? item.ordinal : item.lastMember));
	const certificate = options.certificate ?? displayCertificate(displayOpen('chat-1', 'view-1', head));
	const details = new Map([
		...items.flatMap(item => item.kind === 'row' ? [item.ordinal] : []),
		...(options.display?.expansions ?? []).flatMap(expansion => expansion.page.ordinals),
	].map(ordinal => [ordinal, displayDetail(ordinal)]));
	const snapshot: DisplayWindowSnapshot = { ...emptyDisplayWindow(), window: displayWindow(items, certificate), details, phase: 'available', ...options.display };
	const bodies = new DisplayBodyStore();
	bodies.resetInstance(certificate.serverInstanceId);
	bodies.put(certificate, rows.map(row => ({ ...row, submissionClientMessageId: null })));
	return {
		showRefreshError: false, earlierBoundary: 'hidden', showLaterBoundary: false, reserveComposerCapSpace: false,
		surfaceIdentity: 'surface-1', transcriptViewId: certificate.transcriptViewId, display: snapshot, renderModel: displayRenderModel(snapshot, bodies),
		overlays: [], optimisticAfterOrdinals: new Map(), pendingPermissions: [], ...options.input,
	};
}
