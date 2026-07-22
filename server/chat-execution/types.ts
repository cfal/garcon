import crypto from 'crypto';
import type { QueueEntryPlacement } from '../../common/chat-command-contracts.ts';
import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import type {
  ChatImage,
  ChatMessage,
  ChatStopIntent,
  UserMessageDeliveryStatus,
} from '../../common/chat-types.ts';
import type { ChatViewMessage } from '../../common/chat-view.ts';
import type { AgentExecutionAdmission, RunAgentTurnOptions } from '../agents/session-types.ts';
import {
  cloneStoredChatExecutionControl,
  type StoredChatExecutionControlState,
} from './control-state.ts';
import { DomainError } from '../lib/domain-error.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import type { QueuedTurnFinalizationOutcome } from './turn-finalization-tracker.ts';
import type {
  QueueCommandIdentity,
  TransitionContext,
  TransitionRejection,
} from './chat-execution-control-transitions.ts';

export type PendingUserInputRegistrationOptions = Pick<
  RunAgentTurnOptions,
  'clientRequestId' | 'clientMessageId' | 'turnId' | 'images'
> & {
  deliveryStatus?: UserMessageDeliveryStatus;
};

export class QueueEntryMutationError extends DomainError {
  readonly control: StoredChatExecutionControlState;

  constructor(
    code:
      | 'QUEUE_ENTRY_NOT_FOUND'
      | 'QUEUE_ENTRY_ALREADY_SENT'
      | 'QUEUE_ENTRY_REVISION_CONFLICT'
      | 'QUEUE_ENTRY_REORDER_CONFLICT',
    message: string,
    control: StoredChatExecutionControlState,
  ) {
    super(code, message, code === 'QUEUE_ENTRY_NOT_FOUND' ? 404 : 409);
    this.name = 'QueueEntryMutationError';
    this.control = cloneStoredChatExecutionControl(control);
  }
}

export class QueuePauseChangedError extends DomainError {
  readonly control: StoredChatExecutionControlState;

  constructor(control: StoredChatExecutionControlState) {
    super('QUEUE_PAUSE_CHANGED', 'The queue pause changed before it could be resumed', 409);
    this.name = 'QueuePauseChangedError';
    this.control = cloneStoredChatExecutionControl(control);
  }
}

export interface QueueCommandMutationResult {
  entryId: string;
  control: StoredChatExecutionControlState;
  duplicate: boolean;
}

export interface StopActiveTurnResult {
  stopped: boolean;
  control: StoredChatExecutionControlState;
}

export interface AcceptedExecutionCommand {
  key: string;
  chatId: string;
  clientRequestId: string;
  turnId?: string;
  entryId?: string;
}

export interface PreScheduleFailure {
  error: unknown;
  retryable: boolean;
  preserveForkPreparation?: boolean;
}

export interface CommandSettlementPort {
  markScheduled(
    command: AcceptedExecutionCommand,
    turnId: string,
  ): Promise<void>;
  markPreScheduleFailure(
    command: AcceptedExecutionCommand,
    failure: PreScheduleFailure,
  ): Promise<void>;
  settleQueueMutation(command: AcceptedExecutionCommand, entryId: string): Promise<void>;
  settleQueueMutationFailure(command: AcceptedExecutionCommand, error: unknown): Promise<void>;
  settleActiveInput(command: AcceptedExecutionCommand): Promise<void>;
  settleActiveInputFailure(
    command: AcceptedExecutionCommand,
    error: unknown,
    deliveryAccepted: boolean,
  ): Promise<void>;
  settleOperationFailure(command: AcceptedExecutionCommand, error: unknown): Promise<void>;
}

export interface DirectInputPreparation {
  operation: 'chat-start' | 'fork-run';
  prepare(): Promise<void>;
  compensate(): Promise<void>;
}

export interface AcceptedDirectInput {
  command: AcceptedExecutionCommand;
  content: string;
  options: RunAgentTurnOptions;
  settlement: CommandSettlementPort;
  preparation?: DirectInputPreparation;
  dispatch?: (admission: AgentExecutionAdmission) => Promise<void>;
}

export interface AcceptedDirectOperation {
  command: AcceptedExecutionCommand;
  settlement: CommandSettlementPort;
  dispatch: (admission: AgentExecutionAdmission) => Promise<void>;
}

export interface AcceptedQueueCreate {
  command: AcceptedExecutionCommand & { entryId: string };
  content: string;
  settlement: CommandSettlementPort;
}

export interface AcceptedQueueReplace extends AcceptedQueueCreate {
  expectedRevision: number;
}

export interface AcceptedQueueDelete {
  command: AcceptedExecutionCommand & { entryId: string };
  settlement: CommandSettlementPort;
}

export interface AcceptedQueueMove {
  command: AcceptedExecutionCommand & { entryId: string };
  targetEntryId: string;
  placement: QueueEntryPlacement;
  expectedReorderRevision: number;
  expectedSourceRevision: number;
  expectedTargetRevision: number;
  settlement: CommandSettlementPort;
}

