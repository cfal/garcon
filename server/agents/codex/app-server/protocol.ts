export type JsonRpcId = number;

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
  preview: string;
  ephemeral: boolean;
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
  | 'serverOverloaded'
  | 'cyberPolicy'
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
  codexErrorInfo?: CodexErrorInfo | null;
  additionalDetails?: string | null;
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

export type CodexCollabAgentTool = 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent';
export type CodexCollabAgentToolCallStatus = 'inProgress' | 'completed' | 'failed';
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

export type CodexThreadItem =
  | { type: 'userMessage'; id: string; content: CodexUserInput[] }
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
      kind: 'started' | 'interacted' | 'interrupted';
      agentThreadId: string;
      agentPath: string;
    }
  | { type: 'webSearch'; id: string; query: string; action: CodexWebSearchAction | null }
  | { type: 'imageView'; id: string; path: string }
  | { type: 'imageGeneration'; id: string; status: string; revisedPrompt: string | null; result: string; savedPath?: string }
  | { type: 'enteredReviewMode'; id: string; review: string }
  | { type: 'exitedReviewMode'; id: string; review: string }
  | { type: 'contextCompaction'; id: string };

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
