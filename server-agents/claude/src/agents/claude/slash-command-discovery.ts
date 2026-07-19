// Discovers the slash commands available to the Claude CLI for a project.
// The CLI emits the available command names in its stream-json `system/init`
// message. A short-lived probe spawns the binary, sends a trivial message to
// trigger init, reads the command list, then kills the process before the
// model turn does meaningful work. Results are cached per project.

import { getClaudeBinary } from '../../config.js';
import { createLogger } from '@garcon/server-agent-common/lib/log';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { SlashCommand } from '@garcon/common/slash-commands';

const logger = createLogger('agents:claude:slash-command-discovery');

const PROBE_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 5 * 60_000;
// Empty results are cached briefly so rapid menu reopens do not re-spawn the
// probe on every keystroke, while still recovering quickly once the probe
// starts succeeding.
const EMPTY_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  commands: SlashCommand[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SlashCommand[]>>();

// Maps the init message's `slash_commands`/`skills` arrays to typed commands.
// Names present in `skills` are tagged as skills; everything else (built-ins
// and project prompt commands) is tagged as a generic command.
export function parseInitSlashCommands(slashCommands: unknown, skills: unknown): SlashCommand[] {
  const names = Array.isArray(slashCommands)
    ? slashCommands.filter((value): value is string => typeof value === 'string')
    : [];
  const skillNames = new Set(
    Array.isArray(skills) ? skills.filter((value): value is string => typeof value === 'string') : [],
  );
  return names
    .map((name) => ({ name, source: skillNames.has(name) ? 'skill' : 'command' }) as SlashCommand)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function probeClaudeSlashCommands(projectPath: string): Promise<SlashCommand[]> {
  const claudeBinary = getClaudeBinary();
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
  ];

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([claudeBinary, ...args], {
      cwd: projectPath,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env: (() => { const { CLAUDECODE, ...env } = process.env; return env; })(),
    });
  } catch (err: unknown) {
    // Spawn can fail under transient resource pressure (e.g. process/fd limits)
    // or a missing binary. Degrade to an empty list rather than a 500 so the
    // composer shows "no matching commands" instead of a hard error.
    logger.warn(`probe spawn failed for ${projectPath}: ${errorMessage(err)}`);
    return Promise.resolve([]);
  }

  return new Promise<SlashCommand[]>((resolve) => {
    let settled = false;
    const finish = (commands: SlashCommand[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!proc.killed) proc.kill();
      resolve(commands);
    };

    const timer = setTimeout(() => {
      logger.warn(`probe timed out for ${projectPath}`);
      finish([]);
    }, PROBE_TIMEOUT_MS);

    // A user message is required to trigger the init message; the process is
    // killed as soon as init arrives, before the turn meaningfully runs.
    const stdin = proc.stdin as import('bun').FileSink;
    try {
      stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '.' },
          parent_tool_use_id: null,
          session_id: '',
        }) + '\n',
      );
      stdin.flush();
    } catch (err: unknown) {
      logger.warn(`probe stdin write failed for ${projectPath}: ${errorMessage(err)}`);
      finish([]);
      return;
    }

    void (async () => {
      try {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!settled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            let msg: { type?: string; subtype?: string; slash_commands?: unknown; skills?: unknown };
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.type === 'system' && msg.subtype === 'init') {
              finish(parseInitSlashCommands(msg.slash_commands, msg.skills));
              return;
            }
          }
        }
        finish([]);
      } catch (err: unknown) {
        if (!proc.killed) logger.warn(`probe read failed for ${projectPath}: ${errorMessage(err)}`);
        finish([]);
      }
    })();
  });
}

// Returns the Claude slash commands for a project, served from cache when
// fresh. Concurrent callers for the same project share a single probe.
export async function getClaudeSlashCommands(projectPath: string): Promise<SlashCommand[]> {
  const cached = cache.get(projectPath);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.commands;
  }

  const existing = inFlight.get(projectPath);
  if (existing) return existing;

  const probe = probeClaudeSlashCommands(projectPath)
    .catch((err: unknown) => {
      // The probe is designed not to reject, but guard so discovery never
      // surfaces as a failed HTTP request to the composer.
      logger.warn(`probe rejected for ${projectPath}: ${errorMessage(err)}`);
      return [] as SlashCommand[];
    })
    .then((commands) => {
      // Cache successful results for the full TTL; negatively-cache empty
      // results briefly so a transient miss is retried soon rather than
      // suppressed for minutes or re-probed on every keystroke.
      const ttl = commands.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
      cache.set(projectPath, { commands, expiresAt: Date.now() + ttl });
      return commands;
    })
    .finally(() => {
      inFlight.delete(projectPath);
    });

  inFlight.set(projectPath, probe);
  return probe;
}
