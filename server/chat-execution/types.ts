import crypto from 'crypto';
import type {
  QueueEntryPlacement,
  SteerDeliveryOutcome,
} from '../../common/chat-command-contracts.ts';
import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import type {
  ChatStopIntent,
  ChatStopOutcome,
} from '../../common/chat-types.ts';
import type {
  AgentGoalControlHandoff,
  AgentSteerResult,
  AgentSteerTarget,
} from '@garcon/server-agent-interface';
import type {
  AgentExecutionCommandType,
  AgentExecutionAdmission,
  AgentSteerOptions,
  RunAgentTurnOptions,
} from '../agents/session-types.ts';
import {
  cloneStoredChatExecutionControl,
  type StoredChatExecutionControlState,
} from './control-state.ts';
import { DomainError } from '../lib/domain-error.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import type { QueuedTurnFinalizationOutcome } from './turn-finalization-tracker.ts';
import type { QueueExecutionAttempt } from './execution-attempt.ts';
import type {
  QueueCommandIdentity,
  TransitionContext,
  TransitionRejection,
} from './chat-execution-control-transitions.ts';

export type UserInputAdmissionOptions = Pick<
  RunAgentTurnOptions,
  | 'clientRequestId'
  | 'clientMessageId'
  | 'transcriptViewId'
  | 'turnId'
  | 'images'
  | 'excludedResendOrdinals'
> & {
  commandType?: AgentExecutionCommandType | 'steer';
  createdAt?: string;
};

export class QueueEntryMutationError extends DomainError {
  readonly control: StoredChatExecutionControlState;

