export type ConversationViewportTarget =
	{ kind: 'row'; id: string } | { kind: 'dom-anchor'; id: string };

export type HiddenReadingRestoreResult = 'restored' | 'missing-anchor' | 'not-ready';
export type ConversationLayoutWaitResult = 'settled' | 'superseded' | 'not-ready';
export type ConversationViewportFillResult = 'overflow' | 'underfilled' | 'unsettled';

export interface ConversationViewportPort {
	isReady(): boolean;
	isAtEnd(threshold?: number): boolean;
	scrollToStart(): void;
	scrollToEnd(options?: { behavior?: 'auto' | 'instant' }): void;
	scrollBy(delta: number): void;
	waitForLayout(options?: {
		targetKey?: string;
		minimumDataRevision?: number;
	}): Promise<ConversationLayoutWaitResult>;
	measureViewportFill(): Promise<ConversationViewportFillResult>;
	restoreHiddenReadingPosition(): Promise<HiddenReadingRestoreResult>;
	cancelPendingLayoutMutation(): void;
	scrollToTarget(
		target: ConversationViewportTarget,
		options?: { align?: 'center' | 'start' | 'end' },
	): Promise<boolean>;
}
