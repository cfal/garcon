import path from 'node:path';
import { AgentCallError, type ExecutionProjectService, type NodeCallOptions } from '@garcon/server-agent-interface';
import { resolveFileMentionsInCommand } from '../chats/file-mentions.js';
import { inspectProjectDirectory } from '../projects/project-directory-service.js';
import { assertRealWithinBase } from '../lib/path-boundary.js';
import { readOnlyGitOptions, runGit } from '../git/run.js';
import { toNativePath, toNodePath } from './node-path.js';
import { resolveTicketProjectDefault } from '../projects/ticket-project-default.js';
import { ticketRecord, ticketString } from '../../common/ticket-validation.js';

export class LocalExecutionProjectService implements ExecutionProjectService {
  readonly projectBasePath: string;

  constructor(projectBasePath: string, private readonly assertAvailable: (options?: NodeCallOptions) => void) {
    this.projectBasePath = toNodePath(path.resolve(projectBasePath));
  }

  async ticketProjectDefault(request: Parameters<ExecutionProjectService['ticketProjectDefault']>[0], options?: NodeCallOptions) {
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

  async inspect(request: Parameters<ExecutionProjectService['inspect']>[0], options?: NodeCallOptions) {
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
      resolution: { ...resolution, effectiveProjectKey: toNodePath(resolution.effectiveProjectKey) },
      ...(isGitRepository === undefined ? {} : { isGitRepository }),
    };
  }

  async resolveFileMentions(request: Parameters<ExecutionProjectService['resolveFileMentions']>[0], options?: NodeCallOptions) {
    const { resolution } = await this.inspect({ projectPath: request.projectPath }, options);
    if (resolution.kind === 'unavailable') {
      throw new AgentCallError('not-dispatched', `Project folder is unavailable: ${resolution.reason}`);
    }
    const command = await resolveFileMentionsInCommand(request.command, toNativePath(resolution.effectiveProjectKey));
    this.assertAvailable(options);
    return command;
  }

  async #isGitRepository(projectPath: string, options?: NodeCallOptions): Promise<boolean> {
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
