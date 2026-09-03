export type JsonRpcId = string | number;

export interface JsonRpcSuccess<T = unknown> {
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcFailure {
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification<T = unknown> {
  method: string;
  params?: T;
}

export interface JsonRpcServerRequest<T = unknown> {
  id: JsonRpcId;
  method: string;
  params?: T;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexThread {
  id: string;
  forkedFromId: string | null;
  parentThreadId?: string | null;
  sessionId?: string;
  historyMode?: 'legacy' | 'paginated';
  preview: string;
  ephemeral: boolean;
  model?: string | null;
  reasoningEffort?: string | null;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: CodexThreadStatus;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: unknown;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: unknown;
  name: string | null;
  turns: CodexTurn[];
}

export type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] };

type CodexHttpErrorInfo = { httpStatusCode: number | null };

export type CodexErrorInfo =
  | 'contextWindowExceeded'
  | 'sessionBudgetExceeded'
  | 'usageLimitExceeded'
  | 'rateLimitExceeded'
  | 'serverOverloaded'
  | 'cyberPolicy'
  | 'misalignmentPolicyViolation'
  | 'internalServerError'
  | 'unauthorized'
  | 'badRequest'
  | 'threadRollbackFailed'
  | 'sandboxError'
  | 'other'
  | { httpConnectionFailed: CodexHttpErrorInfo }
  | { responseStreamConnectionFailed: CodexHttpErrorInfo }
  | { responseStreamDisconnected: CodexHttpErrorInfo }
  | { responseTooManyFailedAttempts: CodexHttpErrorInfo }
  | { activeTurnNotSteerable: { turnKind: 'review' | 'compact' } };

export interface CodexTurnError {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
  misalignment?: {
    errorType?: string | null;
    detailedExplanation?: string | null;
    steer?: { message: string } | null;
  } | null;
}

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  itemsView: 'notLoaded' | 'summary' | 'full';
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: CodexTurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface ThreadTurnsListParams {
  readonly threadId: string;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly sortDirection: 'asc' | 'desc';
  readonly itemsView: 'notLoaded' | 'summary' | 'full';
}

export interface ThreadTurnsListResponse {
  readonly data: CodexTurn[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
}

export interface ThreadItemEntry {
  readonly turnId: string;
  readonly item: CodexThreadItem;
}

export interface ThreadItemsListParams {
  readonly threadId: string;
  readonly turnId?: string | null;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly sortDirection: 'asc' | 'desc';
}

export interface ThreadItemsListResponse {
  readonly data: ThreadItemEntry[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements?: unknown[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export type CodexWebSearchAction =
  | { type: 'search'; query?: string | null; queries?: string[] | null }
  | { type: 'openPage' | 'open_page'; url?: string | null }
  | { type: 'findInPage' | 'find_in_page'; url?: string | null; pattern?: string | null }
  | { type: 'other' };

export type CodexCollabAgentTool =
  | 'spawnAgent'
  | 'sendInput'
  | 'resumeAgent'
  | 'wait'
  | 'closeAgent'
  | 'sendMessage'
  | 'followupTask'
  | 'interruptAgent'
  | 'listAgents';
export type CodexCollabAgentToolCallStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted';
export type CodexCollabAgentStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound';

export interface CodexCollabAgentState {
  status: CodexCollabAgentStatus;
  message: string | null;
}

export type CodexFunctionCallOutputContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' | 'original' | null }
  | { type: 'input_audio'; audio_url: string }
  | { type: 'encrypted_content'; encrypted_content: string };

export type CodexThreadItem =
  | { type: 'userMessage'; id: string; content: CodexUserInput[]; clientId?: string | null }
  | { type: 'hookPrompt'; id: string; fragments: unknown[] }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null; memoryCitation: unknown }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      processId: string | null;
      source: string;
      status: string;
      commandActions: unknown[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { type: 'fileChange'; id: string; changes: Array<{ path?: string; kind?: string }>; status: string }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: unknown;
      result: unknown;
      error: unknown;
      durationMs: number | null;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      namespace: string | null;
      tool: string;
      arguments: unknown;
      status: string;
      contentItems: unknown[] | null;
      success: boolean | null;
      durationMs: number | null;
    }
  | {
      type: 'functionCallOutput';
      id: string;
      name: string;
      namespace?: string | null;
      output: string | CodexFunctionCallOutputContentItem[];
    }
  | {
      type: 'collabAgentToolCall';
      id: string;
      tool: CodexCollabAgentTool;
      status: CodexCollabAgentToolCallStatus;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
      model: string | null;
      reasoningEffort: string | null;
      agentsStates: Record<string, CodexCollabAgentState>;
    }
  | {
      type: 'subAgentActivity';
      id: string;
      kind: 'started' | 'interacted' | 'interrupted' | 'completed';
      agentThreadId: string;
      agentPath: string;
    }
  | { type: 'webSearch'; id: string; query: string; action: CodexWebSearchAction | null }
  | { type: 'imageView'; id: string; path: string }
  | { type: 'sleep'; id: string; durationMs: number }
  | { type: 'imageGeneration'; id: string; status: string; revisedPrompt: string | null; result: string; savedPath?: string }
  | { type: 'enteredReviewMode'; id: string; review: string }
  | { type: 'exitedReviewMode'; id: string; review: string }
  | { type: 'contextCompaction'; id: string };

const CODEX_THREAD_ITEM_TYPES = new Set<CodexThreadItem['type']>([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'functionCallOutput',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
]);

const CODEX_TURN_STATUSES = new Set<CodexTurn['status']>([
  'completed',
  'interrupted',
  'failed',
  'inProgress',
]);

const CODEX_ERROR_INFO_STRINGS = new Set<Extract<CodexErrorInfo, string>>([
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'serverOverloaded',
  'cyberPolicy',
  'misalignmentPolicyViolation',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'other',
]);

const CODEX_ITEMS_VIEWS = new Set<CodexTurn['itemsView']>([
  'notLoaded',
  'summary',
  'full',
]);

export function parseThreadTurnsListResponse(value: unknown): ThreadTurnsListResponse {
  const response = protocolRecord(value, 'thread/turns/list response');
  if (!Array.isArray(response.data)) {
    throw new Error('Invalid thread/turns/list response data');
  }
  const nextCursor = nullableProtocolString(response.nextCursor, 'thread/turns/list nextCursor');
  const backwardsCursor = nullableProtocolString(response.backwardsCursor, 'thread/turns/list backwardsCursor');
  return {
    data: response.data.map((turn, index) => parseCodexTurn(turn, index)),
    nextCursor,
    backwardsCursor,
  };
}

function parseCodexTurn(value: unknown, index: number): CodexTurn {
  const turn = protocolRecord(value, `turn ${index}`);
  if (typeof turn.id !== 'string' || !turn.id) throw new Error(`Invalid Codex turn ${index} id`);
  if (!CODEX_ITEMS_VIEWS.has(turn.itemsView as CodexTurn['itemsView'])) {
    throw new Error(`Invalid Codex turn ${turn.id} itemsView`);
  }
  if (!CODEX_TURN_STATUSES.has(turn.status as CodexTurn['status'])) {
    throw new Error(`Invalid Codex turn ${turn.id} status`);
  }
  if (!Array.isArray(turn.items)) throw new Error(`Invalid Codex turn ${turn.id} items`);
  const items = turn.items.map((item, itemIndex) => (
    parseCodexThreadItem(item, `Codex turn ${turn.id} item ${itemIndex}`)
  ));
  const error = parseCodexTurnError(turn.error, `Codex turn ${turn.id} error`);
  return {
    id: turn.id,
    items,
    itemsView: turn.itemsView as CodexTurn['itemsView'],
    status: turn.status as CodexTurn['status'],
    error,
    startedAt: nullableProtocolNumber(turn.startedAt, `turn ${turn.id} startedAt`),
    completedAt: nullableProtocolNumber(turn.completedAt, `turn ${turn.id} completedAt`),
    durationMs: nullableProtocolNumber(turn.durationMs, `turn ${turn.id} durationMs`),
  };
}

function parseCodexTurnError(value: unknown, label: string): CodexTurnError | null {
  if (value === null || value === undefined) return null;
  const error = protocolRecord(value, label);
  protocolString(error.message, `${label} message`);
  nullableProtocolString(error.additionalDetails, `${label} additionalDetails`);
  validateCodexErrorInfo(error.codexErrorInfo, `${label} codexErrorInfo`);
  if (error.misalignment !== null && error.misalignment !== undefined) {
    const misalignment = protocolRecord(error.misalignment, `${label} misalignment`);
    nullableProtocolString(misalignment.errorType, `${label} misalignment errorType`);
    nullableProtocolString(
      misalignment.detailedExplanation,
      `${label} misalignment detailedExplanation`,
    );
    if (misalignment.steer !== null && misalignment.steer !== undefined) {
      const steer = protocolRecord(misalignment.steer, `${label} misalignment steer`);
      protocolString(steer.message, `${label} misalignment steer message`);
    }
  }
  return error as unknown as CodexTurnError;
}

function validateCodexErrorInfo(value: unknown, label: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (!CODEX_ERROR_INFO_STRINGS.has(value as Extract<CodexErrorInfo, string>)) {
      throw new Error(`Invalid ${label}`);
    }
    return;
  }
  const info = protocolRecord(value, label);
  const keys = Object.keys(info);
  if (keys.length !== 1) throw new Error(`Invalid ${label}`);
  const [kind] = keys;
  const detail = protocolRecord(info[kind], `${label} ${kind}`);
  if (kind === 'activeTurnNotSteerable') {
    if (!['review', 'compact'].includes(String(detail.turnKind))) {
      throw new Error(`Invalid ${label} activeTurnNotSteerable turnKind`);
    }
    return;
  }
  if (![
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ].includes(kind)) throw new Error(`Invalid ${label}`);
  nullableProtocolNumber(detail.httpStatusCode, `${label} ${kind} httpStatusCode`);
}

export function parseThreadItemsListResponse(value: unknown): ThreadItemsListResponse {
  const response = protocolRecord(value, 'thread/items/list response');
  if (!Array.isArray(response.data)) {
    throw new Error('Invalid thread/items/list response data');
  }
  return {
    data: response.data.map((value, index) => {
      const entry = protocolRecord(value, `thread/items/list entry ${index}`);
      const turnId = protocolString(entry.turnId, `thread/items/list entry ${index} turnId`);
      if (!turnId) throw new Error(`Invalid thread/items/list entry ${index} turnId`);
      return {
        turnId,
        item: parseCodexThreadItem(entry.item, `thread/items/list entry ${index} item`),
      };
    }),
    nextCursor: nullableProtocolString(response.nextCursor, 'thread/items/list nextCursor'),
    backwardsCursor: nullableProtocolString(response.backwardsCursor, 'thread/items/list backwardsCursor'),
  };
}

function parseCodexThreadItem(value: unknown, label: string): CodexThreadItem {
  const item = protocolRecord(value, label);
  if (typeof item.id !== 'string' || !item.id) throw new Error(`Invalid ${label} id`);
  if (!CODEX_THREAD_ITEM_TYPES.has(item.type as CodexThreadItem['type'])) {
    throw new Error(`Unsupported Codex thread item type: ${String(item.type)}`);
  }
  validateCodexThreadItem(item, label);
  return item as unknown as CodexThreadItem;
}

function validateCodexThreadItem(item: Record<string, unknown>, label: string): void {
  switch (item.type) {
    case 'userMessage':
      protocolArray(item.content, `${label} content`);
      nullableProtocolString(item.clientId, `${label} clientId`);
      return;
    case 'hookPrompt':
      protocolArray(item.fragments, `${label} fragments`);
      return;
    case 'agentMessage':
    case 'plan':
      protocolString(item.text, `${label} text`);
      return;
    case 'reasoning':
      protocolStringArray(item.summary, `${label} summary`);
      protocolStringArray(item.content, `${label} content`);
      return;
    case 'commandExecution':
      protocolString(item.command, `${label} command`);
      protocolString(item.status, `${label} status`);
      nullableProtocolString(item.aggregatedOutput, `${label} aggregatedOutput`);
      nullableProtocolNumber(item.exitCode, `${label} exitCode`);
      return;
    case 'fileChange':
      protocolArray(item.changes, `${label} changes`);
      protocolString(item.status, `${label} status`);
      return;
    case 'mcpToolCall':
      protocolString(item.server, `${label} server`);
      protocolString(item.tool, `${label} tool`);
      protocolString(item.status, `${label} status`);
      return;
    case 'dynamicToolCall':
      nullableProtocolString(item.namespace, `${label} namespace`);
      protocolString(item.tool, `${label} tool`);
      protocolString(item.status, `${label} status`);
      if (item.contentItems !== null) protocolArray(item.contentItems, `${label} contentItems`);
      if (item.success !== null && typeof item.success !== 'boolean') {
        throw new Error(`Invalid ${label} success`);
      }
      return;
    case 'functionCallOutput':
      protocolString(item.name, `${label} name`);
      nullableProtocolString(item.namespace, `${label} namespace`);
      validateFunctionCallOutput(item.output, `${label} output`);
      return;
    case 'collabAgentToolCall':
      if (![
        'spawnAgent',
        'sendInput',
        'resumeAgent',
        'wait',
        'closeAgent',
        'sendMessage',
        'followupTask',
        'interruptAgent',
        'listAgents',
      ].includes(String(item.tool))) {
        throw new Error(`Invalid ${label} tool`);
      }
      if (!['inProgress', 'completed', 'failed', 'interrupted'].includes(String(item.status))) {
        throw new Error(`Invalid ${label} status`);
      }
      protocolString(item.senderThreadId, `${label} senderThreadId`);
      protocolStringArray(item.receiverThreadIds, `${label} receiverThreadIds`);
      nullableProtocolString(item.prompt, `${label} prompt`);
      nullableProtocolString(item.model, `${label} model`);
      nullableProtocolString(item.reasoningEffort, `${label} reasoningEffort`);
      protocolRecord(item.agentsStates, `${label} agentsStates`);
      return;
    case 'subAgentActivity':
      if (!['started', 'interacted', 'interrupted', 'completed'].includes(String(item.kind))) {
        throw new Error(`Invalid ${label} kind`);
      }
      protocolString(item.agentThreadId, `${label} agentThreadId`);
      protocolString(item.agentPath, `${label} agentPath`);
      return;
    case 'webSearch':
      protocolString(item.query, `${label} query`);
      if (item.action !== null) protocolRecord(item.action, `${label} action`);
      return;
    case 'imageView':
      protocolString(item.path, `${label} path`);
      return;
    case 'sleep':
      if (
        typeof item.durationMs !== 'number'
        || !Number.isFinite(item.durationMs)
        || item.durationMs < 0
      ) throw new Error(`Invalid ${label} durationMs`);
      return;
    case 'imageGeneration':
      protocolString(item.status, `${label} status`);
      nullableProtocolString(item.revisedPrompt, `${label} revisedPrompt`);
      protocolString(item.result, `${label} result`);
      return;
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      protocolString(item.review, `${label} review`);
      return;
    case 'contextCompaction':
      return;
  }
}

function validateFunctionCallOutput(value: unknown, label: string): void {
  if (typeof value === 'string') return;
  const items = protocolArray(value, label);
  for (const [index, content] of items.entries()) {
    const item = protocolRecord(content, `${label} item ${index}`);
    switch (item.type) {
      case 'input_text':
        protocolString(item.text, `${label} item ${index} text`);
        break;
      case 'input_image':
        protocolString(item.image_url, `${label} item ${index} image_url`);
        if (
          item.detail !== undefined
          && item.detail !== null
          && !['auto', 'low', 'high', 'original'].includes(String(item.detail))
        ) throw new Error(`Invalid ${label} item ${index} detail`);
        break;
      case 'input_audio':
        protocolString(item.audio_url, `${label} item ${index} audio_url`);
        break;
      case 'encrypted_content':
        protocolString(item.encrypted_content, `${label} item ${index} encrypted_content`);
        break;
      default:
        throw new Error(`Invalid ${label} item ${index} type`);
    }
  }
}

function protocolString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}

function protocolArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function protocolStringArray(value: unknown, label: string): string[] {
  const items = protocolArray(value, label);
  if (!items.every((item) => typeof item === 'string')) throw new Error(`Invalid ${label}`);
  return items as string[];
}

function protocolRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function nullableProtocolString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}

function nullableProtocolNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export interface ThreadStartResponse {
  thread: CodexThread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
}

export interface ThreadResumeResponse extends ThreadStartResponse {}
export interface ThreadForkResponse extends ThreadStartResponse {}
export type CodexThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete';
export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
export interface ThreadGoalSetResponse {
  goal: CodexThreadGoal;
}
export interface ThreadGoalGetResponse {
  goal: CodexThreadGoal | null;
}
export interface ThreadGoalClearResponse {
  cleared: boolean;
}
export interface ThreadInjectItemsParams {
  threadId: string;
  items: Array<Record<string, unknown>>;
}
export type ThreadInjectItemsResponse = Record<string, never>;
export interface ThreadGoalUpdatedNotification {
  threadId: string;
  turnId: string | null;
  goal: CodexThreadGoal;
}
export interface ThreadGoalClearedNotification {
  threadId: string;
}
export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}
export interface ThreadLoadedListResponse {
  data: string[];
}
export type ThreadUnsubscribeStatus = 'notLoaded' | 'notSubscribed' | 'unsubscribed';
export interface ThreadUnsubscribeResponse {
  status: ThreadUnsubscribeStatus;
}
export interface TurnStartResponse { turn: CodexTurn }
export interface TurnSteerResponse { turnId: string }

export interface TurnStartedNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
}

export interface CodexRawResponseItem {
  type: string;
  id?: string;
  role?: string;
  author?: string;
  recipient?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
  output?: unknown;
}

export interface RawResponseItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: CodexRawResponseItem;
}

export interface ErrorNotification {
  threadId: string;
  turnId: string;
  willRetry: boolean;
  error: CodexTurnError;
}

export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  kind?: 'command' | 'writeStdin';
  startedAtMs?: number;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
}

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
}

export interface PermissionsRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: unknown;
}
