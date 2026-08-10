import type {
  ForkChatCommandRequest,
  GoalControlCommandRequest,
  QueueEntryCreateCommandRequest,
  QueueEntryDeleteCommandRequest,
  QueueEntryMoveCommandRequest,
  QueueEntryReplaceCommandRequest,
  QueueEntrySteerCommandRequest,
  SteerCommandRequest,
} from '../../common/chat-command-contracts.js';
import {
  CommandSupport,
  type ChatCommandServiceDeps,
  type ChatStartInput,
  type CompactInput,
  type DeleteChatInput,
  type PermissionDecisionInput,
  type QueueMutationInput,
  type ScheduledChatStartInput,
  type ScheduledExistingChatInput,
  type StopInput,
  type SubmitForkRunInput,
  type SubmitRunInput,
  type UpdateProjectPathInput,
} from './command-support.js';
import type { SelfHandoffRunCommandRequest } from '../../common/self-handoff-contracts.js';
import { ForkCommands } from './fork-commands.js';
import { SelfHandoffCommands } from './self-handoff-commands.js';
import { QueueCommands } from './queue-commands.js';
import { SessionCommands } from './session-commands.js';
import { StartCommands } from './start-commands.js';
import { SteerCommands } from './steer-commands.js';

export {
  CommandExecutionControlError,
  CommandValidationError,
  commandResultFromRecord,
} from './command-support.js';
export type {
  ChatStartInput,
  ScheduledChatStartInput,
  ScheduledExistingChatInput,
  ScheduledExistingChatOutcome,
} from './command-support.js';

export class ChatCommandService {
  readonly #start: StartCommands;
  readonly #fork: ForkCommands;
  readonly #selfHandoff: SelfHandoffCommands;
  readonly #queue: QueueCommands;
  readonly #session: SessionCommands;
  readonly #steer: SteerCommands;

  constructor(private readonly deps: ChatCommandServiceDeps) {
    const support = new CommandSupport(deps);
    this.#start = new StartCommands(support);
    this.#fork = new ForkCommands(support);
    this.#selfHandoff = new SelfHandoffCommands(support);
    this.#queue = new QueueCommands(support);
    this.#session = new SessionCommands(support);
    this.#steer = new SteerCommands(support);
  }

  async waitForBackgroundTasks(): Promise<void> {
    await this.deps.queue.waitForDispatches();
  }

  submitStart(input: ChatStartInput) {
    return this.#start.submitStart(input);
  }

  submitScheduledStart(input: ScheduledChatStartInput) {
    return this.#start.submitScheduledStart(input);
  }

  submitRun(input: SubmitRunInput) {
    return this.#session.submitRun(input);
  }

  forkChat(input: ForkChatCommandRequest) {
    return this.#fork.forkChat(input);
  }

  deleteChat(input: DeleteChatInput) {
    return this.#session.deleteChat(input);
  }

  retryRetainedTransferCleanups() {
    return this.deps.ownership.retryRetainedTransferCleanups();
  }

  submitForkRun(input: SubmitForkRunInput) {
    return this.#fork.submitForkRun(input);
  }

  submitSelfHandoffRun(input: SelfHandoffRunCommandRequest) {
    return this.#selfHandoff.submitSelfHandoffRun(input);
  }

  submitQueueEntryCreate(input: QueueEntryCreateCommandRequest) {
    return this.#queue.submitQueueEntryCreate(input);
  }

  submitQueueEntryReplace(input: QueueEntryReplaceCommandRequest) {
    return this.#queue.submitQueueEntryReplace(input);
  }

  submitQueueEntryDelete(input: QueueEntryDeleteCommandRequest) {
    return this.#queue.submitQueueEntryDelete(input);
  }

  submitQueueEntryMove(input: QueueEntryMoveCommandRequest) {
    return this.#queue.submitQueueEntryMove(input);
  }

  submitGoalControl(input: GoalControlCommandRequest) {
    return this.#queue.submitGoalControl(input);
  }

  submitSteer(input: SteerCommandRequest) {
    return this.#steer.submit(input);
  }

  submitQueueEntrySteer(input: QueueEntrySteerCommandRequest) {
    return this.#steer.submitQueueEntry(input);
  }

  submitScheduledExistingChat(input: ScheduledExistingChatInput) {
    return this.#queue.submitScheduledExistingChat(input);
  }

  mutateQueue(input: QueueMutationInput) {
    return this.#queue.mutateQueue(input);
  }

  submitPermissionDecision(input: PermissionDecisionInput) {
    return this.#session.submitPermissionDecision(input);
  }

  submitStop(input: StopInput) {
    return this.#session.submitStop(input);
  }

  submitInterruptAndSend(input: StopInput) {
    return this.#session.submitInterruptAndSend(input);
  }

  submitCompact(input: CompactInput) {
    return this.#session.submitCompact(input);
  }

  updateProjectPath(input: UpdateProjectPathInput) {
    return this.#session.updateProjectPath(input);
  }
}
