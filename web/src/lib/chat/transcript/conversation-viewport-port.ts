import type { ConversationNativeScrollActivity } from './conversation-native-scroll-settlement.js';

export type ConversationViewportTarget =
	{ kind: 'row'; id: string } | { kind: 'dom-anchor'; id: string };
export type ConversationViewportIntentSource = 'viewport' | 'scrollbar-drag';
export type ConversationViewportIntentCancellationResult =
	'cancelled' | 'preserved-earlier-prepend' | 'blocked-scrollbar-drag';

export type HiddenReadingRestoreResult = 'restored' | 'missing-anchor' | 'not-ready';
export type ConversationLayoutWaitResult = 'settled' | 'superseded' | 'not-ready';
export type ConversationViewportFillResult = 'overflow' | 'underfilled' | 'unsettled';
export type ConversationViewportTargetResult =
	'completed' | 'cancelled' | 'target-missing' | 'not-ready';

export interface ConversationViewportPosition {
	readonly logicalOffset: number;
	readonly distanceFromStart: number;
	readonly leadingContentReachable: boolean;
}

export interface ConversationViewportPort {
	isReady(): boolean;
	isAtEnd(threshold?: number): boolean;
	ownsScrollPosition(): boolean;
	viewportPosition(): ConversationViewportPosition | null;
	scrollToStart(): void;
	scrollToEnd(): void;
	restoreInitialEnd(): void;
	scrollBy(delta: number): void;
	waitForLayout(options?: { minimumDataRevision?: number }): Promise<ConversationLayoutWaitResult>;
	measureViewportFill(): Promise<ConversationViewportFillResult>;
	restoreHiddenReadingPosition(): Promise<HiddenReadingRestoreResult>;
	cancelPendingLayoutMutation(): void;
	cancelForUserIntent(
		direction: 'earlier' | 'later' | null,
		source?: ConversationViewportIntentSource,
	): ConversationViewportIntentCancellationResult;
	setNativeScrollActivity(activity: ConversationNativeScrollActivity): void;
	scrollToTarget(
		target: ConversationViewportTarget,
		options?: { align?: 'center' | 'start' | 'end' },
	): Promise<ConversationViewportTargetResult>;
}
