export type ConversationViewportTarget =
	{ kind: 'row'; id: string } | { kind: 'dom-anchor'; id: string };

export type HiddenReadingRestoreResult = 'restored' | 'missing-anchor' | 'not-ready';
export type ConversationLayoutWaitResult = 'settled' | 'superseded' | 'not-ready';
export type ConversationViewportFillResult = 'overflow' | 'underfilled' | 'unsettled';
export type ConversationViewportTargetResult =
	'completed' | 'cancelled' | 'target-missing' | 'not-ready';

export interface ConversationViewportPort {
	isReady(): boolean;
	isAtEnd(threshold?: number): boolean;
	ownsScrollPosition(): boolean;
	scrollToStart(): void;
	scrollToEnd(): void;
	restoreInitialEnd(): void;
	scrollBy(delta: number): void;
	waitForLayout(options?: { minimumDataRevision?: number }): Promise<ConversationLayoutWaitResult>;
	measureViewportFill(): Promise<ConversationViewportFillResult>;
	restoreHiddenReadingPosition(): Promise<HiddenReadingRestoreResult>;
	cancelPendingLayoutMutation(): void;
	cancelForUserIntent(direction: 'earlier' | 'later' | null): void;
	scrollToTarget(
		target: ConversationViewportTarget,
		options?: { align?: 'center' | 'start' | 'end' },
	): Promise<ConversationViewportTargetResult>;
}
