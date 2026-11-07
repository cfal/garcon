import type { GroupDescriptor, MemberWindowRequest } from '$shared/transcript-display-contract';

export type TranscriptPageLoadResult = 'loaded' | 'exhausted' | 'invalidated' | 'failed';
export type TranscriptPageDirection = 'earlier' | 'later';
export type TranscriptPageApplicationDecision = 'apply' | 'invalidated';
export type TranscriptPageApplicationGate = () => Promise<TranscriptPageApplicationDecision>;
export type TranscriptPageStatus = 'idle' | 'loading' | 'error';
export type TranscriptWindowLoadResult = 'loaded' | 'invalidated' | 'failed';
export type TranscriptWindowTarget = 'initial' | 'latest';

export interface TranscriptMemberPageTarget {
	readonly group: GroupDescriptor;
	readonly anchor: MemberWindowRequest['anchor'];
}

export interface TranscriptPageLoadOptions {
	applicationGate?: TranscriptPageApplicationGate;
	memberTarget?: TranscriptMemberPageTarget;
}

export interface TranscriptPageState {
	status: TranscriptPageStatus;
	error: string | null;
}

export const idlePageState = (): TranscriptPageState => ({ status: 'idle', error: null });
