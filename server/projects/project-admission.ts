import type { IChatRegistry } from '../chats/store.js';
import type { ProjectAdmissionPort } from '../chat-execution/types.js';
import { DomainError, ProjectUnavailableError } from '../lib/domain-error.js';
import { inspectProjectDirectory } from './project-directory-service.js';

export class ProjectAdmission implements ProjectAdmissionPort {
  constructor(
    private readonly registry: Pick<IChatRegistry, 'getChat'>,
    private readonly inspect = inspectProjectDirectory,
  ) {}

  async assertAvailable(chatId: string): Promise<void> {
    const chat = this.registry.getChat(chatId);
    if (!chat) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
    const resolution = await this.inspect(chat.projectPath);
    if (resolution.kind === 'unavailable') {
      throw new ProjectUnavailableError(chat.projectPath, resolution.reason);
    }
  }
}
