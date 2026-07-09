// Discovers the skills available to the Codex agent for a project. Unlike
// Codex's built-in TUI slash commands (which are client-only and not reachable
// through the app-server), skills are first-class in the protocol: they are
// listed via the `skills/list` RPC and invoked by emitting a `skill` turn-input
// item. Results are cached per project and reused by both the composer's "/"
// autocomplete and the turn builder that resolves a selected skill to its path.

import { CodexAppServerClient } from './app-server/client.js';
import { createLogger } from '../../lib/log.js';
import { errorMessage } from '../../lib/errors.js';
import type { SlashCommand } from '../../../common/slash-commands.js';

const logger = createLogger('agents:codex:slash-command-discovery');

const CACHE_TTL_MS = 5 * 60_000;
// Empty results are cached briefly so rapid menu reopens do not re-spawn the
// app-server, while still recovering quickly once it starts returning skills.
const EMPTY_CACHE_TTL_MS = 5_000;
const LIST_TIMEOUT_MS = 12_000;

// A Codex skill resolved to the fields needed to invoke it as a turn input.
export interface CodexSkillRef {
  name: string;
  path: string;
  description?: string;
}

interface CacheEntry {
  commands: SlashCommand[];
  skills: CodexSkillRef[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

// Flattens a `skills/list` response into enabled, de-duplicated skill refs.
export function parseSkillsListResponse(response: unknown): CodexSkillRef[] {
  const data = (response as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const refs: CodexSkillRef[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const skills = (entry as { skills?: unknown } | null)?.skills;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      const record = skill as { name?: unknown; path?: unknown; description?: unknown; enabled?: unknown };
      if (record?.enabled === false) continue;
      const name = typeof record?.name === 'string' ? record.name : null;
      const path = typeof record?.path === 'string' ? record.path : null;
      const description = typeof record?.description === 'string' ? record.description : undefined;
      if (!name || !path || seen.has(name)) continue;
      seen.add(name);
      refs.push({ name, path, ...(description ? { description } : {}) });
    }
  }
  return refs.sort((a, b) => a.name.localeCompare(b.name));
}

async function probeCodexSkills(projectPath: string): Promise<CodexSkillRef[]> {
  const client = new CodexAppServerClient();
  try {
    const response = await Promise.race([
      client.request('skills/list', { cwds: [projectPath] }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('skills/list timed out')), LIST_TIMEOUT_MS),
      ),
    ]);
    return parseSkillsListResponse(response);
  } catch (err: unknown) {
    // Degrade to an empty list rather than surfacing a failure: a missing/old
    // binary, a malformed ~/.codex/config.toml, or resource pressure should
    // show "no matching commands", not a hard error.
    logger.warn(`codex skills/list failed for ${projectPath}: ${errorMessage(err)}`);
    return [];
  } finally {
    client.shutdown();
  }
}

function ensureCodexSkills(projectPath: string): Promise<CacheEntry> {
  const cached = cache.get(projectPath);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached);
  }

  const existing = inFlight.get(projectPath);
  if (existing) return existing;

  const task = probeCodexSkills(projectPath)
    .then((skills) => {
      const commands: SlashCommand[] = skills.map((skill) => ({
        name: skill.name,
        source: 'skill',
        ...(skill.description ? { description: skill.description } : {}),
      }));
      const ttl = skills.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
      const entry: CacheEntry = { commands, skills, expiresAt: Date.now() + ttl };
      cache.set(projectPath, entry);
      return entry;
    })
    .finally(() => {
      inFlight.delete(projectPath);
    });

  inFlight.set(projectPath, task);
  return task;
}

// Returns the Codex skills as slash commands for the composer autocomplete.
export async function getCodexSlashCommands(projectPath: string): Promise<SlashCommand[]> {
  return (await ensureCodexSkills(projectPath)).commands;
}

// Returns the skill refs (name + path) for resolving a selected skill to its
// `skill` turn-input item. Shares the cache with the autocomplete path.
export async function getCodexSkillRefs(projectPath: string): Promise<CodexSkillRef[]> {
  return (await ensureCodexSkills(projectPath)).skills;
}
