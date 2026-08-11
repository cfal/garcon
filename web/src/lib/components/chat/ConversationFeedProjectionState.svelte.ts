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
	type ConversationFeedRenderModelReconciliation,
	type ReconciledConversationFeedRenderModel,
} from '$lib/chat/transcript/conversation-feed-render-model.js';
import { filterHiddenToolRenderItems } from '$lib/chat/transcript/conversation-feed-items.js';
import type { PendingPermissionRequest } from '$lib/types/chat';
import {
	buildConversationVirtualFeedModel,
	estimateConversationFeedItemSize,
	appendConversationVirtualTranscriptTail,
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
	transcriptGenerationId: string;
	pendingPermissions: PendingPermissionRequest[];
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
		left.transcriptGenerationId === right.transcriptGenerationId &&
		left.pendingPermissions === right.pendingPermissions,
	);
}

function sameProjectionConfiguration(
	left: ConversationFeedProjectionInput | null,
	right: ConversationFeedProjectionInput,
): boolean {
	return Boolean(
		left &&
		left.surfaceIdentity === right.surfaceIdentity &&
		left.hiddenToolTypes === right.hiddenToolTypes &&
		left.showThinking === right.showThinking &&
		left.textScale === right.textScale &&
		left.isLiveWindow === right.isLiveWindow &&
		left.showTopToolbarSpacer === right.showTopToolbarSpacer &&
		left.showRefreshError === right.showRefreshError &&
		left.showEarlierBoundary === right.showEarlierBoundary &&
		left.showLaterBoundary === right.showLaterBoundary &&
		left.reserveComposerTraySpace === right.reserveComposerTraySpace &&
		left.transcriptGenerationId === right.transcriptGenerationId &&
		left.pendingPermissions.length === right.pendingPermissions.length &&
		left.pendingPermissions.every(
			(permission, index) => permission === right.pendingPermissions[index],
		),
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

		const reconciliation = this.#renderModel.reconcileDetailed(input.surfaceIdentity, input.rows);
		const renderModel = reconciliation.model;
		const mutationKinds = new Set(
			conversationFeedMutationKindsSince(input.mutationClock, this.#lastProjectedDataRevision),
		);
		const incremental = this.#reconcileIncremental(input, reconciliation, mutationKinds);
		if (incremental) return incremental;

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
			transcriptGenerationId: input.transcriptGenerationId,
			transcriptItems: visibleTranscriptItems,
			pendingPermissions: input.pendingPermissions,
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

	#reconcileIncremental(
		input: ConversationFeedProjectionInput,
		reconciliation: ConversationFeedRenderModelReconciliation,
		mutationKinds: Set<ConversationFeedMutationKind>,
	): ConversationFeedProjection | null {
		const previous = this.#lastProjection;
		if (!previous || !sameProjectionConfiguration(this.#lastInput, input)) return null;

		let model: ConversationVirtualFeedModel;
		let geometry = previous.geometry;
		if (reconciliation.change.kind === 'unchanged') {
			model = previous.model;
		} else if (reconciliation.change.kind === 'tail-appended') {
			const appended = appendConversationVirtualTranscriptTail(
				previous.model,
				input.surfaceIdentity,
				reconciliation.change.appendedItems,
			);
			if (!appended) return null;
			model = appended;
			if (mutationKinds.size === 0) mutationKinds.add('presentation-structure');
			const keys = previous.geometry.keys.slice();
			const estimates = previous.geometry.estimates.slice();
			const insertIndex = previous.model.transcriptEndIndex;
			if (insertIndex > previous.model.transcriptStartIndex) {
				estimates[insertIndex - 1] = estimateConversationFeedItemSize(
					model.items[insertIndex - 1],
					input.textScale,
				);
			}
			keys.splice(
				insertIndex,
				0,
				...model.items
					.slice(insertIndex, insertIndex + reconciliation.change.appendedItems.length)
					.map((item) => item.key),
			);
			estimates.splice(
				insertIndex,
				0,
				...model.items
					.slice(insertIndex, insertIndex + reconciliation.change.appendedItems.length)
					.map((item) => estimateConversationFeedItemSize(item, input.textScale)),
			);
			geometry = {
				surfaceIdentity: input.surfaceIdentity,
				geometryRevision: ++this.#geometryRevision,
				keys,
				estimates,
				measurementReset: 'none',
				mutationKinds,
				endBehavior: conversationFeedEndBehavior(mutationKinds, input.isLiveWindow),
			};
		} else {
			return null;
		}

		this.#lastProjectedDataRevision = input.mutationClock.dataRevision;
		this.#lastInput = input;
		this.#lastProjection = {
			renderModel: reconciliation.model,
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
