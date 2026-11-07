import { parseDisplayWindowRequest, parseMemberWindowRequest, parseBodyDependencyRequest } from '../../../common/transcript-display-contract.js';
import { parseDisplayAuxiliaryRequest, parseResendSnapshotRequest, type ResendSnapshot } from '../../../common/transcript-display-auxiliary.js';
import type { ResendCandidate } from '../../../common/chat-view.js';
import type { ChatProcessingPhase } from '../../../common/chat-types.js';
import { parseDisplayOpenRequest, parsePlanPresentationRequest, type DisplayOpenResponse } from '../../../common/transcript-display-open.js';
import { ERROR_CODES, type ErrorCode } from '../../../common/error-codes.js';
import { toClientChatExecutionControlState } from '../chat-execution/control-state.js';
import type { ChatExecutionQueries } from '../chat-execution/types.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import type { ChatTransientFeedStore } from '../chats/chat-transient-feed.js';
import type { TranscriptDisplayService } from '../transcript-display/service.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { NativeTranscriptActivityService } from '../ledger/native-activity.js';
import { LedgerBulkOperationAbandonedError, LedgerFencedError, StaleTranscriptViewError } from '../ledger/errors.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';

interface DisplayRouteDeps {
  readonly display: TranscriptDisplayService;
  readonly ledger: Pick<TranscriptLedgerService, 'submissionOrdinals'>;
  readonly summaries: Pick<ChatListProjector, 'buildSummary'>;
  readonly execution: Pick<ChatExecutionQueries, 'readChatExecutionControl'>;
  readonly transientFeeds: Pick<ChatTransientFeedStore, 'snapshot'>;
  readonly nativeActivity: Pick<NativeTranscriptActivityService, 'requestCheck'>;
  readonly resendCandidates: (chatId: string) => readonly ResendCandidate[];
  readonly processingPhase: (chatId: string) => ChatProcessingPhase | null;
}

