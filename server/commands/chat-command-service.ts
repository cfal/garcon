import type {
  ActiveInputCommandRequest,
  QueueEntryCreateCommandRequest,
  QueueEntryDeleteCommandRequest,
  QueueEntryReplaceCommandRequest,
  RecoveredInputContinueRequest,
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
import { ForkCommands, type ForkChatInput } from './fork-commands.js';
import { QueueCommands } from './queue-commands.js';
import { SessionCommands } from './session-commands.js';
import { StartCommands } from './start-commands.js';

export {
  CommandExecutionControlError,
  CommandValidationError,
  commandResultFromRecord,
  runOptionsFromCommandRequest,
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
  readonly #queue: QueueCommands;
  readonly #session: SessionCommands;

  constructor(private readonly deps: ChatCommandServiceDeps) {
    const support = new CommandSupport(deps);
    this.#start = new StartCommands(support);
    this.#fork = new ForkCommands(support);
    this.#queue = new QueueCommands(support);
    this.#session = new SessionCommands(support);
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

  forkChat(input: ForkChatInput) {
    return this.#fork.forkChat(input);
  }

  deleteChat(input: DeleteChatInput) {
    return this.#session.deleteChat(input);
  }

  submitForkRun(input: SubmitForkRunInput) {
    return this.#fork.submitForkRun(input);
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

  submitActiveInput(input: ActiveInputCommandRequest) {
    return this.#queue.submitActiveInput(input);
  }

  submitScheduledExistingChat(input: ScheduledExistingChatInput) {
    return this.#queue.submitScheduledExistingChat(input);
  }

  mutateQueue(input: QueueMutationInput) {
    return this.#queue.mutateQueue(input);
  }

  continueRecoveredInput(input: RecoveredInputContinueRequest) {
    return this.#queue.continueRecoveredInput(input);
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