export interface AcceptedActiveInput {
  command: AcceptedExecutionCommand & { entryId: string };
  content: string;
  settlement: CommandSettlementPort;
}

export interface AcceptedActiveInputOutcome {
  delivery: 'active' | 'queued';
  entryId?: string;
  control: StoredChatExecutionControlState;
}

export interface DirectTurnReservation {
  readonly chatId: string;
  readonly reservationId: string;
  readonly executionAdmission: AgentExecutionAdmission;
}

export interface TranscriptSnapshotReservation {
  readonly chatId: string;
  readonly reservationId: string;
}

export interface AgentTurnRunnerPort {
  runAgentTurn(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  submitActiveInput?(
    chatId: string,
    command: string,
    options: RunAgentTurnOptions,
    beforeDelivery: () => Promise<void>,
  ): Promise<boolean>;
  abortSession(chatId: string): Promise<boolean>;
  isChatRunning(chatId: string): boolean;
  waitUntilTurnAbortable(
    chatId: string,
    turn: TurnIdentity,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface PendingInputsPort {
  register(
    chatId: string,
    content: string,
    options?: {
      clientRequestId?: string;
      clientMessageId?: string;
      turnId?: string;
      images?: ChatImage[];
      deliveryStatus?: UserMessageDeliveryStatus;
    },
  ): Promise<unknown>;
  discard(chatId: string, clientRequestId: string): boolean;
  markFailed(chatId: string, clientRequestId: string): boolean;
  markUnconfirmed(chatId: string, clientRequestId: string): boolean;
}

export interface ChatMessagesPort {
  appendMessages(
    chatId: string,
    messages: ChatMessage[],
  ): Promise<{ generationId: string; messages: ChatViewMessage[] }>;
}

export type ExecutionControlUpdatedCallback = (
  chatId: string,
  control: StoredChatExecutionControlState,
) => void;
export type DispatchingCallback = (chatId: string, entryId: string, content: string) => void;
export type SessionStopRequestedCallback = (
  chatId: string,
  stopId: string,
  turn: TurnIdentity | undefined,
) => void;
export type SessionStoppedCallback = (
  chatId: string,
  success: boolean,
  intent: ChatStopIntent,
  stopId: string,
) => void;
export type ChatIdleCallback = (chatId: string) => void;
export type TurnFailedCallback = (
  chatId: string,
  errorMessage: string,
  options: RunAgentTurnOptions,
) => void;
export type TurnSettledCallback = (chatId: string, turn: TurnIdentity | undefined) => void;
export type ChatMessagesCallback = (
  chatId: string,
  generationId: string,
  messages: ChatViewMessage[],
  metadata?: { clientRequestId?: string; turnId?: string },
) => void;
export type QueueDrainOptionsResolver = (chatId: string) => RunAgentTurnOptions;
export type ChatExistsResolver = (chatId: string) => boolean;

export interface SessionStopInFlight {
  intent: ChatStopIntent;
  stopId: string;
  promise: Promise<boolean>;
  resolve(success: boolean): void;
  reject(error: unknown): void;
  started: boolean;
}

export type DrainSuppressionReason = 'abort' | 'manual-stop' | 'deletion';

// Accepted-command surface consumed by the command service and route handlers.
export interface ChatExecutionCommands {
  deleteChatQueueFile(chatId: string): Promise<void>;
  scheduleDirectInput(input: AcceptedDirectInput): Promise<void>;
  runInitialInput(input: AcceptedDirectInput): Promise<void>;
  scheduleDirectOperation(input: AcceptedDirectOperation): Promise<void>;
  enqueueAccepted(input: AcceptedQueueCreate): Promise<QueueCommandMutationResult>;
  replaceAccepted(input: AcceptedQueueReplace): Promise<QueueCommandMutationResult>;
  deleteAccepted(input: AcceptedQueueDelete): Promise<QueueCommandMutationResult>;
  moveAccepted(input: AcceptedQueueMove): Promise<QueueCommandMutationResult>;
  deliverAcceptedActiveInput(input: AcceptedActiveInput): Promise<AcceptedActiveInputOutcome>;
  recoverAcceptedActiveInput(input: AcceptedActiveInput): Promise<AcceptedActiveInputOutcome>;
  stopActiveTurn(chatId: string): Promise<StopActiveTurnResult>;
  interruptActiveTurn(chatId: string): Promise<boolean>;
  abortForChatDeletion(chatId: string): Promise<boolean>;
  reserveTranscriptSnapshot(chatId: string): TranscriptSnapshotReservation;
  releaseTranscriptSnapshot(reservation: TranscriptSnapshotReservation): Promise<void>;
  waitForDispatches(): Promise<void>;
  isChatExecutionReserved(chatId: string): boolean;
  hasChatExecutionOwner(chatId: string): boolean;
  readChatExecutionControl(chatId: string): Promise<StoredChatExecutionControlState>;
  clearChatQueue(chatId: string): Promise<StoredChatExecutionControlState>;
  pauseChatQueue(chatId: string): Promise<StoredChatExecutionControlState>;
  resumeChatQueue(chatId: string, pauseId: string): Promise<StoredChatExecutionControlState>;
  resumeAndDrain(chatId: string, pauseId: string): Promise<StoredChatExecutionControlState>;
}

// Shutdown and recovery surface consumed by the server lifecycle.
export interface ChatExecutionLifecycle {
  beginShutdown(): string[];
  abortForShutdown(chatId: string): Promise<boolean>;
  waitForExecutionOwners(): Promise<void>;
  waitForDispatches(): Promise<void>;
  getQueuedTurnFinalization(
    chatId: string,
    turnId: string | undefined,
  ): Promise<QueuedTurnFinalizationOutcome> | null;
}

// Read-only surface consumed by WebSocket and route handlers.
export interface ChatExecutionQueries {
  readChatExecutionControl(chatId: string): Promise<StoredChatExecutionControlState>;
  isChatDraining(chatId: string): boolean;
}

// Full composition-root surface: the facets plus the direct-turn and low-level
// queue operations that no external consumer needs through a facet.
export interface ChatExecutionService
  extends ChatExecutionCommands, ChatExecutionLifecycle, ChatExecutionQueries {
  registerPendingUserInput(
    chatId: string,
    command: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void>;
  reserveDirectTurn(chatId: string, turn?: TurnIdentity): DirectTurnReservation;
  assertDirectTurnReservationActive(reservation: DirectTurnReservation): void;
  releaseDirectTurn(reservation: DirectTurnReservation): Promise<void>;
  completeDirectTurn(reservation: DirectTurnReservation): Promise<void>;
  failDirectTurn(reservation: DirectTurnReservation): Promise<void>;
  runReservedTurn(
    reservation: DirectTurnReservation,
    command: string,
    options: RunAgentTurnOptions,
  ): Promise<void>;
  triggerDrain(chatId: string): Promise<void>;
  hasAppliedQueueCreateCommand(chatId: string, commandKey: string, entryId: string): Promise<boolean>;
  createChatQueueEntry(
    chatId: string,
    content: string,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }>;
  replaceChatQueueEntry(
    chatId: string,
    entryId: string,
    content: string,
    expectedRevision: number,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }>;
  deleteChatQueueEntry(
    chatId: string,
    entryId: string,
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult>;
  moveChatQueueEntry(
    chatId: string,
    input: {
      entryId: string;
      targetEntryId: string;
      placement: QueueEntryPlacement;
      expectedReorderRevision: number;
      expectedSourceRevision: number;
      expectedTargetRevision: number;
    },
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { rebased: boolean | null }>;
  deliverActiveInput(
    chatId: string,
    content: string,
    options?: RunAgentTurnOptions,
    afterPendingRegistered?: () => Promise<void>,
  ): Promise<boolean>;
  requeueAndPauseChat(
    chatId: string,
    entryId: string,
    kind: AutomaticQueuePauseKind,
  ): Promise<StoredChatExecutionControlState>;
}

export function transitionContext(
  unsettledQueueReceiptKeys: () => ReadonlySet<string> = () => new Set(),
): TransitionContext {
  return {
    now: new Date().toISOString(),
    newId: () => crypto.randomUUID(),
    unsettledQueueReceiptKeys,
  };
}

export function executionTurnIdentity(turn: TurnIdentity): TurnIdentity | undefined {
  if (!turn.turnId && !turn.clientRequestId) return undefined;
  return {
    ...(turn.turnId ? { turnId: turn.turnId } : {}),
    ...(turn.clientRequestId ? { clientRequestId: turn.clientRequestId } : {}),
  };
}

export function transitionError(
  rejection: TransitionRejection,
  control: StoredChatExecutionControlState,
): DomainError {
  switch (rejection.code) {
    case 'QUEUE_ENTRY_NOT_FOUND':
      return new QueueEntryMutationError(
        rejection.code,
        'This queued message is no longer available',
        control,
      );
    case 'QUEUE_ENTRY_ALREADY_SENT':
      return new QueueEntryMutationError(
        rejection.code,
        'This queued message has already been sent',
        control,
      );
    case 'QUEUE_ENTRY_REVISION_CONFLICT':
      return new QueueEntryMutationError(
        rejection.code,
        'This queued message changed before it could be saved',
        control,
      );
    case 'QUEUE_ENTRY_REORDER_CONFLICT':
      return new QueueEntryMutationError(
        rejection.code,
        'The queue order changed before the item could be moved',
        control,
      );
    case 'QUEUE_PAUSE_CHANGED':
      return new QueuePauseChangedError(control);
  }
}
