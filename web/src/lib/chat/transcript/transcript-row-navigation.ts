export interface TranscriptRowTarget {
	readonly chatId: string;
	readonly transcriptViewId: string;
	readonly ordinal: number;
}

export type TranscriptRowNavigationResult =
	'completed' | 'view-changed' | 'unavailable' | 'cancelled';
export type TranscriptRowWindowResult =
	{ kind: 'loaded'; landedOrdinal: number; revealDetail: boolean; targetMatched: boolean }
	| Exclude<TranscriptRowNavigationResult, 'completed'>;
