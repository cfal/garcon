import { CHAT_PROCESSING_PHASES, parseChatMessage, type ChatProcessingPhase, type ExitPlanModeToolUseMessage } from './chat-types.js';
import { parseChatSnapshotChat, type ChatSnapshotChat } from './chat-snapshot.js';
import { parseChatExecutionControlState, type ChatExecutionControlState } from './chat-execution-control.js';
import { parseChatTransientFeedSnapshot, type ChatTransientFeedSnapshot } from './chat-transient-feed.js';
import { displayArray, displayInteger, displayRecord, displayString } from './transcript-display-contract.js';

export interface DisplayOpenRequest {
  readonly chatId: string;
  readonly expectedTranscriptViewId?: string;
  readonly outstandingClientMessageIds: readonly string[];
  readonly reason: 'activate' | 'reconnect';
}
export interface PlanPresentationSnapshot {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly revision: number;
  readonly latestEnterOrdinal: number | null;
  readonly pendingExitCount: number;
  readonly exits: readonly { readonly ordinal: number; readonly timestamp: string }[];
  readonly nextAfterOrdinal: number | null;
}
export interface PlanPresentationRequest {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly ordinal?: number;
  readonly afterOrdinal?: number;
}
export interface PlanPresentationDetail extends Pick<PlanPresentationRequest, 'serverInstanceId' | 'chatId' | 'transcriptViewId'> { readonly ordinal: number; readonly message: ExitPlanModeToolUseMessage }
export function parsePlanPresentationDetail(value: unknown): PlanPresentationDetail {
  const raw = displayRecord(value), message = parseChatMessage(raw.message);
  if (message?.type !== 'exit-plan-mode-tool-use') throw new TypeError('Invalid plan detail');
  const identity = parsePlanPresentationRequest(raw);
  return { serverInstanceId: identity.serverInstanceId, chatId: identity.chatId, transcriptViewId: identity.transcriptViewId,
    ordinal: displayInteger(raw.ordinal, 1), message };
}
export interface DisplayPreparationStatus {
  readonly policyRevision: number;
  readonly bashRevision: string;
  readonly preparedThrough: number;
  readonly phase: 'preparing' | 'available' | 'failed';
  readonly errorCode: string | null;
}
export interface DisplayOpenResponse {
  readonly serverInstanceId: string;
  readonly chat: ChatSnapshotChat;
  readonly transcriptViewId: string;
  readonly sourceHead: number;
  readonly display: DisplayPreparationStatus;
  readonly processingPhase: ChatProcessingPhase | null;
  readonly control: ChatExecutionControlState;
  readonly transientFeed: ChatTransientFeedSnapshot;
  readonly plan: PlanPresentationSnapshot;
  readonly submissions: readonly { readonly clientMessageId: string; readonly ordinal: number | null }[];
}

export function parseDisplayOpenRequest(value: unknown): DisplayOpenRequest {
  const raw = displayRecord(value);
  if (raw.reason !== 'activate' && raw.reason !== 'reconnect') throw new TypeError('Invalid display open reason');
  const ids = displayArray(raw.outstandingClientMessageIds, 32).map(id => displayString(id, 256));
  if (new Set(ids).size !== ids.length) throw new TypeError('Duplicate outstanding submission');
  return { chatId: displayString(raw.chatId, 128), reason: raw.reason, outstandingClientMessageIds: ids,
    ...(raw.expectedTranscriptViewId === undefined ? {} : { expectedTranscriptViewId: displayString(raw.expectedTranscriptViewId, 256) }) };
}
export function parsePlanPresentationRequest(value: unknown): PlanPresentationRequest {
  const raw = displayRecord(value);
  return { serverInstanceId: displayString(raw.serverInstanceId), chatId: displayString(raw.chatId, 128), transcriptViewId: displayString(raw.transcriptViewId, 256),
    ...(raw.ordinal === undefined ? {} : { ordinal: displayInteger(raw.ordinal, 1) }),
    ...(raw.afterOrdinal === undefined ? {} : { afterOrdinal: displayInteger(raw.afterOrdinal) }) };
}
export function parsePlanPresentationSnapshot(value: unknown): PlanPresentationSnapshot {
  const raw = displayRecord(value), request = parsePlanPresentationRequest(raw);
  const exits = displayArray(raw.exits, 50).map(value => {
    const exit = displayRecord(value);
    return { ordinal: displayInteger(exit.ordinal, 1), timestamp: displayString(exit.timestamp, 64) };
  });
  if (exits.some((exit, index) => index > 0 && exit.ordinal <= exits[index - 1].ordinal)) throw new TypeError('Invalid plan order');
  return { serverInstanceId: request.serverInstanceId, chatId: request.chatId, transcriptViewId: request.transcriptViewId,
    revision: displayInteger(raw.revision), latestEnterOrdinal: raw.latestEnterOrdinal === null ? null : displayInteger(raw.latestEnterOrdinal, 1),
    pendingExitCount: displayInteger(raw.pendingExitCount, exits.length), exits,
    nextAfterOrdinal: raw.nextAfterOrdinal === null ? null : displayInteger(raw.nextAfterOrdinal, 1) };
}
export function parseDisplayPreparationStatus(value: unknown): DisplayPreparationStatus {
  const raw = displayRecord(value);
  if (raw.phase !== 'preparing' && raw.phase !== 'available' && raw.phase !== 'failed') throw new TypeError('Invalid display preparation phase');
  return { policyRevision: displayInteger(raw.policyRevision, 1), bashRevision: displayString(raw.bashRevision),
    preparedThrough: displayInteger(raw.preparedThrough), phase: raw.phase, errorCode: raw.errorCode === null ? null : displayString(raw.errorCode, 128) };
}
export function parseDisplayOpenResponse(value: unknown): DisplayOpenResponse {
  const raw = displayRecord(value), chat = parseChatSnapshotChat(raw.chat);
  const serverInstanceId = displayString(raw.serverInstanceId), transcriptViewId = displayString(raw.transcriptViewId, 256), sourceHead = displayInteger(raw.sourceHead);
  const transientFeed = parseChatTransientFeedSnapshot(raw.transientFeed), control = parseChatExecutionControlState(raw.control), plan = parsePlanPresentationSnapshot(raw.plan);
  if (!transientFeed || !control || transientFeed.chatId !== chat.id || transientFeed.transcriptViewId !== transcriptViewId
    || transientFeed.serverInstanceId !== serverInstanceId || control.serverInstanceId !== serverInstanceId
    || plan.chatId !== chat.id || plan.transcriptViewId !== transcriptViewId || plan.serverInstanceId !== serverInstanceId) throw new TypeError('Foreign display snapshot');
  const processingPhase = raw.processingPhase === null ? null : CHAT_PROCESSING_PHASES.find(phase => phase === raw.processingPhase);
  if (processingPhase === undefined) throw new TypeError('Invalid processing phase');
  const submissions = displayArray(raw.submissions, 32).map(value => {
    const input = displayRecord(value);
    return { clientMessageId: displayString(input.clientMessageId, 256), ordinal: input.ordinal === null ? null : displayInteger(input.ordinal, 1, sourceHead) };
  });
  const display = parseDisplayPreparationStatus(raw.display);
  if (new Set(submissions.map(input => input.clientMessageId)).size !== submissions.length || display.preparedThrough > sourceHead
    || (plan.latestEnterOrdinal ?? 0) > sourceHead || plan.exits.some(exit => exit.ordinal > sourceHead)) throw new TypeError('Invalid display snapshot frontier');
  return { serverInstanceId, chat, transcriptViewId, sourceHead, transientFeed, control, plan, submissions, processingPhase, display };
}
