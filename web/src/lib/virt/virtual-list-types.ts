export type VirtualScrollActivity = 'idle' | 'dragging' | 'coasting';

export type VirtualCorrectionProvenance = 'measurement' | 'follow' | 'navigation';

export interface VirtualItem {
	readonly key: string;
	readonly index: number;
	readonly start: number;
	readonly size: number;
	readonly end: number;
}

export type LogicalVirtualItem = VirtualItem;

export interface VirtualRange {
	readonly startIndex: number;
	readonly endIndex: number;
}

export interface VirtualPositionView {
	readonly count: number;
	itemAt(index: number): VirtualItem | undefined;
	itemAtOffset(paintedOffset: number): VirtualItem | undefined;
}

export interface VirtualViewportPosition {
	readonly paintedOffset: number;
	readonly logicalOffset: number;
	readonly distanceFromStart: number;
	readonly leadingContentReachable: boolean;
}

export interface VirtualListSnapshot {
	readonly revision: number;
	readonly visibleRange: VirtualRange | null;
	readonly overscanRange: VirtualRange | null;
	readonly sizerSize: number;
	readonly positions: VirtualPositionView;
}

export function virtualItems(
	snapshot: VirtualListSnapshot,
	indexes: readonly number[],
): readonly VirtualItem[] {
	const uniqueIndexes = [...new Set(indexes)].sort((left, right) => left - right);
	const items: VirtualItem[] = [];

	for (const index of uniqueIndexes) {
		const item = snapshot.positions.itemAt(index);
		if (item) items.push(item);
	}

	return items;
}

export type VirtualMutationAnchor =
	| { readonly kind: 'item'; readonly key: string }
	| { readonly kind: 'end' }
	| { readonly kind: 'none' };

interface VirtualItemsSource {
	readonly keys: readonly string[];
	readonly estimates: readonly number[];
	readonly anchor: VirtualMutationAnchor;
}

export type VirtualItemsMutation =
	| ({ readonly kind: 'update' } & VirtualItemsSource)
	| ({ readonly kind: 'reset-measurements' } & VirtualItemsSource)
	| {
			readonly kind: 'replace-surface';
			readonly keys: readonly string[];
			readonly estimates: readonly number[];
	  };

export type VirtualMutationResult =
	| { readonly kind: 'applied' }
	| {
			readonly kind: 'rejected';
			readonly reason: 'duplicate-key' | 'length-mismatch' | 'invalid-estimate';
	  };

export type VirtualResumeTarget =
	| { readonly kind: 'start' }
	| { readonly kind: 'end' }
	| { readonly kind: 'anchor'; readonly key: string; readonly viewportOffset: number };

export type VirtualScrollResult = { readonly kind: 'scheduled' } | { readonly kind: 'not-ready' };

export type VirtualResumeResult = VirtualScrollResult | { readonly kind: 'missing-key' };

export type VirtualIndexScrollResult = VirtualScrollResult | { readonly kind: 'missing-index' };

export type VirtualKeyScrollResult = VirtualScrollResult | { readonly kind: 'missing-key' };

export type VirtualTransactionSource =
	| 'items'
	| 'mount'
	| 'resize'
	| 'viewport'
	| 'resume'
	| 'programmatic'
	| 'replace-surface';

export interface VirtualTransactionRecord {
	readonly revision: number;
	readonly source: VirtualTransactionSource;
	readonly provenance: VirtualCorrectionProvenance | null;
	readonly activity: VirtualScrollActivity;
	readonly anchorKind: 'item' | 'end' | 'none';
	readonly anchorIndex: number | null;
	readonly anchorPaintedStartBefore: number | null;
	readonly anchorPaintedStartAfter: number | null;
	readonly changedCount: number;
	readonly firstChangedIndex: number | null;
	readonly correction: number;
	readonly scrollTopBefore: number;
	readonly intendedScrollTop: number;
	readonly attainedScrollTop: number;
	readonly leadingOffsetBefore: number;
	readonly leadingOffsetAfter: number;
	readonly deviationBefore: number;
	readonly deviationAfter: number;
	readonly redeemed: boolean;
	readonly clampedRemainder: number;
	readonly published: boolean;
	readonly scrollWrites: number;
	readonly durationMs: number;
	readonly ignoredEntries: number;
}
