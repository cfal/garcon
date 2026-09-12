import { describe, expect, it, mock } from 'bun:test';
import { buildClaudeCLIArgs, runSingleQuery } from '../cli-invocation.js';
import { buildClaudeCLIEnvironment } from '../cli-environment.js';

describe('Claude model context invocation', () => {
  for (const sessionOptions of [{}, { streamJson: true, sessionId: 'session-context' }, { streamJson: true, resumeSessionId: 'session-context' }]) {
    it(`translates a numeric suffix for ${JSON.stringify(sessionOptions)}`, () => {
      const args = buildClaudeCLIArgs({ ...sessionOptions, model: 'custom[922k]' });
      expect(args[args.indexOf('--model') + 1]).toBe('custom[1m]');
      expect(args[args.indexOf('--autocompact') + 1]).toBe('922k');
      expect(args).not.toContain('custom[922k]');
    });
  }

  it('leaves native [1m] compaction behavior unchanged', () => {
    const args = buildClaudeCLIArgs({ model: 'custom[1m]' });
    expect(args).toContain('custom[1m]');
    expect(args).not.toContain('--autocompact');
  });

  it('only clears the compaction override when the model supplies a cap', () => {
    const previous = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '500000';
    const overrides = {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_AUTH_TOKEN: 'test-credential',
    };
    try {
      const env = buildClaudeCLIEnvironment('custom[922k]', overrides);
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('test-credential');
      expect(env.CLAUDECODE).toBeUndefined();
      expect(buildClaudeCLIEnvironment('custom[922k]').CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(buildClaudeCLIEnvironment('custom[1m]', overrides).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('600000');
      expect(buildClaudeCLIEnvironment('custom').CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
      expect(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
      expect(overrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('600000');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previous;
    }
  });

  it('uses the same argument and environment policy for a one-shot query', async () => {
    const originalSpawn = Bun.spawn;
    const options = {
      model: 'custom[922k]',
      envOverrides: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000' },
    };
    Bun.spawn = mock(() => ({
      stdout: new Response('one-shot reply').body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
    }));
    try {
      await expect(runSingleQuery('A synthetic prompt.', options, {
        binary: () => 'claude',
        versionProbe: { assertCompatible: async () => [2, 1, 238] },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      })).resolves.toBe('one-shot reply');
      const [args, spawnOptions] = Bun.spawn.mock.calls[0];
      expect(args[args.indexOf('--model') + 1]).toBe('custom[1m]');
      expect(args[args.indexOf('--autocompact') + 1]).toBe('922k');
      expect(spawnOptions.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(options.model).toBe('custom[922k]');
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
