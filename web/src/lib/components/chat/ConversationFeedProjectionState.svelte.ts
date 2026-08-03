import { ThinkingMessage } from '$shared/chat-types';
import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import {
	conversationFeedEndBehavior,
	conversationFeedMutationKindsSince,
	type ConversationFeedMutationClock,
	type ConversationFeedMutationKind,
} from '$lib/chat/transcript/conversation-feed-mutations.js';
import {
	ConversationFeedRenderModelController,
	type ReconciledConversationFeedRenderModel,
} from '$lib/chat/transcript/conversation-feed-render-model.js';
import { filterHiddenToolRenderItems } from '$lib/chat/transcript/conversation-feed-items.js';
import type { PendingPermissionRequest } from '$lib/types/chat';
import {
	buildConversationVirtualFeedModel,
	estimateConversationFeedItemSize,
	type ConversationVirtualFeedModel,
} from './conversation-feed-virtual-items.js';

export interface ConversationFeedProjectionInput {
	surfaceIdentity: string;
	rows: ChatDisplayRow[];
	mutationClock: ConversationFeedMutationClock;
	hiddenToolTypes: readonly string[];
	showThinking: boolean;
	textScale: number;
	isLiveWindow: boolean;
	showTopToolbarSpacer: boolean;
	showRefreshError: boolean;
	showEarlierBoundary: boolean;
	showLaterBoundary: boolean;
	reserveComposerTraySpace: boolean;
	floatingPermissions: PendingPermissionRequest[];
}

export interface ConversationVirtualGeometrySnapshot {
	surfaceIdentity: string;
	geometryRevision: number;
	keys: readonly string[];
	estimates: readonly number[];
	measurementReset: 'none' | 'all';
	mutationKinds: ReadonlySet<ConversationFeedMutationKind>;
	endBehavior: ReturnType<typeof conversationFeedEndBehavior>;
}

export interface ConversationFeedProjection {
	renderModel: ReconciledConversationFeedRenderModel;
	model: ConversationVirtualFeedModel;
	geometry: ConversationVirtualGeometrySnapshot;
	projectedDataRevision: number;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameInput(
	left: ConversationFeedProjectionInput | null,
	right: ConversationFeedProjectionInput,
): boolean {
	return Boolean(
		left &&
		left.surfaceIdentity === right.surfaceIdentity &&
		left.rows === right.rows &&
		left.mutationClock.dataRevision === right.mutationClock.dataRevision &&
		left.mutationClock.lastRevisionByKind === right.mutationClock.lastRevisionByKind &&
		left.hiddenToolTypes === right.hiddenToolTypes &&
		left.showThinking === right.showThinking &&
		left.textScale === right.textScale &&
		left.isLiveWindow === right.isLiveWindow &&
		left.showTopToolbarSpacer === right.showTopToolbarSpacer &&
		left.showRefreshError === right.showRefreshError &&
		left.showEarlierBoundary === right.showEarlierBoundary &&
		left.showLaterBoundary === right.showLaterBoundary &&
		left.reserveComposerTraySpace === right.reserveComposerTraySpace &&
		left.floatingPermissions === right.floatingPermissions,
	);
}

export class ConversationFeedProjectionState {
	#renderModel = new ConversationFeedRenderModelController();
	#lastInput: ConversationFeedProjectionInput | null = null;
	#lastProjection: ConversationFeedProjection | null = null;
	#lastProjectedDataRevision = 0;
	#geometryRevision = 0;

	reconcile(input: ConversationFeedProjectionInput): ConversationFeedProjection {
		if (sameInput(this.#lastInput, input) && this.#lastProjection) return this.#lastProjection;

		const renderModel = this.#renderModel.reconcile(input.surfaceIdentity, input.rows);
		const visibleTranscriptItems = filterHiddenToolRenderItems(
			renderModel.items,
			input.hiddenToolTypes,
		).filter(
			(item) =>
				item.kind !== 'message' || !(item.message instanceof ThinkingMessage) || input.showThinking,
		);
		const model = buildConversationVirtualFeedModel({
			surfaceIdentity: input.surfaceIdentity,
			showTopToolbarSpacer: input.showTopToolbarSpacer,
			showRefreshError: input.showRefreshError,
			showEarlierBoundary: input.showEarlierBoundary,
			showLaterBoundary: input.showLaterBoundary,
			reserveComposerTraySpace: input.reserveComposerTraySpace,
			transcriptItems: visibleTranscriptItems,
			floatingPermissions: input.floatingPermissions,
		});
		const keys = model.items.map((item) => item.key);
		const estimates = model.items.map((item) =>
			estimateConversationFeedItemSize(item, input.textScale),
		);
		const previousGeometry = this.#lastProjection?.geometry;
		const identityChanged = previousGeometry?.surfaceIdentity !== input.surfaceIdentity;
		const textScaleChanged = this.#lastInput?.textScale !== input.textScale;
		const geometryChanged =
			!previousGeometry ||
			identityChanged ||
			!arraysEqual(previousGeometry.keys, keys) ||
			!arraysEqual(previousGeometry.estimates, estimates);

		const mutationKinds = new Set(
			conversationFeedMutationKindsSince(input.mutationClock, this.#lastProjectedDataRevision),
		);
		if (!previousGeometry) mutationKinds.add('initial');
		else if (geometryChanged && mutationKinds.size === 0) {
			mutationKinds.add('presentation-structure');
		}

		const geometry = geometryChanged
			? {
					surfaceIdentity: input.surfaceIdentity,
					geometryRevision: ++this.#geometryRevision,
					keys,
					estimates,
					measurementReset:
						textScaleChanged && !identityChanged ? ('all' as const) : ('none' as const),
					mutationKinds,
					endBehavior: conversationFeedEndBehavior(mutationKinds, input.isLiveWindow),
				}
			: previousGeometry;

		this.#lastProjectedDataRevision = input.mutationClock.dataRevision;
		this.#lastInput = input;
		this.#lastProjection = {
			renderModel,
			model,
			geometry,
			projectedDataRevision: input.mutationClock.dataRevision,
		};
		return this.#lastProjection;
	}

	reset(): void {
		this.#renderModel.reset();
		this.#lastInput = null;
		this.#lastProjection = null;
		this.#lastProjectedDataRevision = 0;
		this.#geometryRevision = 0;
	}
}