export function createTranscriptDisplayRoutes(deps: DisplayRouteDeps): RouteMap {
  const { display } = deps;
  const post = (run: (body: unknown, request: Request) => Promise<unknown>, serialized = false): RouteHandler => async request => {
    try {
      const body = await readDisplayRequest(request), result = await run(body, request);
      return serialized ? new Response(result as string, { headers: headers() }) : Response.json(result, { headers: headers() });
    } catch (error) {
      const response = jsonErrorFromUnknown(displayRouteError(error));
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
  };
  const routes: RouteMap = {
    '/api/v1/chats/transcript-display/open': { POST: post(async (body, request) => {
      const input = parseDisplayOpenRequest(body), opened = await display.open(input.chatId, input.expectedTranscriptViewId, request.signal);
      const control = toClientChatExecutionControlState(await deps.execution.readChatExecutionControl(input.chatId));
      const head = display.currentHead(input.chatId, opened.transcriptViewId), summary = deps.summaries.buildSummary(input.chatId);
      if (!summary) throw new DomainError('SESSION_NOT_FOUND', 'Chat not found.', 404, false);
      const response: DisplayOpenResponse = { ...opened, sourceHead: head.ordinal, serverInstanceId: display.serverInstanceId,
        chat: summary.chat, processingPhase: summary.processingPhase, control,
        transientFeed: deps.transientFeeds.snapshot({ chatId: input.chatId, transcriptViewId: opened.transcriptViewId }),
        plan: display.plans.snapshot(input.chatId, opened.transcriptViewId),
        submissions: deps.ledger.submissionOrdinals(input.chatId, head.viewId, input.outstandingClientMessageIds) };
      if (input.reason === 'activate') queueMicrotask(() => deps.nativeActivity.requestCheck(input.chatId, 'activation'));
      return response;
    }) },
    '/api/v1/chats/transcript-display/window': { POST: post((body, request) => display.window(parseDisplayWindowRequest(body), request.signal)) },
    '/api/v1/chats/transcript-display/members': { POST: post((body, request) => display.members(parseMemberWindowRequest(body), request.signal)) },
    '/api/v1/chats/transcript-display/bodies': { POST: post((body, request) => display.bodies(parseBodyDependencyRequest(body), request.signal), true) },
    '/api/v1/chats/transcript-display/resolve': { POST: post((body, request) => {
      const input = parseDisplayWindowRequest(body);
      if (input.anchor.kind !== 'around') throw new TypeError('Target ordinal is required');
      return display.resolve(input, input.anchor.ordinal, request.signal);
    }) },
    '/api/v1/chats/transcript-display/plan': { POST: post(async body => {
      const input = parsePlanPresentationRequest(body);
      if (input.serverInstanceId !== display.serverInstanceId) throw new DomainError('DISPLAY_STALE_CERTIFICATE', 'Refresh plan suggestions.', 409, true);
      display.currentHead(input.chatId, input.transcriptViewId);
      return display.plans.snapshot(input.chatId, input.transcriptViewId, input.afterOrdinal);
    }) },
    '/api/v1/chats/transcript-display/plan-detail': { POST: post((body, request) => display.planBody(parsePlanPresentationRequest(body), request.signal), true) },
    '/api/v1/chats/transcript-display/plan-dismiss': { POST: post(async body => {
      const input = parsePlanPresentationRequest(body);
      display.currentHead(input.chatId, input.transcriptViewId);
      return display.plans.dismiss(input);
    }) },
    '/api/v1/chats/transcript-display/retry': { POST: post(async body => {
      const input = parseDisplayOpenRequest(body);
      if (!input.expectedTranscriptViewId) throw new TypeError('Transcript view is required');
      display.currentHead(input.chatId, input.expectedTranscriptViewId);
      await display.retry(input.chatId);
      return { success: true };
    }) },
    '/api/v1/chats/transcript-display/resend': { POST: post(async body => {
      const input = parseResendSnapshotRequest(body);
      if (input.serverInstanceId !== display.serverInstanceId) throw new DomainError('DISPLAY_STALE_CERTIFICATE', 'Refresh resend candidates.', 409, true);
      const head = display.currentHead(input.chatId, input.transcriptViewId);
      const processingPhase = deps.processingPhase(input.chatId);
      return { ...input, sourceHead: head.ordinal, processingPhase,
        candidates: processingPhase === null ? deps.resendCandidates(input.chatId) : [] } satisfies ResendSnapshot;
    }) },
  };
  for (const kind of ['user-rows', 'subagents'] as const) routes[`/api/v1/chats/transcript-display/${kind}`] = {
    POST: post((body, request) => {
      const input = parseDisplayAuxiliaryRequest(body);
      if (kind === 'subagents' && input.limit > 50) throw new TypeError('Subagent summary limit exceeds 50');
      return display.auxiliary(kind, input, request.signal);
    }),
  };
  return routes;
}

function headers(): Record<string, string> { return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }; }

async function readDisplayRequest(request: Request): Promise<unknown> {
  const limit = 128 * 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new ValidationDomainError('Display request is too large');
  if (!request.body) throw new ValidationDomainError('Display request body is required');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new ValidationDomainError('Display request is too large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ValidationDomainError('Malformed display request'); }
}

function displayRouteError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  if (error instanceof TypeError) return new ValidationDomainError(error.message);
  if (error instanceof StaleTranscriptViewError) return new DomainError('STALE_TRANSCRIPT_VIEW', 'Transcript view was replaced.', 409, true);
  if (error instanceof LedgerFencedError) return new DomainError('TRANSCRIPT_UNAVAILABLE', 'The transcript ledger is unavailable.', 422, false);
  if (error instanceof LedgerBulkOperationAbandonedError) return new DomainError('DISPLAY_SUPERSEDED', 'Transcript request was superseded.', 409, true);
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('DISPLAY_')
    && (ERROR_CODES as readonly string[]).includes(error.code)) {
    return new DomainError(error.code as ErrorCode, 'Transcript display is unavailable. Retry the request.', error.code === 'DISPLAY_INVALID_REQUEST' ? 400 : 503, true);
  }
  return error;
}
