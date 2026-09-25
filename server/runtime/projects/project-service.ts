import path from 'node:path';
import { AgentCallError, type ExecutionProjectService, type ExecutorCallOptions } from '@garcon/server-agent-interface';
import { resolveFileMentionsInCommand } from './file-mentions.js';
import { inspectProjectDirectory } from './project-directory-service.js';
import { assertRealWithinBase } from '../../common/path-boundary.js';
import { readOnlyGitOptions, runGit } from '../git/run.js';
import { toNativePath, toExecutorPath } from '../../common/executor-path.js';
import { resolveTicketProjectDefault } from './ticket-project-default.js';
import { ticketRecord, ticketString } from '../../../common/ticket-validation.js';

export class ProjectService implements ExecutionProjectService {
  readonly projectBasePath: string;

  constructor(projectBasePath: string, private readonly assertAvailable: (options?: ExecutorCallOptions) => void) {
    this.projectBasePath = toExecutorPath(path.resolve(projectBasePath));
  }

  async ticketProjectDefault(request: Parameters<ExecutionProjectService['ticketProjectDefault']>[0], options?: ExecutorCallOptions) {
    this.assertAvailable(options);
    const input = ticketRecord(request, ['projectPath']);
    const directory = ticketString(input.projectPath, 'projectPath');
    const result = await resolveTicketProjectDefault(toNativePath(directory), options?.signal, {
      inspect: (input) => inspectProjectDirectory(input, {
        resolvePath: (path) => assertRealWithinBase(toNativePath(this.projectBasePath), path),
      }),
    });
    this.assertAvailable(options);
    return result;
  }

  async inspect(request: Parameters<ExecutionProjectService['inspect']>[0], options?: ExecutorCallOptions) {
    this.assertAvailable(options);
    const resolution = await inspectProjectDirectory(toNativePath(request.projectPath), {
      resolvePath: (input) => assertRealWithinBase(toNativePath(this.projectBasePath), input),
    });
    this.assertAvailable(options);
    if (resolution.kind === 'unavailable') return { resolution };
    const isGitRepository = request.includeGitRepository
      ? await this.#isGitRepository(resolution.effectiveProjectKey, options)
      : undefined;
    this.assertAvailable(options);
    return {
      resolution: { ...resolution, effectiveProjectKey: toExecutorPath(resolution.effectiveProjectKey) },
      ...(isGitRepository === undefined ? {} : { isGitRepository }),
    };
  }

  async resolveFileMentions(request: Parameters<ExecutionProjectService['resolveFileMentions']>[0], options?: ExecutorCallOptions) {
    const { resolution } = await this.inspect({ projectPath: request.projectPath }, options);
    if (resolution.kind === 'unavailable') {
      throw new AgentCallError('not-dispatched', `Project folder is unavailable: ${resolution.reason}`);
    }
    const command = await resolveFileMentionsInCommand(request.command, toNativePath(resolution.effectiveProjectKey));
    this.assertAvailable(options);
    return command;
  }

  async #isGitRepository(projectPath: string, options?: ExecutorCallOptions): Promise<boolean> {
    try {
      const { stdout } = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], readOnlyGitOptions({
        timeoutMs: Math.min(options?.timeoutMs ?? 5_000, 5_000), signal: options?.signal,
        maxStdoutBytes: 1024, maxStderrBytes: 4096,
      }));
      return stdout.trim() === 'true';
    } catch {
      options?.signal?.throwIfAborted();
      return false;
    }
  }
}
