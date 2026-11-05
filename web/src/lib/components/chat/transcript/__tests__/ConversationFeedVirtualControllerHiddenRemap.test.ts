import { cleanup, render, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { BashToolUseMessage, UserMessage } from '$shared/chat-types';
import { certifiedFeed, displayGroup } from './display-feed-fixtures.js';
import { displayCertificate, displayOpen } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import { installResizeObserverHarness, ResizeObserverHarness } from '$lib/components/shared/__tests__/resize-observer-harness';
import type { ConversationFeedMutationKind } from '$lib/chat/transcript/conversation-feed-mutations.js';
import type { ConversationFeedProjection } from '../ConversationFeedProjectionState.svelte.js';
import { ConversationFeedVirtualController } from '../ConversationFeedVirtualController.svelte.js';
import type {
	ConversationVirtualFeedItem,
	ConversationVirtualFeedModel,
	TranscriptVirtualFeedItem,
	ToolGroupVirtualFeedItem,
} from '../conversation-feed-virtual-items.js';
import { buildConversationVirtualFeedModel } from '../conversation-feed-virtual-items.js';
import ConversationFeedVirtualControllerHiddenRemapHost from './ConversationFeedVirtualControllerHiddenRemapHost.svelte';

const timestamp = '2026-08-03T00:00:00.000Z';

function projection(
	collapsed: boolean,
	revision: number,
	memberIds: readonly string[] = ['member', 'mate'],
): ConversationFeedProjection {
	const ordinalFor = (id: string) => id === 'member' ? 2 : id === 'mate' ? 3 : id.charCodeAt(0) - 95;
	const transcript = (id: string, ordinal: number, tool = false): TranscriptVirtualFeedItem => ({
		kind: 'transcript',
		key: id,
		item: {
			kind: 'message',
			id: `view:${ordinal}`,
			index: ordinal - 1,
			ordinal,
			message: tool
				? new BashToolUseMessage(timestamp, id, 'pwd')
				: new UserMessage(timestamp, id),
		},
		spacingAfter: 'none',
	});
	const members = memberIds.map(id => transcript(id, ordinalFor(id), true));
	const group: ToolGroupVirtualFeedItem = {
		kind: 'tool-group',
		key: `summary:${memberIds[0]}`,
		anchorId: `tool-group:${memberIds[0]}`,
		descriptor: displayGroup(ordinalFor(memberIds[0]), ordinalFor(memberIds.at(-1)!), members.length),
		expanded: false,
		spacingAfter: 'none',
	};
	const items: ConversationVirtualFeedItem[] = [
		transcript('before', 1),
		...(collapsed ? [group] : members),
		transcript('tail', 5),
	];
	const indexByKey = new Map(items.map((item, index): [string, number] => [item.key, index]));
	const model: ConversationVirtualFeedModel = {
		items,
		transcriptViewId: 'view',
		indexByKey,
		indexByRowId: new Map([
			['view:1', 0],
			...(collapsed ? [] : members.map((member, index): [string, number] => [member.item.id, index + 1])),
			['view:5', items.length - 1],
		]),
		targetByDomAnchorId: new Map(),
		representativeRowIdByKey: new Map(items.map((item): [string, string] => [
			item.key,
			item.kind === 'tool-group' ? `view:${item.descriptor.firstMember}` : item.kind === 'transcript' ? item.item.id : item.key,
		])),
		transcriptStartIndex: 0,
		transcriptEndIndex: items.length,
	};
	return {
		renderModel: certifiedFeed([]).renderModel,
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
		ordinal,
		message: tool
			? new BashToolUseMessage(timestamp, id, 'pwd')
			: new UserMessage(timestamp, id),
	});
	const rows = [
			row('leading', 1),
			row('before', 2),
			...(includeTools ? [row('a', 3, true), row('b', 4, true)] : []),
			row('tail', 5),
			...(includeAppend ? [row('appended', 6)] : []),
		];
	const feed = certifiedFeed(rows, {
		certificate: displayCertificate(displayOpen('chat-1', 'view', includeAppend ? 6 : 5)),
		input: { surfaceIdentity: 'same-surface' },
	});
	if (combineToolUseMessages && includeTools) {
		feed.display = { ...feed.display, window: { ...feed.display.window!, items: [
			...feed.display.window!.items.slice(0, 2), displayGroup(3, 4, 2), ...feed.display.window!.items.slice(4),
		] } };
	}
	const model = buildConversationVirtualFeedModel(feed);
	return {
		renderModel: feed.renderModel,
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
	const firstPublication = publications[0];
	if (!firstPublication) throw new Error('Expected at least one hidden publication');
	let exposure: {
		controller: ConversationFeedVirtualController;
		viewport(): HTMLDivElement | null;
		hide(): Promise<void>;
		combine(): Promise<void>;
		apply(next: ConversationFeedProjection): Promise<void>;
		show(): Promise<void>;
	} | undefined;
	try {
		render(ConversationFeedVirtualControllerHiddenRemapHost, {
			initial,
			combined: firstPublication,
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
