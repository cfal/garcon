import { cleanup, render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'svelte';
import { BashToolUseMessage, UserMessage } from '$shared/chat-types';
import { buildConversationFeedRenderModel } from '$lib/chat/transcript/conversation-feed-items.js';
import { installResizeObserverHarness, ResizeObserverHarness } from '$lib/components/shared/__tests__/resize-observer-harness';
import type { ConversationFeedMutationKind } from '$lib/chat/transcript/conversation-feed-mutations.js';
import type { ConversationFeedProjection } from '../ConversationFeedProjectionState.svelte.js';
import type {
	ConversationVirtualFeedItem,
	ConversationVirtualFeedModel,
	TranscriptVirtualFeedItem,
	ToolGroupVirtualFeedItem,
} from '../conversation-feed-virtual-items.js';
import { buildConversationVirtualFeedModel } from '../conversation-feed-virtual-items.js';
import { remapConversationAnchor } from '../conversation-feed-anchor-remapping.js';
import HiddenRemapHost from './ConversationFeedVirtualControllerHiddenRemapHost.svelte';

type Controls = Parameters<ComponentProps<typeof HiddenRemapHost>['onReady']>[0];

const timestamp = '2026-08-03T00:00:00.000Z';

function projection(
	collapsed: boolean,
	revision: number,
	memberIds: readonly string[] = ['member', 'mate'],
): ConversationFeedProjection {
	const transcript = (id: string, index: number, tool = false): TranscriptVirtualFeedItem => ({
		kind: 'transcript',
		key: id,
		item: {
			kind: 'message',
			id,
			index,
			ordinal: index + 1,
			message: tool
				? new BashToolUseMessage(timestamp, id, 'pwd')
				: new UserMessage(timestamp, id),
		},
		spacingAfter: 'none',
	});
	const members = memberIds.map((id, index) => transcript(id, index + 1, true));
	const group: ToolGroupVirtualFeedItem = {
		kind: 'tool-group',
		key: `summary:${memberIds[0]}`,
		anchorId: `tool-group:${memberIds[0]}`,
		members,
		expanded: false,
		spacingAfter: 'none',
	};
	const items: ConversationVirtualFeedItem[] = [
		transcript('before', 0),
		...(collapsed ? [group] : members),
		transcript('tail', members.length + 1),
	];
	const indexByKey = new Map(items.map((item, index): [string, number] => [item.key, index]));
	const model: ConversationVirtualFeedModel = {
		items,
		indexByKey,
		indexByRowId: new Map([
			['before', 0],
			...members.map((member, index): [string, number] => [
				member.item.id,
				collapsed ? 1 : index + 1,
			]),
			['tail', items.length - 1],
		]),
		rowIdByToolAnchorId: new Map(),
		transcriptStartIndex: 0,
		transcriptEndIndex: items.length,
	};
	return {
		renderModel: buildConversationFeedRenderModel([]),
		model,
		geometry: {
			surfaceIdentity: 'same-surface',
			geometryRevision: revision,
			keys: items.map((item) => item.key),
			estimates: collapsed
				? [40, 56, 2000]
				: [40, ...members.map((_, index) => index === 0 ? 400 : 40), 2000],
			measurementReset: 'none',
			mutationKinds: new Set<ConversationFeedMutationKind>(),
			endBehavior: 'preserve-reading-position',
		},
		projectedDataRevision: revision,
	};
}

function fallbackProjection(
	revision: number,
	combineToolUseMessages: boolean,
	includeTools: boolean,
	includeAppend: boolean,
): ConversationFeedProjection {
	const row = (id: string, ordinal: number, tool = false) => ({
		kind: 'message' as const,
		id: `view:${ordinal}`,
		index: ordinal,
		ordinal,
		message: tool
			? new BashToolUseMessage(timestamp, id, 'pwd')
			: new UserMessage(timestamp, id),
	});
	const model = buildConversationVirtualFeedModel({
		surfaceIdentity: 'same-surface',
		transcriptViewId: 'view',
		showRefreshError: false,
		earlierBoundary: 'hidden',
		showLaterBoundary: false,
		reserveComposerCapSpace: false,
		pendingPermissions: [],
		combineToolUseMessages,
		expandedToolMemberIds: new Set(),
		protectedVirtualKeys: [],
		transcriptItems: [
			row('leading', 1),
			row('before', 2),
			...(includeTools ? [row('a', 3, true), row('b', 4, true)] : []),
			row('tail', 5),
			...(includeAppend ? [row('appended', 6)] : []),
		],
	});
	return {
		renderModel: buildConversationFeedRenderModel([]),
		model,
		geometry: {
			surfaceIdentity: 'same-surface',
			geometryRevision: revision,
			keys: model.items.map((item) => item.key),
			estimates: model.items.map((item) => {
				if (item.kind === 'viewport-start-spacer') return 0;
				if (item.kind === 'tool-group') return 56;
				if (item.kind !== 'transcript') return 0;
				if (item.item.id === 'view:1') return 1000;
				if (item.item.id === 'view:2') return 200;
				if (item.item.id === 'view:5') return 2000;
				return 100;
			}),
			measurementReset: 'none',
			mutationKinds: new Set<ConversationFeedMutationKind>(),
			endBehavior: 'preserve-reading-position',
		},
		projectedDataRevision: revision,
	};
}

async function hiddenRemapPosition(
	initial: ConversationFeedProjection,
	publications: readonly ConversationFeedProjection[],
	scrollTop: number,
): Promise<{ key: string | undefined; start: number; end: number; scrollTop: number }> {
	const restoreObserver = installResizeObserverHarness();
	if (!publications.length) throw new Error('Expected at least one hidden publication');
	let exposure: Controls | undefined;
	try {
		render(HiddenRemapHost, {
			initial,
			onReady(value) { exposure = value; },
		});
		await waitFor(() => expect(exposure).toBeDefined());
		const { controller, viewport: getViewport, hide, apply, show } = exposure!;
		const viewport = getViewport();
		expect(viewport).not.toBeNull();
		ResizeObserverHarness.emit(viewport!, 400, 80);
		viewport!.scrollTop = scrollTop;
		viewport!.dispatchEvent(new Event('scroll'));
		await hide();
		for (const publication of publications) await apply(publication);
		await show();
		const item = controller.snapshot.positions.itemAt(1);
		return {
			key: item?.key,
			start: item?.start ?? 0,
			end: item?.end ?? 0,
			scrollTop: viewport!.scrollTop,
		};
	} finally {
		cleanup();
		restoreObserver();
	}
}

describe('ConversationFeedVirtualController hidden remap', () => {
	it('takes fallback keys from published geometry without reading unrelated items', () => {
		const previous = projection(false, 1);
		const next = projection(true, 2);
		const readTailKey = vi.fn(() => 'tail');
		Object.defineProperty(next.model.items.at(-1)!, 'key', { get: readTailKey });
		const anchor = { key: 'member', viewportOffset: -12, fallbackKeys: [] };
		expect(remapConversationAnchor(anchor, previous.model, next)).toEqual({
			oldKey: 'member',
			anchor: { key: 'summary:member', viewportOffset: 0, fallbackKeys: ['before', 'tail'] },
		});
		expect(readTailKey).not.toHaveBeenCalled();
	});

	it.each([
		{ keepCollapsed: true, expected: 'cancelled' },
		{ keepCollapsed: false, expected: 'target-missing' },
	])('rechecks the original member and DOM alias after async reveal ($expected)', async ({ keepCollapsed, expected }) => {
		const initial = fallbackProjection(1, true, true, false);
		const publishedDuringReveal = fallbackProjection(2, true, keepCollapsed, true);
		const requested: string[] = [];
		const restoreObserver = installResizeObserverHarness();
		let exposure!: Controls;
		try {
			render(HiddenRemapHost, {
				initial,
				async revealToolGroup(rowId) {
					requested.push(rowId);
					await exposure.apply(publishedDuringReveal);
					return 'applied';
				},
				onReady(value) { exposure = value; },
			});
			await waitFor(() => expect(exposure?.viewport()).toBeTruthy());
			ResizeObserverHarness.emit(exposure.viewport()!, 400, 80);
			const result = await exposure.controller.scrollToTarget({ kind: 'dom-anchor', id: 'tool-input-a' });
			expect(requested).toEqual(['view:3']);
			expect(result).toBe(expected);
		} finally {
			cleanup();
			restoreObserver();
		}
	});

	it('restores a compressed summary to the viewport instead of the old member depth', async () => {
		const restored = await hiddenRemapPosition(projection(false, 1), [projection(true, 2)], 340);
		expect(restored.key).toBe('summary:member');
		expect(restored.start - restored.scrollTop).toBeGreaterThanOrEqual(0);
		expect(restored.end - restored.scrollTop).toBeGreaterThan(0);
	});

	it('restores a regrouped summary through any surviving member', async () => {
		const restored = await hiddenRemapPosition(
			projection(true, 1, ['a', 'b', 'c']),
			[projection(true, 2, ['b', 'c'])],
			40,
		);
		expect(restored.key).toBe('summary:b');
		expect(restored.scrollTop).toBe(40);
	});

	for (const combineToolUseMessages of [false, true]) {
		it(`preserves nearby fallbacks across hidden publications when combination is ${combineToolUseMessages ? 'on' : 'off'}`, async () => {
			const restored = await hiddenRemapPosition(
				fallbackProjection(1, combineToolUseMessages, true, false),
				[
					fallbackProjection(2, combineToolUseMessages, true, true),
					fallbackProjection(3, combineToolUseMessages, false, true),
				],
				1200,
			);
			expect(restored.scrollTop).toBe(1000);
		});
	}
});
