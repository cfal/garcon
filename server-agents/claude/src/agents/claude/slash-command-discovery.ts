import crypto from 'node:crypto';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { SlashCommand } from '@garcon/common/slash-commands';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { isRecord } from '@garcon/common/json';
import { ClaudeProcessTransport } from './cli-process-transport.js';

const PROBE_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 5 * 60_000;
const EMPTY_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  commands: SlashCommand[];
  expiresAt: number;
}

interface InitializeMessage {
  type?: string;
  response?: {
    subtype?: string;
    request_id?: string;
    error?: string;
    response?: unknown;
  };
}

export function parseInitSlashCommands(slashCommands: unknown, skills: unknown): SlashCommand[] {
  const skillNames = new Set(
    Array.isArray(skills) ? skills.filter((value): value is string => typeof value === 'string') : [],
  );
  if (!Array.isArray(slashCommands)) return [];

  return slashCommands
    .flatMap((value): SlashCommand[] => {
      if (typeof value === 'string') {
        return [{
          name: value,
          source: skillNames.has(value) ? 'skill' : 'command',
        }];
      }
      if (!isRecord(value) || typeof value.name !== 'string') return [];
      const description = typeof value.description === 'string'
        ? value.description
        : undefined;
      const source = value.type === 'skill' || skillNames.has(value.name)
        ? 'skill'
        : 'command';
      return [{
        name: value.name,
        source,
        ...(description ? { description } : {}),
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function probeClaudeSlashCommands(
  projectPath: string,
  claudeBinary: string,
  envOverrides: Record<string, string> | undefined,
  logger: AgentLogger,
): Promise<SlashCommand[]> {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
  ];

  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn([claudeBinary, ...args], {
      cwd: projectPath,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: (() => {
        const { CLAUDECODE, ...env } = globalThis.process.env;
        return { ...env, ...envOverrides };
      })(),
    });
  } catch (error: unknown) {
    logger.warn('Claude slash-command probe spawn failed', {
      projectPath,
      error: errorMessage(error),
    });
    return Promise.resolve([]);
  }

  return new Promise<SlashCommand[]>((resolve) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    let transport: ClaudeProcessTransport<InitializeMessage>;
    const finish = (commands: SlashCommand[], failure?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) {
        logger.warn('Claude slash-command probe failed', {
          projectPath,
          error: failure,
        });
      }
      void transport.retire().catch((error: unknown) => {
        logger.warn('Claude slash-command probe teardown failed', {
          projectPath,
          error: errorMessage(error),
        });
      }).finally(() => resolve(commands));
    };
    const timer = setTimeout(() => {
      finish([], 'initialize request timed out');
    }, PROBE_TIMEOUT_MS);

    transport = new ClaudeProcessTransport({
      process,
      logger,
      sessionId: 'command-probe',
      onMessage: (message) => {
        const response = message.response;
        if (message.type !== 'control_response' || response?.request_id !== requestId) return;
        if (response.subtype === 'error') {
          finish([], response.error || 'initialize request failed');
          return;
        }
        const info = isRecord(response.response) ? response.response : {};
        finish(parseInitSlashCommands(info.commands, info.skills));
      },
      onFailure: (failure) => finish([], `${failure.kind}: ${failure.message}`),
      onEof: () => finish([], 'stdout ended before initialize completed'),
      onExit: (exit) => {
        if (settled) return;
        finish([], `process exited with code ${exit.exitCode}`);
      },
    });

    void transport.writeLine(JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'initialize' },
    })).catch((error: unknown) => finish([], errorMessage(error)));
  });
}

export class ClaudeSlashCommandDiscovery {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<SlashCommand[]>>();

  constructor(
    private readonly binary: () => string,
    private readonly environment: () => Record<string, string> | undefined,
    private readonly logger: AgentLogger,
  ) {}

  async discover(projectPath: string): Promise<SlashCommand[]> {
    const cached = this.#cache.get(projectPath);
    if (cached && cached.expiresAt > Date.now()) return cached.commands;
    const existing = this.#inFlight.get(projectPath);
    if (existing) return existing;

    const probe = probeClaudeSlashCommands(
      projectPath,
      this.binary(),
      this.environment(),
      this.logger,
    )
      .catch((error: unknown) => {
        this.logger.warn('Claude slash-command probe rejected', {
          projectPath,
          error: errorMessage(error),
        });
        return [] as SlashCommand[];
      })
      .then((commands) => {
        const ttl = commands.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
        this.#cache.set(projectPath, { commands, expiresAt: Date.now() + ttl });
        return commands;
      })
      .finally(() => {
        this.#inFlight.delete(projectPath);
      });
    this.#inFlight.set(projectPath, probe);
    return probe;
  }

  clear(): void {
    this.#cache.clear();
    this.#inFlight.clear();
  }
}
