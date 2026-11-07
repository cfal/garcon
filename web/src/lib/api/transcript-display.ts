import {
	parseBodyDependencyResponse,
	parseDisplayTargetResolution,
	parseDisplayWindowResponse,
	parseMemberWindowResponse,
	type BodyDependencyRequest,
	type CertifiedDisplayRequest,
	type DisplayWindowRequest,
	type MemberWindowRequest,
} from '$shared/transcript-display-contract';
import {
	parseDisplayOpenResponse,
	parsePlanPresentationSnapshot,
	parsePlanPresentationDetail,
	type DisplayOpenRequest,
	type PlanPresentationRequest,
} from '$shared/transcript-display-open';
import {
	parseResendSnapshot,
	parseSubagentSummaryPage,
	parseUserRowPage,
	type DisplayAuxiliaryRequest,
	type ResendSnapshotRequest,
} from '$shared/transcript-display-auxiliary';
import { apiPost } from './client.js';

async function read<T>(operation: string, request: unknown, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
	return parse(await apiPost<unknown>(`/api/v1/chats/transcript-display/${operation}`, request, { signal }));
}

export const transcriptDisplayApi = {
	open: (request: DisplayOpenRequest, signal?: AbortSignal) => read('open', request, parseDisplayOpenResponse, signal),
	window: (request: DisplayWindowRequest, signal?: AbortSignal) => read('window', request, parseDisplayWindowResponse, signal),
	members: (request: MemberWindowRequest, signal?: AbortSignal) => read('members', request, parseMemberWindowResponse, signal),
	bodies: (request: BodyDependencyRequest, signal?: AbortSignal) => read('bodies', request, parseBodyDependencyResponse, signal),
	resolve: ({ certificate, profile, cuts, ordinal }: CertifiedDisplayRequest & { ordinal: number }, signal?: AbortSignal) => read('resolve', {
		chatId: certificate.chatId, transcriptViewId: certificate.transcriptViewId, policyRevision: certificate.policyRevision,
		profile, cuts, atWatermark: certificate.watermark, anchor: { kind: 'around', ordinal }, limit: 50,
	}, parseDisplayTargetResolution, signal),
	userRows: (request: DisplayAuxiliaryRequest, signal?: AbortSignal) => read('user-rows', request, parseUserRowPage, signal),
	resend: (request: ResendSnapshotRequest, signal?: AbortSignal) => read('resend', request, parseResendSnapshot, signal),
	subagents: (request: DisplayAuxiliaryRequest, signal?: AbortSignal) => read('subagents', request, parseSubagentSummaryPage, signal),
	plan: (request: PlanPresentationRequest, signal?: AbortSignal) => read('plan', request, parsePlanPresentationSnapshot, signal),
	planDetail: (request: PlanPresentationRequest, signal?: AbortSignal) => read('plan-detail', request, parsePlanPresentationDetail, signal),
	dismissPlan: (request: PlanPresentationRequest, signal?: AbortSignal) => read('plan-dismiss', request, parsePlanPresentationSnapshot, signal),
	retry: (request: { chatId: string; transcriptViewId: string }, signal?: AbortSignal) => apiPost<unknown>('/api/v1/chats/transcript-display/retry', {
		chatId: request.chatId, expectedTranscriptViewId: request.transcriptViewId, reason: 'reconnect', outstandingClientMessageIds: [],
	}, { signal }),
};

export type TranscriptDisplayApi = typeof transcriptDisplayApi;
