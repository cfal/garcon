import { describe, expect, it, mock } from 'bun:test';

import {
  ClaudeSlashCommandDiscovery,
  parseInitSlashCommands,
} from '../slash-command-discovery.js';

describe('parseInitSlashCommands', () => {
  it('tags names present in skills as skills and others as commands', () => {
    const result = parseInitSlashCommands(
      ['clear', 'compact', 'dogfood', 'pm-pr'],
      ['dogfood', 'pm-pr'],
    );
    expect(result).toEqual([
      { name: 'clear', source: 'command' },
      { name: 'compact', source: 'command' },
      { name: 'dogfood', source: 'skill' },
      { name: 'pm-pr', source: 'skill' },
    ]);
  });

  it('sorts commands alphabetically', () => {
    const result = parseInitSlashCommands(['zeta', 'alpha', 'mike'], []);
    expect(result.map((command) => command.name)).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('preserves initialize command descriptions and structured skill types', () => {
    expect(parseInitSlashCommands([
      { name: 'review', description: 'Review the current changes' },
      { name: 'design-doc', description: 'Write a design', type: 'skill' },
    ], [])).toEqual([
      {
        name: 'design-doc',
        source: 'skill',
        description: 'Write a design',
      },
      {
        name: 'review',
        source: 'command',
        description: 'Review the current changes',
      },
    ]);
  });

  it('ignores non-string and missing values', () => {
    expect(parseInitSlashCommands(undefined, undefined)).toEqual([]);
    expect(parseInitSlashCommands([1, 'ok', null, {}], 'nope')).toEqual([
      { name: 'ok', source: 'command' },
    ]);
  });
});

describe('ClaudeSlashCommandDiscovery', () => {
  it('uses initialize metadata without submitting a model prompt', async () => {
    const originalSpawn = Bun.spawn;
    const encoder = new TextEncoder();
    let stdoutController;
    let resolveExit;
    let closed = false;
    const writes = [];
    const process = {
      pid: 1,
      killed: false,
      stdout: new ReadableStream({
        start(controller) {
          stdoutController = controller;
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stdin: {
        write(line) {
          writes.push(JSON.parse(line));
          const request = writes.at(-1);
          queueMicrotask(() => stdoutController.enqueue(encoder.encode(JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: request.request_id,
              response: {
                commands: [{ name: 'review', description: 'Review changes' }],
              },
            },
          }) + '\n')));
        },
        flush() {},
        end() {
          if (!closed) {
            closed = true;
            stdoutController.close();
          }
          resolveExit(0);
        },
      },
      exited: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      kill: mock(() => undefined),
    };
    Bun.spawn = mock(() => process);

    try {
      const discovery = new ClaudeSlashCommandDiscovery(
        () => 'claude',
        () => ({ CLAUDE_CONFIG_DIR: '/tmp/claude-config' }),
        {
          debug: mock(() => undefined),
          info: mock(() => undefined),
          warn: mock(() => undefined),
          error: mock(() => undefined),
        },
      );
      await expect(discovery.discover('/tmp')).resolves.toEqual([{
        name: 'review',
        source: 'command',
        description: 'Review changes',
      }]);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        type: 'control_request',
        request: { subtype: 'initialize' },
      });
      expect(writes.some((message) => message.type === 'user')).toBe(false);
      expect(Bun.spawn.mock.calls[0][1].env).toMatchObject({
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      });
      expect(Bun.spawn.mock.calls[0][1].env.CLAUDECODE).toBeUndefined();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