  constructor(
    code:
      | 'QUEUE_ENTRY_NOT_FOUND'
      | 'QUEUE_ENTRY_ALREADY_SENT'
      | 'QUEUE_ENTRY_IN_FLIGHT'
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
  outcome: ChatStopOutcome;
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
  settleGoalControl(command: AcceptedExecutionCommand): Promise<void>;
  settleGoalControlFailure(
    command: AcceptedExecutionCommand,
    error: unknown,
    deliveryAccepted: boolean,
  ): Promise<void>;
  settleSteerSuccess(command: AcceptedExecutionCommand, turnId: string): Promise<void>;
  settleSteerFailure(
    command: AcceptedExecutionCommand,
    error: unknown,
    deliveryOutcome?: SteerDeliveryOutcome,
  ): Promise<void>;
  settleOperationFailure(command: AcceptedExecutionCommand, error: unknown): Promise<void>;
  settleDuplicateInput(command: AcceptedExecutionCommand): Promise<void>;
}

export interface DirectInputPreparation {
  operation: 'chat-start' | 'fork-run' | 'agent-handoff';
  prepare(context: DirectInputPreparationContext): Promise<void>;
  compensate(): Promise<void>;
}

export interface DirectInputPreparationContext {
  readonly signal: AbortSignal;
  assertAdmissionActive(): void;
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
  clientMessageId: string;
  transcriptViewId: string;
  excludedResendOrdinals?: readonly number[];
  settlement: CommandSettlementPort;
}

export interface AcceptedQueueReplace {
  command: AcceptedExecutionCommand & { entryId: string };
  content: string;
  expectedRevision: number;
  settlement: CommandSettlementPort;
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

export interface AcceptedGoalControl {
  command: AcceptedExecutionCommand & { entryId: string };
  content: string;
  clientMessageId: string;
  transcriptViewId: string;
  settlement: CommandSettlementPort;
}

export interface AcceptedGoalControlOutcome {
  delivery: 'active' | 'queued';
  entryId?: string;
  control: StoredChatExecutionControlState;
}

export interface CapturedSteerTarget {
  readonly attempt: QueueExecutionAttempt;
  readonly identity: Readonly<TurnIdentity> & { readonly turnId: string };
  readonly providerTarget: AgentSteerTarget | null;
}

export interface AcceptedSteerInput {
  command: AcceptedExecutionCommand;
  content: string;
  providerContent: string;
  clientMessageId: string;
  transcriptViewId: string;
  target: CapturedSteerTarget;
  settlement: CommandSettlementPort;
}

export interface AcceptedQueueEntrySteer extends AcceptedSteerInput {
  command: AcceptedExecutionCommand & { entryId: string };
  expectedRevision: number;
  expectedReorderRevision: number;
}

export interface AcceptedQueueEntrySteerOutcome extends AcceptedSteerOutcome {
  control: StoredChatExecutionControlState;
}

export interface AcceptedSteerOutcome {
  turnId: string;
  duplicate: boolean;
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
  captureSteerTarget(chatId: string): AgentSteerTarget | null;
  steerInput(
    chatId: string,
    input: string,
    options: AgentSteerOptions,
    target: AgentSteerTarget | null,
    prepareDelivery: () => Promise<void>,
  ): Promise<AgentSteerResult>;
  submitGoalControl(
    chatId: string,
    command: string,
    options: RunAgentTurnOptions,
    beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void>,
  ): Promise<boolean>;
  abortSession(chatId: string): Promise<boolean>;
  isChatRunning(chatId: string): boolean;
}

export type ExecutionControlUpdatedCallback = (
  chatId: string,
  control: StoredChatExecutionControlState,
) => void;
export type SessionStoppedCallback = (
  chatId: string,
  outcome: ChatStopOutcome,
  intent: ChatStopIntent,
) => void;
export type ChatIdleCallback = (chatId: string) => void;
export type ProcessingInvalidatedCallback = (chatId: string) => void;
export type TurnFailedCallback = (
  chatId: string,
  errorMessage: string,
  options: RunAgentTurnOptions,
) => void;
export type TurnSettledCallback = (chatId: string, turn: TurnIdentity | undefined) => void;
export type QueueDrainOptionsResolver = (chatId: string) => RunAgentTurnOptions;
export type ChatExistsResolver = (chatId: string) => boolean;

export interface ChatExecutionCoordinatorEvents {
  'execution-control-updated': Parameters<ExecutionControlUpdatedCallback>;
  'session-stopped': Parameters<SessionStoppedCallback>;
  'chat-idle': Parameters<ChatIdleCallback>;
  'turn-failed': Parameters<TurnFailedCallback>;
  'turn-settled': Parameters<TurnSettledCallback>;
  'processing-invalidated': Parameters<ProcessingInvalidatedCallback>;
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
  captureSteerTarget(chatId: string): CapturedSteerTarget | null;
  deliverAcceptedSteer(input: AcceptedSteerInput): Promise<AcceptedSteerOutcome>;
  deliverAcceptedQueueEntrySteer(
    input: AcceptedQueueEntrySteer,
  ): Promise<AcceptedQueueEntrySteerOutcome>;
  recoverQueueEntrySteer(chatId: string, entryId: string): Promise<StoredChatExecutionControlState>;
  deliverAcceptedGoalControl(input: AcceptedGoalControl): Promise<AcceptedGoalControlOutcome>;
  stopActiveTurn(chatId: string): Promise<StopActiveTurnResult>;
  interruptActiveTurn(chatId: string): Promise<ChatStopOutcome>;
  abortForChatDeletion(chatId: string): Promise<boolean>;
  rollbackChatDeletion(chatId: string): void;
  reserveTranscriptSnapshot(chatId: string): TranscriptSnapshotReservation;
  replaceTurnWithTranscriptSnapshotReservation(
    chatId: string,
    turn: TurnIdentity,
  ): TranscriptSnapshotReservation | null;
  releaseTranscriptSnapshot(reservation: TranscriptSnapshotReservation): Promise<void>;
  waitForDispatches(): Promise<void>;
  ownsExecution(chatId: string): boolean;
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
  ownsExecution(chatId: string): boolean;
  isChatTurnReserved(chatId: string): boolean;
  getTurnReservedChatIds(): string[];
  isChatStopInFlight(chatId: string): boolean;
}

// Full composition-root surface: the facets plus the direct-turn and low-level
// queue operations that no external consumer needs through a facet.
export interface ChatExecutionService
  extends ChatExecutionCommands, ChatExecutionLifecycle, ChatExecutionQueries {
  admitUserInput(
    chatId: string,
    command: string,
    options: UserInputAdmissionOptions,
  ): Promise<boolean>;
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
  deliverGoalControlInput(
    chatId: string,
    content: string,
    options?: RunAgentTurnOptions,
    afterPendingRegistered?: () => Promise<void>,
  ): Promise<boolean>;
  steerInput(
    chatId: string,
    content: string,
    providerContent: string,
    options: AgentSteerOptions,
    target: CapturedSteerTarget,
    afterPendingRegistered: (turnId: string) => Promise<void>,
  ): Promise<AcceptedSteerOutcome>;
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
    case 'IDEMPOTENCY_CONFLICT':
      return new DomainError(
        'IDEMPOTENCY_CONFLICT',
        `Client message ${rejection.clientMessageId} was already queued with different content`,
        409,
      );
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
    case 'QUEUE_ENTRY_IN_FLIGHT':
      return new QueueEntryMutationError(
        rejection.code,
        'This queued message is already being steered',
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
