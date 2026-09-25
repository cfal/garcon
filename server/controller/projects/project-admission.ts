import type { IChatRegistry } from '../chats/store.js';
import type { ProjectAdmissionPort } from '../chat-execution/types.js';
import { DomainError, ProjectUnavailableError } from '../../common/domain-error.js';
import type { ProjectInspector } from '../../../common/project-resolution.js';
import { effectiveExecutorId } from '../../../common/executors.js';

export class ProjectAdmission implements ProjectAdmissionPort {
  constructor(
    private readonly registry: Pick<IChatRegistry, 'getChat'>,
    private readonly inspect: ProjectInspector,
  ) {}

  async assertAvailable(chatId: string): Promise<void> {
    const chat = this.registry.getChat(chatId);
    if (!chat) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
    const resolution = await this.inspect(chat.projectPath, chat.executorId);
    const current = this.registry.getChat(chatId);
    if (!current || effectiveExecutorId(current.executorId) !== effectiveExecutorId(chat.executorId)
      || current.projectPath !== chat.projectPath || current.agentOwnershipEpoch !== chat.agentOwnershipEpoch) {
      throw new DomainError('PROJECT_PATH_CHANGED', 'The chat project changed', 409);
    }
    if (resolution.kind === 'unavailable') {
      throw new ProjectUnavailableError(chat.projectPath, resolution.reason);
    }
  }
}
