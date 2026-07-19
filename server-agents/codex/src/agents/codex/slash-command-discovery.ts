import type { SlashCommand } from '@garcon/common/slash-commands';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { CodexAppServerClient } from './app-server/client.js';

const CACHE_TTL_MS = 5 * 60_000;
const EMPTY_CACHE_TTL_MS = 5_000;
const LIST_TIMEOUT_MS = 12_000;

export interface CodexSkillRef {
  readonly name: string;
  readonly path: string;
  readonly description?: string;
}

interface CacheEntry {
  readonly commands: SlashCommand[];
  readonly skills: CodexSkillRef[];
  readonly expiresAt: number;
}

export interface CodexSkillDiscoveryOptions {
  readonly createClient?: () => CodexAppServerClient;
  readonly logger: AgentLogger;
}

export class CodexSkillDiscovery {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<CacheEntry>>();
  readonly #activeClients = new Set<CodexAppServerClient>();
  readonly #createClient: () => CodexAppServerClient;
  #generation = 0;

  constructor(private readonly options: CodexSkillDiscoveryOptions) {
    this.#createClient = options.createClient ?? (() => new CodexAppServerClient());
  }

  async commands(projectPath: string): Promise<SlashCommand[]> {
    return (await this.#ensure(projectPath)).commands;
  }

  async skillRefs(projectPath: string): Promise<CodexSkillRef[]> {
    return (await this.#ensure(projectPath)).skills;
  }

  clear(): void {
    this.#cache.clear();
    this.#inFlight.clear();
    this.#generation += 1;
    for (const client of this.#activeClients) client.shutdown();
    this.#activeClients.clear();
  }

  #ensure(projectPath: string): Promise<CacheEntry> {
    const cached = this.#cache.get(projectPath);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);
    const existing = this.#inFlight.get(projectPath);
    if (existing) return existing;

    const generation = this.#generation;
    const task = this.#probe(projectPath)
      .then((skills) => {
        const commands: SlashCommand[] = skills.map((skill) => ({
          name: skill.name,
          source: 'skill',
          ...(skill.description ? { description: skill.description } : {}),
        }));
        const ttl = skills.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
        const entry = { commands, skills, expiresAt: Date.now() + ttl };
        if (this.#generation === generation) this.#cache.set(projectPath, entry);
        return entry;
      })
      .finally(() => {
        if (this.#inFlight.get(projectPath) === task) this.#inFlight.delete(projectPath);
      });
    this.#inFlight.set(projectPath, task);
    return task;
  }

  async #probe(projectPath: string): Promise<CodexSkillRef[]> {
    const client = this.#createClient();
    this.#activeClients.add(client);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        client.request('skills/list', { cwds: [projectPath] }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('skills/list timed out')),
            LIST_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
      return parseSkillsListResponse(response);
    } catch (error) {
      this.options.logger.warn('Codex skills discovery failed', {
        projectPath,
        error: errorMessage(error),
      });
      return [];
    } finally {
      if (timer) clearTimeout(timer);
      this.#activeClients.delete(client);
      client.shutdown();
    }
  }
}

export function parseSkillsListResponse(response: unknown): CodexSkillRef[] {
  const data = (response as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const refs: CodexSkillRef[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const skills = (entry as { skills?: unknown } | null)?.skills;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      const record = skill as {
        name?: unknown;
        path?: unknown;
        description?: unknown;
        enabled?: unknown;
      };
      if (record?.enabled === false) continue;
      const name = typeof record?.name === 'string' ? record.name : null;
      const path = typeof record?.path === 'string' ? record.path : null;
      const description = typeof record?.description === 'string'
        ? record.description
        : undefined;
      if (!name || !path || seen.has(name)) continue;
      seen.add(name);
      refs.push({ name, path, ...(description ? { description } : {}) });
    }
  }
  return refs.sort((left, right) => left.name.localeCompare(right.name));
}
