import type { WorkspaceFileMentionService } from '../execution-nodes/workspace-file-mentions.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger, type Logger } from '../lib/log.js';
import { parseFileMentionTokens, type FileMentionResolver, type FileMentionTarget } from './file-mentions.js';

const logger = createLogger('chats:file-mentions');

export class WorkspaceFileMentionResolver implements FileMentionResolver {
  constructor(private readonly serviceFor: (target: FileMentionTarget) => WorkspaceFileMentionService,
    private readonly diagnostics: Pick<Logger, 'warn'> = logger) {}

  async resolve(command: string, target: FileMentionTarget, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (parseFileMentionTokens(command).length === 0) return command;
    try {
      const resolved = await this.serviceFor(target).resolve({ command, projectPath: target.projectPath }, signal);
      signal.throwIfAborted();
      return resolved;
    } catch (error) {
      signal.throwIfAborted();
      // Mention lookup enriches accepted input; an unavailable workspace does not discard it.
      this.diagnostics.warn('File mention resolution unavailable', {
        agentId: target.agentId, ...target.executionLocation, code: error instanceof DomainError ? error.code : null,
      });
      return command;
    }
  }
}
