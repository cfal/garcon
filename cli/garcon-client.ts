import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { parseAgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type {
  AgentRunCommandRequest,
  CommandAcceptedResponse,
  AgentStopCommandRequest,
  AgentStopResponse,
  AgentTurnCommandResponse,
  StartChatCommandResponse,
  StartChatCommandRequest,
  SteerCommandRequest,
  SteerCommandResponse,
  PermissionDecisionCommandRequest,
} from '@garcon/common/chat-command-contracts';
import {
  parseAddChatRowResponse,
  parseChatRowTargetResponse,
  type AddChatRowRequest,
  type AddChatRowResponse,
  type ChatRowTargetResponse,
} from '@garcon/common/chat-row-contracts';
import { parseChatExecutionControlState } from '@garcon/common/chat-execution-control';
import { normalizeCommandTagMutationOutcome } from '@garcon/common/chat-tag-mutations';
import { CHAT_STOP_OUTCOMES, type ChatStopOutcome } from '@garcon/common/chat-types';
import { parseChatListResponse, type ChatListResponse } from '@garcon/common/chat-list';
import { parseParentChatRef, type ParentChatRef } from '@garcon/common/chat-parentage';
import {
  parseChatHistoryResponse,
  type ChatHistoryResponse,
  type ChatMessagesRequest,
} from '@garcon/common/chat-view';
import {
  parseChatSearchResponse,
  parseTranscriptSearchStatusResponse,
  parseTranscriptSearchRebuildResponse,
  type ChatSearchRequest,
  type ChatSearchResponse,
  type TranscriptSearchStatusResponse,
  type TranscriptSearchRebuildResponse,
} from '@garcon/common/chat-search';
import { stableJsonStringify } from '@garcon/common/json';
import {
  parseChatSnapshotResponse,
  type ChatSnapshotResponse,
} from '@garcon/common/chat-snapshot';
import type {
  UpdateChatTitleRequest,
  UpdateChatTitleResponse,
} from '@garcon/common/chat-title-contracts';
import { parseUpdateChatTitleResponse } from '@garcon/common/chat-title-contracts';
import {
  parseSetChatOrderStateResponse,
  type SetChatArchivedRequest,
  type SetChatOrderStateResponse,
  type SetChatPinnedRequest,
} from '@garcon/common/chat-order-contracts';
import {
  parseSetChatTagsResponse,
  type SetChatTagsRequest,
  type SetChatTagsResponse,
} from '@garcon/common/chat-tags-contracts';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import {
  normalizePreamblesSnapshot,
  type PreamblesSnapshot,
} from '@garcon/common/preambles';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import {
  parseNativeSessionLookupResponse,
  type NativeSessionLookupRequest,
} from '@garcon/common/native-session-lookup';
import {
  parseTranscriptExportResponse,
  type TranscriptExportCategory,
  type TranscriptExportFormat,
  type TranscriptExportResponse,
} from '@garcon/common/chat-export-contracts';
import {
  parseChatHandoffArtifactResponse,
  type ChatHandoffArtifactResponse,
} from '@garcon/common/chat-handoff-artifact-contracts';
import { normalizeRemoteSettingsSnapshot } from '@garcon/common/settings';
import { abortableDelay } from './abortable-delay.js';
import { CliError, type CliErrorPhase } from './errors.js';
import { probeRuntime, type RuntimeConnection } from './discovery.js';

const REQUEST_TIMEOUT_MS = 30_000;
const HANDOFF_REQUEST_TIMEOUT_MS = 10 * 60_000;
const DOCUMENT_REQUEST_TIMEOUT_MS = 120_000;
const SUBMISSION_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 5_000;

interface ErrorEnvelope {
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

export class GarconHttpError extends CliError {
  constructor(
    phase: CliErrorPhase,
    message: string,
    readonly status: number,
    readonly errorCode: string | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(
      phase,
      message,
      errorCode === 'SESSION_NOT_FOUND'
        || errorCode === 'NATIVE_SESSION_NOT_FOUND'
        || errorCode === 'NATIVE_SESSION_AMBIGUOUS'
        || errorCode === 'UNSUPPORTED_AGENT'
        || errorCode === 'EXPECTED_AGENT_MISMATCH'
        || errorCode === 'EXPLICIT_BYPASS_REQUIRED'
        || errorCode === 'TRANSCRIPT_SEARCH_DISABLED'
        || ((phase === 'catalog resolution'
          || phase === 'title update'
          || phase === 'export'
          || phase === 'handoff artifact'
          || phase === 'chat search') && status === 400)
        ? 2
        : 3,
    );
    this.name = 'GarconHttpError';
  }
}

export class GarconTransportError extends CliError {
  constructor(phase: CliErrorPhase, message: string, options?: ErrorOptions) {
    super(phase, message, 3, options);
    this.name = 'GarconTransportError';
  }
}

export interface GarconClientOptions extends RuntimeConnection {
  fetch?: typeof fetch;
  submissionDelay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function responseBody(response: Response, phase: CliErrorPhase): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new GarconTransportError(phase, 'the Garcon response body could not be read', {
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseCommandAcceptedResponse(value: unknown): CommandAcceptedResponse {
  const raw = record(value);
  const tagMutation = raw?.tagMutation === undefined
    ? undefined
    : normalizeCommandTagMutationOutcome(raw.tagMutation);
  if (
    raw?.success !== true
    || typeof raw.commandType !== 'string'
    || typeof raw.clientRequestId !== 'string'
    || typeof raw.chatId !== 'string'
    || (raw.status !== 'accepted' && raw.status !== 'duplicate')
    || typeof raw.acceptedAt !== 'string'
    || tagMutation === null
  ) {
    throw new CliError('submission', 'server returned an invalid command acceptance response', 3);
  }
  return {
    success: true,
    commandType: raw.commandType,
    clientRequestId: raw.clientRequestId,
    chatId: raw.chatId,
    ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}),
    status: raw.status,
    acceptedAt: raw.acceptedAt,
    ...(tagMutation === undefined ? {} : { tagMutation }),
  };
}

function parseAcceptedResponse(value: unknown): AgentTurnCommandResponse {
  const raw = record(value);
  const accepted = parseCommandAcceptedResponse(value);
  if (typeof accepted.chatId !== 'string' || typeof accepted.turnId !== 'string') {
    throw new CliError('submission', 'server returned an invalid command acceptance response', 3);
  }
  return {
    ...accepted,
    chatId: accepted.chatId,
    turnId: accepted.turnId,
    parentChat: parseRequiredParentChat(raw),
  };
}

function parseRequiredParentChat(raw: Record<string, unknown> | null): ParentChatRef | null {
  if (!raw || !Object.hasOwn(raw, 'parentChat')) {
    throw new CliError('submission', 'server returned an invalid command parent relation', 3);
  }
  if (raw.parentChat === null) return null;
  const parsed = parseParentChatRef(raw.parentChat);
  if (!parsed) {
    throw new CliError('submission', 'server returned an invalid command parent relation', 3);
  }
  return parsed;
}

function parseStartResponse(value: unknown): StartChatCommandResponse {
  const accepted = parseAcceptedResponse(value);
  const raw = record(value);
  if (!raw || !Object.hasOwn(raw, 'chat')) {
    throw new CliError('submission', 'server returned an invalid started chat', 3);
  }
  let chat: ChatListResponse['sessions'][number] | null;
  if (raw.chat === null) {
    chat = null;
  } else {
    try {
      chat = parseChatListResponse({
        sessions: [raw.chat],
        total: 1,
        lastSelectedChatId: null,
      }).sessions[0]!;
    } catch (error) {
      throw new CliError('submission', 'server returned an invalid started chat', 3, { cause: error });
    }
  }
  return { ...accepted, chat };
}

function parseStopResponse(value: unknown): AgentStopResponse {
  const raw = record(value);
  if (
    raw?.success !== true
    || typeof raw.commandType !== 'string'
    || typeof raw.clientRequestId !== 'string'
    || typeof raw.chatId !== 'string'
    || (raw.status !== 'accepted' && raw.status !== 'duplicate')
    || typeof raw.acceptedAt !== 'string'
    || !CHAT_STOP_OUTCOMES.includes(raw.outcome as ChatStopOutcome)
  ) {
    throw new CliError('submission', 'server returned an invalid stop response', 3);
  }
  const control = parseChatExecutionControlState(raw.control);
  if (!control) {
    throw new CliError('submission', 'server returned an invalid stop control state', 3);
  }
  return {
    success: true,
    commandType: raw.commandType,
    clientRequestId: raw.clientRequestId,
    chatId: raw.chatId,
    status: raw.status,
    acceptedAt: raw.acceptedAt,
    outcome: raw.outcome as ChatStopOutcome,
    control,
    parentChat: parseRequiredParentChat(raw),
  };
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()))
    : null;
}

function isAmbiguousSubmissionError(error: unknown): boolean {
  if (error instanceof GarconTransportError) return true;
  if (error instanceof GarconHttpError) {
    return error.status === 408
      || error.status === 425
      || error.status === 429
      || error.status >= 500;
  }
  return error instanceof CliError && error.phase === 'submission';
}

// Steer-specific recovery: an explicit Garcon error envelope always carries an
// errorCode and is definitive even on HTTP 500/503, so exact retries cannot
// improve a ledger-recorded outcome. Only transport failures and errorCode-less
// intermediary 408/425/429/5xx responses remain ambiguous.
function isAmbiguousSteerSubmissionError(error: unknown): boolean {
  if (error instanceof GarconTransportError) return true;
  if (error instanceof GarconHttpError) {
    return error.errorCode === null && (
      error.status === 408
      || error.status === 425
      || error.status === 429
      || error.status >= 500
    );
  }
  return error instanceof CliError && error.phase === 'submission';
}

export class GarconClient {
  readonly #baseUrl: string;
  readonly #instanceId: string;
  readonly #capability: string;
  readonly #fetch: typeof fetch;
  readonly #submissionDelay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: GarconClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#instanceId = options.instanceId;
    this.#capability = options.localCapability;
    this.#fetch = options.fetch ?? fetch;
    this.#submissionDelay = options.submissionDelay ?? abortableDelay;
  }

  get serverInstanceId(): string {
    return this.#instanceId;
  }

  async getModelCatalog(
    agentId?: string,
    signal?: AbortSignal,
  ): Promise<ModelCatalogResponse> {
    const query = agentId === undefined ? '' : `?agent=${encodeURIComponent(agentId)}`;
    const value = await this.#request(
      'catalog resolution',
      'GET',
      `/api/v1/models${query}`,
      undefined,
      signal,
    );
    const raw = record(value);
    const catalog = record(raw?.catalog);
    if (!Array.isArray(catalog?.agents) || !Array.isArray(catalog.apiProviders)) {
      throw new CliError('catalog resolution', 'server returned an invalid model catalog', 3);
    }
    return value as ModelCatalogResponse;
  }

  async getSettings(signal?: AbortSignal): Promise<RemoteSettingsSnapshot> {
    const value = await this.#request('catalog resolution', 'GET', '/api/v1/app/settings', undefined, signal);
    const settings = normalizeRemoteSettingsSnapshot(value);
    if (!settings) throw new CliError('catalog resolution', 'server returned invalid settings', 3);
    return settings;
  }

  async getPreambles(signal?: AbortSignal): Promise<PreamblesSnapshot> {
    const value = await this.#request(
      'catalog resolution',
      'GET',
      '/api/v1/preambles',
      undefined,
      signal,
    );
    const snapshot = normalizePreamblesSnapshot(value);
    if (!snapshot) {
      throw new CliError('catalog resolution', 'server returned an invalid preamble catalog', 3);
    }
    return snapshot;
  }

  async listChats(signal?: AbortSignal): Promise<ChatListResponse> {
    const value = await this.#request('chat discovery', 'GET', '/api/v1/chats', undefined, signal);
    try {
      return parseChatListResponse(value);
    } catch (error) {
      throw new CliError('chat discovery', 'server returned an invalid chat list', 3, {
        cause: error,
      });
    }
  }

  async getChatMessages(
    request: ChatMessagesRequest,
    signal?: AbortSignal,
  ): Promise<ChatHistoryResponse> {
    const query = new URLSearchParams({
      chatId: request.chatId,
      limit: String(request.limit ?? 50),
    });
    if (request.beforeOrdinal !== undefined) {
      query.set('beforeOrdinal', String(request.beforeOrdinal));
    }
    if (request.transcriptViewId !== undefined) {
      query.set('transcriptViewId', request.transcriptViewId);
    }
    if (request.purpose !== undefined) query.set('purpose', request.purpose);
    const value = await this.#request(
      'chat read',
      'GET',
      `/api/v1/chats/messages?${query.toString()}`,
      undefined,
      signal,
    );
    try {
      return parseChatHistoryResponse(request, value);
    } catch (error) {
      throw new CliError('chat read', 'server returned an invalid transcript page', 3, {
        cause: error,
      });
    }
  }

  async searchChats(
    request: ChatSearchRequest,
    signal?: AbortSignal,
  ): Promise<ChatSearchResponse> {
    const value = await this.#request(
      'chat search',
      'POST',
      '/api/v1/chats/search',
      request,
      signal,
    );
    try {
      return parseChatSearchResponse(request, value);
    } catch (error) {
      throw new CliError('chat search', 'server returned an invalid search response', 3, {
        cause: error,
      });
    }
  }

  async getTranscriptSearchStatus(signal?: AbortSignal): Promise<TranscriptSearchStatusResponse> {
    const value = await this.#request(
      'chat search',
      'GET',
      '/api/v1/chats/search/status',
      undefined,
      signal,
    );
    try {
      return parseTranscriptSearchStatusResponse(value);
    } catch (error) {
      throw new CliError('chat search', 'server returned an invalid transcript search status', 3, {
        cause: error,
      });
    }
  }

  async rebuildTranscriptSearch(signal?: AbortSignal): Promise<TranscriptSearchRebuildResponse> {
    const value = await this.#request(
      'chat search',
      'POST',
      '/api/v1/chats/search/rebuild',
      undefined,
      signal,
      null,
    );
    try {
      return parseTranscriptSearchRebuildResponse(value);
    } catch (error) {
      throw new CliError('chat search', 'server returned an invalid transcript search rebuild response', 3, {
        cause: error,
      });
    }
  }

  async setTranscriptSearchEnabled(
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<RemoteSettingsSnapshot> {
    const value = await this.#request(
      'chat search',
      'PUT',
      '/api/v1/app/settings',
      { features: { transcriptSearch: { enabled } } },
      signal,
      null,
    );
    const response = record(value);
    const rawSettings = record(response?.settings);
    const rawFeatures = record(rawSettings?.features);
    const rawTranscriptSearch = record(rawFeatures?.transcriptSearch);
    const settings = normalizeRemoteSettingsSnapshot(rawSettings);
    if (
      response?.success !== true
      || rawTranscriptSearch?.enabled !== enabled
      || !settings
      || settings.features.transcriptSearch.enabled !== enabled
    ) {
      throw new CliError('chat search', 'server returned an invalid transcript search setting', 3);
    }
    return settings;
  }

  async getChatSnapshot(
    chatId: string,
    messageLimit: number,
    signal?: AbortSignal,
  ): Promise<ChatSnapshotResponse> {
    const query = new URLSearchParams({ chatId, limit: String(messageLimit) });
    const value = await this.#request(
      'chat status',
      'GET',
      `/api/v1/chats/snapshot?${query.toString()}`,
      undefined,
      signal,
    );
    let snapshot: ChatSnapshotResponse;
    try {
      snapshot = parseChatSnapshotResponse(value);
    } catch (error) {
      throw new CliError('chat status', 'server returned an invalid chat snapshot', 3, {
        cause: error,
      });
    }
    if (
      snapshot.chat.id !== chatId
      || snapshot.messageLimit !== messageLimit
      || snapshot.control.serverInstanceId !== this.#instanceId
    ) {
      throw new CliError('chat status', 'server returned an uncorrelated chat snapshot', 3);
    }
    return snapshot;
  }

  async getTranscriptExport(
    request: {
      readonly chatId: string;
      readonly format: TranscriptExportFormat;
      readonly exclusions: readonly TranscriptExportCategory[];
    },
    signal?: AbortSignal,
  ): Promise<TranscriptExportResponse> {
    const query = new URLSearchParams({ chatId: request.chatId, format: request.format });
    for (const category of request.exclusions) query.append('exclude', category);
    const value = await this.#request(
      'export',
      'GET',
      `/api/v1/chats/export?${query.toString()}`,
      undefined,
      signal,
      DOCUMENT_REQUEST_TIMEOUT_MS,
    );
    let response: TranscriptExportResponse;
    try {
      response = parseTranscriptExportResponse(value);
    } catch (error) {
      throw new CliError('export', 'server returned an invalid transcript export', 3, {
        cause: error,
      });
    }
    if (
      response.chatId !== request.chatId
      || response.format !== request.format
      || response.exclusions.length !== request.exclusions.length
      || response.exclusions.some((category, index) => category !== request.exclusions[index])
    ) {
      throw new CliError('export', 'server returned an uncorrelated transcript export', 3);
    }
    return response;
  }

  async getChatHandoffArtifact(
    request: {
      readonly chatId: string;
      readonly contextWindowTokens: number;
    },
    signal?: AbortSignal,
  ): Promise<ChatHandoffArtifactResponse> {
    const query = new URLSearchParams({
      chatId: request.chatId,
      contextWindowTokens: String(request.contextWindowTokens),
    });
    const value = await this.#request(
      'handoff artifact',
      'GET',
      `/api/v1/chats/handoff-artifact?${query.toString()}`,
      undefined,
      signal,
      DOCUMENT_REQUEST_TIMEOUT_MS,
    );
    let response: ChatHandoffArtifactResponse;
    try {
      response = parseChatHandoffArtifactResponse(value);
    } catch (error) {
      throw new CliError(
        'handoff artifact',
        'server returned an invalid handoff artifact',
        3,
        { cause: error },
      );
    }
    if (
      response.chatId !== request.chatId
      || response.contextWindowTokens !== request.contextWindowTokens
    ) {
      throw new CliError(
        'handoff artifact',
        'server returned an uncorrelated handoff artifact',
        3,
      );
    }
    return response;
  }

  async lookupNativeSession(
    request: NativeSessionLookupRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    const value = await this.#request(
      'native session lookup',
      'POST',
      '/api/v1/chats/lookup-native-session',
      request,
      signal,
    );
    try {
      return parseNativeSessionLookupResponse(value).chatId;
    } catch (error) {
      throw new CliError(
        'native session lookup',
        'server returned an invalid native session lookup response',
        3,
        { cause: error },
      );
    }
  }

  startChat(request: StartChatCommandRequest, signal?: AbortSignal): Promise<StartChatCommandResponse> {
    return this.#submitTurn(
      '/api/v1/chats/start',
      'chat-start',
      request,
      signal,
      isAmbiguousSubmissionError,
      REQUEST_TIMEOUT_MS,
      parseStartResponse,
    );
  }

  runChat(request: AgentRunCommandRequest, signal?: AbortSignal): Promise<AgentTurnCommandResponse> {
    return this.#submitTurn(
      '/api/v1/chats/run',
      'agent-run',
      request,
      signal,
      isAmbiguousSubmissionError,
      request.handoff ? HANDOFF_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      parseAcceptedResponse,
    );
  }

  steerChat(request: SteerCommandRequest, signal?: AbortSignal): Promise<SteerCommandResponse> {
    return this.#submitTurn(
      '/api/v1/chats/steer',
      'steer',
      request,
      signal,
      isAmbiguousSteerSubmissionError,
      REQUEST_TIMEOUT_MS,
      parseAcceptedResponse,
    )
      .then((response) => {
        // #submitTurn rejects mismatched commandType values, so a correlated
        // success is guaranteed to carry the steer literal.
        return response as SteerCommandResponse;
      });
  }

  stopChat(request: AgentStopCommandRequest, signal?: AbortSignal): Promise<AgentStopResponse> {
    return this.#submitCorrelated({
      route: '/api/v1/chats/stop',
      request,
      parse: parseStopResponse,
      correlates: (response, submitted) => (
        response.commandType === 'agent-stop'
        && response.clientRequestId === submitted.clientRequestId
        && response.chatId === submitted.chatId
      ),
      ambiguityDescription: `the stop command for chat ${request.chatId}`,
    }, signal);
  }

  decidePermission(
    request: PermissionDecisionCommandRequest,
    signal?: AbortSignal,
  ): Promise<CommandAcceptedResponse> {
    return this.#submitCorrelated({
      route: '/api/v1/chats/permissions/decision',
      request,
      parse: parseCommandAcceptedResponse,
      correlates: (response, submitted) => (
        response.commandType === 'permission-decision'
        && response.clientRequestId === submitted.clientRequestId
        && response.chatId === submitted.chatId
      ),
      ambiguityDescription: `the permission decision for chat ${request.chatId}`,
      ambiguous: (error) => (
        isAmbiguousSubmissionError(error)
        && !(error instanceof GarconHttpError
          && error.errorCode === 'PERMISSION_DECISION_OUTCOME_UNKNOWN')
      ),
    }, signal);
  }

  async getChatRowTarget(
    chatId: string,
    signal?: AbortSignal,
  ): Promise<ChatRowTargetResponse> {
    const query = new URLSearchParams({ chatId });
    const value = await this.#request(
      'submission',
      'GET',
      `/api/v1/chats/rows?${query.toString()}`,
      undefined,
      signal,
    );
    const target = parseChatRowTargetResponse(value);
    if (!target || target.chatId !== chatId) {
      throw new CliError('submission', 'server returned an invalid chat row target', 3);
    }
    return target;
  }

  addChatRow(
    request: AddChatRowRequest,
    signal?: AbortSignal,
  ): Promise<AddChatRowResponse> {
    return this.#submitCorrelated({
      route: '/api/v1/chats/rows',
      request,
      parse(value) {
        const response = parseAddChatRowResponse(value);
        if (!response) {
          throw new CliError('submission', 'server returned an invalid add-row response', 3);
        }
        return response;
      },
      correlates: (response, submitted) => (
        response.commandType === 'chat-row-add'
        && response.clientRequestId === submitted.clientRequestId
        && response.clientMessageId === submitted.clientMessageId
        && response.chatId === submitted.chatId
        && response.transcriptViewId === submitted.transcriptViewId
        && stableJsonStringify(response.presentation) === stableJsonStringify(submitted.presentation)
        && response.format === submitted.format
        && response.disclosure === submitted.disclosure
      ),
      ambiguityDescription: `the add-row command for chat ${request.chatId}`,
    }, signal);
  }

  async updateChatTitle(
    request: UpdateChatTitleRequest,
    signal?: AbortSignal,
  ): Promise<UpdateChatTitleResponse> {
    const value = await this.#request(
      'title update',
      'PUT',
      '/api/v1/app/session-name',
      request,
      signal,
    );
    const response = parseUpdateChatTitleResponse(value);
    if (!response || response.chatId !== request.chatId || response.title !== request.title.trim()) {
      throw new CliError('title update', 'server returned an invalid title update response', 3);
    }
    return response;
  }

  async setChatPinned(
    request: SetChatPinnedRequest,
    signal?: AbortSignal,
  ): Promise<SetChatOrderStateResponse> {
    const value = await this.#request(
      'submission',
      'PUT',
      '/api/v1/chats/pin',
      request,
      signal,
    );
    const response = parseSetChatOrderStateResponse(value);
    if (!response || response.chatId !== request.chatId || response.isPinned !== request.isPinned) {
      throw new CliError('submission', 'server returned an invalid pinned-state response', 3);
    }
    return response;
  }

  async setChatArchived(
    request: SetChatArchivedRequest,
    signal?: AbortSignal,
  ): Promise<SetChatOrderStateResponse> {
    const value = await this.#request(
      'submission',
      'PUT',
      '/api/v1/chats/archive',
      request,
      signal,
    );
    const response = parseSetChatOrderStateResponse(value);
    if (!response || response.chatId !== request.chatId || response.isArchived !== request.isArchived) {
      throw new CliError('submission', 'server returned an invalid archived-state response', 3);
    }
    return response;
  }

  async setChatTags(
    request: SetChatTagsRequest,
    signal?: AbortSignal,
  ): Promise<SetChatTagsResponse> {
    const value = await this.#request(
      'submission',
      'PATCH',
      '/api/v1/chats/tags',
      request,
      signal,
    );
    const response = parseSetChatTagsResponse(value);
    if (
      !response
      || response.chatId !== request.chatId
      || stableJsonStringify(response.tags) !== stableJsonStringify(request.tags)
    ) {
      throw new CliError('submission', 'server returned an invalid tag-state response', 3);
    }
    return response;
  }

  async getTurnReceipt(chatId: string, turnId: string, signal?: AbortSignal): Promise<AgentTurnReceipt> {
    const query = new URLSearchParams({ chatId, turnId });
    const value = await this.#request(
      'receipt polling',
      'GET',
      `/api/v1/chats/turn-receipt?${query.toString()}`,
      undefined,
      signal,
    );
    try {
      return parseAgentTurnReceipt(value);
    } catch (error) {
      throw new CliError('receipt polling', 'server returned an invalid turn receipt', 3, {
        cause: error,
      });
    }
  }

  async verifyRuntime(signal?: AbortSignal): Promise<boolean> {
    return probeRuntime(
      this.#baseUrl,
      this.#instanceId,
      this.#capability,
      this.#fetch,
      signal,
    );
  }

  async #submitTurn<TResponse extends AgentTurnCommandResponse>(
    route: string,
    commandType: 'chat-start' | 'agent-run' | 'steer',
    request: StartChatCommandRequest | AgentRunCommandRequest | SteerCommandRequest,
    signal: AbortSignal | undefined,
    ambiguous: (error: unknown) => boolean,
    timeoutMs = REQUEST_TIMEOUT_MS,
    parse: (value: unknown) => TResponse,
  ): Promise<TResponse> {
    return this.#submitCorrelated({
      route,
      request,
      parse,
      correlates: (response, submitted) => (
        response.commandType === commandType
        && response.clientRequestId === submitted.clientRequestId
        && response.chatId === submitted.chatId
      ),
      ambiguityDescription: `the command for chat ${request.chatId}`,
      ambiguous,
      timeoutMs,
    }, signal);
  }

  // Repeats one logical command identity after an ambiguous transport result,
  // always after verifying that the server instance is unchanged. Exact request
  // replay is safe because each receiving mutation contract is idempotent.
  async #submitCorrelated<TRequest extends { readonly clientRequestId: string }, TResponse>(
    options: {
      route: string;
      request: TRequest;
      parse: (value: unknown) => TResponse;
      correlates: (response: TResponse, request: TRequest) => boolean;
      ambiguityDescription: string;
      ambiguous?: (error: unknown) => boolean;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<TResponse> {
    const ambiguous = options.ambiguous ?? isAmbiguousSubmissionError;
    for (let attempt = 0; attempt < SUBMISSION_ATTEMPTS; attempt += 1) {
      try {
        const accepted = options.parse(
          await this.#request(
            'submission',
            'POST',
            options.route,
            options.request,
            signal,
            options.timeoutMs,
          ),
        );
        if (
          !options.correlates(accepted, options.request)
        ) {
          throw new CliError('submission', 'server returned an uncorrelated command acceptance', 3);
        }
        return accepted;
      } catch (error) {
        if (!ambiguous(error) || signal?.aborted) throw error;
        if (attempt === SUBMISSION_ATTEMPTS - 1) {
          throw new CliError(
            'transport recovery',
            `${options.ambiguityDescription} may still be running in Garcon; exact submission recovery was exhausted`,
            3,
            { cause: error },
          );
        }
        const retryAfterMs = error instanceof GarconHttpError ? error.retryAfterMs ?? 0 : 0;
        await this.#submissionDelay(Math.max(100 * (attempt + 1), retryAfterMs), signal);
        let sameRuntime: boolean;
        try {
          sameRuntime = await this.verifyRuntime(signal);
        } catch (verificationError) {
          throw new CliError(
            'transport recovery',
            `${options.ambiguityDescription} may still be running, but Garcon could not be verified before retry`,
            3,
            { cause: verificationError },
          );
        }
        if (!sameRuntime) {
          throw new CliError(
            'transport recovery',
            `${options.ambiguityDescription} may have been accepted, but Garcon restarted after submission; the command was not retried`,
            3,
          );
        }
      }
    }
    throw new CliError('transport recovery', 'submission recovery exhausted unexpectedly', 3);
  }

  async #request(
    phase: CliErrorPhase,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    route: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMs: number | null = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    // A null deadline is for maintenance calls whose server work is unbounded
    // (a serial per-record drain); the caller's own signal still cancels.
    const timeoutSignal = timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);
    const requestSignal = timeoutSignal
      ? (signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal)
      : signal;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${route}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.#capability}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new GarconTransportError(phase, 'request could not reach the Garcon server', {
        cause: error,
      });
    }

    const value = await responseBody(response, phase);
    if (!response.ok) {
      const envelope = record(value) as ErrorEnvelope | null;
      const errorCode = typeof envelope?.errorCode === 'string' ? envelope.errorCode : null;
      const message = typeof envelope?.error === 'string'
        ? envelope.error
        : `Garcon server returned HTTP ${response.status}`;
      throw new GarconHttpError(
        response.status === 401 || response.status === 403 ? 'authentication' : phase,
        `${message} (HTTP ${response.status}${errorCode ? `, ${errorCode}` : ''})`,
        response.status,
        errorCode,
        envelope?.retryable === true || response.status >= 500,
        retryAfterMilliseconds(response.headers.get('Retry-After')),
      );
    }
    if (value === null) throw new CliError(phase, 'server returned invalid JSON', 3);
    return value;
  }
}
