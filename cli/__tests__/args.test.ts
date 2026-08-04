import { describe, expect, test } from 'bun:test';
import { parseCliArgs } from '../args.js';
import { CliError } from '../errors.js';

const CHAT_ID = '1785337200123456';
const ENV = { HOME: '/home/test' };

describe('parseCliArgs', () => {
  test('parses a write-capable new chat without forcing plan mode', () => {
    expect(parseCliArgs([
      '--workspace', 'work',
      '--cwd', './project',
      '--agent', 'codex',
      '--model', 'gpt-5.4',
      '--permissions', 'acceptEdits',
      '--reasoning-effort', 'high',
      '--title', '  Implement auth validation  ',
      'Implement', 'the', 'change',
    ], ENV, '/repo')).toEqual({
      kind: 'start',
      workspace: 'work',
      configDir: '/home/test/.garcon',
      cwd: '/repo/project',
      agentId: 'codex',
      model: 'gpt-5.4',
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      title: 'Implement auth validation',
      prompt: 'Implement the change',
      readsPromptFromStdin: false,
    });
  });

  test('parses a minimal resume and stdin prompt', () => {
    expect(parseCliArgs(['--resume', CHAT_ID, '-'], ENV, '/repo')).toEqual({
      kind: 'resume',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      prompt: null,
      readsPromptFromStdin: true,
    });
  });

  test('parses live catalog queries without submission arguments', () => {
    expect(parseCliArgs([
      'list', 'models',
      '--workspace', 'work',
      '--agent', 'codex',
      '--provider', 'acme',
      '--endpoint', 'east',
      '--json',
    ], ENV)).toEqual({
      kind: 'list',
      resource: 'models',
      workspace: 'work',
      configDir: '/home/test/.garcon',
      agentId: 'codex',
      providerId: 'acme',
      endpointId: 'east',
      json: true,
    });
    expect(parseCliArgs(['list', 'agents'], ENV)).toEqual({
      kind: 'list',
      resource: 'agents',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      json: false,
    });
  });

  test('normalizes and deduplicates repeatable additional tags', () => {
    expect(parseCliArgs([
      '--agent', 'codex',
      '--model', 'gpt',
      '--tag', 'Review Needed',
      '--tag', 'cli',
      '--tag', 'Priority',
      'Review',
    ], ENV)).toMatchObject({
      kind: 'start',
      additionalTags: ['priority', 'review-needed'],
    });
  });

  test('uses the server environment precedence for workspace discovery', () => {
    const result = parseCliArgs([
      '--config-dir', '/ignored',
      '--workspace', 'ignored',
      '--agent', 'claude',
      '--model', 'sonnet',
      'Review',
    ], {
      HOME: '/home/test',
      GARCON_CONFIG_DIR: '/env/config',
      GARCON_WORKSPACE: 'env-workspace',
    });
    expect(result).toMatchObject({
      configDir: '/env/config',
      workspace: 'env-workspace',
    });
  });

  test('preserves quoted prompt whitespace', () => {
    const result = parseCliArgs([
      '--agent', 'codex',
      '--model', 'gpt',
      '  preserve this spacing  ',
    ], ENV);

    expect(result).toMatchObject({ prompt: '  preserve this spacing  ' });
  });

  test('accepts a positional prompt beginning with list after the option terminator', () => {
    expect(parseCliArgs([
      '--agent', 'codex',
      '--model', 'gpt',
      '--', 'list', 'the', 'open', 'issues',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'list the open issues',
    });
  });

  test.each([
    { args: ['--agent', 'codex', 'prompt'], message: '--model is required' },
    { args: ['--model', 'gpt', 'prompt'], message: '--agent is required' },
    { args: ['--resume', CHAT_ID, '--cwd', '.', 'prompt'], message: '--cwd cannot' },
    { args: ['--resume', CHAT_ID, '--provider', 'p', 'prompt'], message: 'require --model' },
    { args: ['--endpoint', 'e', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: 'requires --provider' },
    { args: ['--workspace', '../other', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: 'without path separators' },
    { args: ['--permissions', 'dangerous', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: '--permissions must be' },
    { args: ['--resume', '123', 'prompt'], message: 'valid Garcon chat ID' },
    { args: ['--agent', 'codex', '--agent', 'claude', '--model', 'gpt', 'prompt'], message: 'only once' },
    { args: ['--agent', 'codex', '--model', 'gpt', 'prompt', '-'], message: 'must be the only prompt argument' },
    { args: ['list', 'models'], message: 'requires --agent' },
    { args: ['list', 'endpoints'], message: 'requires --provider' },
    { args: ['list', 'models', '--agent', 'codex', '--endpoint', 'east'], message: 'requires --provider' },
    { args: ['list', 'agents', '--agent', 'codex'], message: '--agent cannot be used' },
    { args: ['--json', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: 'only be used with list' },
    { args: ['list', 'agents', '--title', 'Review'], message: '--title cannot be used' },
    { args: ['--title', '  ', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: '--title must not be empty' },
    { args: ['--tag', '!!!', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: 'letters or numbers' },
  ])('rejects invalid arguments: $message', ({ args, message }) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
    try {
      parseCliArgs(args, ENV);
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });

  test('returns help without requiring submission arguments', () => {
    expect(parseCliArgs(['--help'], ENV)).toEqual({ kind: 'help' });
  });

  test('parses a minimal send-async command', () => {
    expect(parseCliArgs(['send-async', CHAT_ID, 'Implement the review'], ENV)).toEqual({
      kind: 'send-async',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      allowSteer: false,
      message: 'Implement the review',
      readsMessageFromStdin: false,
    });
  });

  test('parses a connection-qualified send-async with --allow-steer before or after the chat ID', () => {
    expect(parseCliArgs([
      '--workspace', 'work',
      '--config-dir', '/conf',
      '--server', 'http://127.0.0.1:8080',
      'send-async',
      '--allow-steer',
      CHAT_ID,
      'Follow up',
    ], ENV)).toEqual({
      kind: 'send-async',
      workspace: 'work',
      configDir: '/conf',
      serverUrl: 'http://127.0.0.1:8080',
      chatId: CHAT_ID,
      allowSteer: true,
      message: 'Follow up',
      readsMessageFromStdin: false,
    });
    expect(parseCliArgs(['send-async', CHAT_ID, '--allow-steer', 'Follow up'], ENV)).toMatchObject({
      kind: 'send-async',
      chatId: CHAT_ID,
      allowSteer: true,
      message: 'Follow up',
    });
  });

  test('reads the send-async message from stdin and preserves quoted whitespace', () => {
    expect(parseCliArgs(['send-async', CHAT_ID, '-'], ENV)).toMatchObject({
      kind: 'send-async',
      chatId: CHAT_ID,
      message: null,
      readsMessageFromStdin: true,
    });
    expect(parseCliArgs(['send-async', CHAT_ID, '  preserve  spacing  '], ENV)).toMatchObject({
      kind: 'send-async',
      message: '  preserve  spacing  ',
    });
  });

  test('parses a minimal stop command with connection options', () => {
    expect(parseCliArgs(['stop', CHAT_ID], ENV)).toEqual({
      kind: 'stop',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
    });
    expect(parseCliArgs(['--workspace', 'work', 'stop', CHAT_ID], ENV)).toMatchObject({
      kind: 'stop',
      workspace: 'work',
      chatId: CHAT_ID,
    });
  });

  test('accepts a send-async message after the option terminator', () => {
    expect(parseCliArgs(['send-async', CHAT_ID, '--', '--fix-the-parser'], ENV)).toMatchObject({
      kind: 'send-async',
      chatId: CHAT_ID,
      message: '--fix-the-parser',
    });
  });

  test('treats -- send-async and -- stop as new-chat prompts', () => {
    expect(parseCliArgs([
      '--agent', 'codex',
      '--model', 'gpt',
      '--', 'send-async', 'is', 'the', 'command', 'to', 'review',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'send-async is the command to review',
    });
    expect(parseCliArgs([
      '--agent', 'codex',
      '--model', 'gpt',
      '--', 'stop', 'the', 'agent',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'stop the agent',
    });
  });

  test.each([
    { args: ['send-async'], message: 'requires a chat ID and one message' },
    { args: ['send-async', CHAT_ID], message: 'requires a chat ID and one message' },
    { args: ['send-async', CHAT_ID, 'a', 'b'], message: 'requires a chat ID and one message' },
    { args: ['send-async', '123', 'message'], message: 'valid Garcon chat ID' },
    { args: ['send-async', CHAT_ID, '   '], message: 'message must not be empty' },
    { args: ['stop', CHAT_ID, 'extra'], message: 'exactly one chat ID' },
    { args: ['stop', '123'], message: 'valid Garcon chat ID' },
    { args: ['stop'], message: 'exactly one chat ID' },
    { args: ['send-async', CHAT_ID, '--cwd', '.', 'message'], message: '--cwd cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--agent', 'codex', 'message'], message: '--agent cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--provider', 'p', 'message'], message: '--provider cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--endpoint', 'e', 'message'], message: '--endpoint cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--model', 'gpt', 'message'], message: '--model cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--permissions', 'acceptEdits', 'message'], message: '--permissions cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--reasoning-effort', 'high', 'message'], message: '--reasoning-effort cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--title', 'T', 'message'], message: '--title cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--tag', 'review', 'message'], message: '--tag cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--resume', CHAT_ID, 'message'], message: '--resume cannot be used with send-async' },
    { args: ['send-async', CHAT_ID, '--json', 'message'], message: '--json cannot be used with send-async' },
    { args: ['stop', CHAT_ID, '--cwd', '.'], message: '--cwd cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--agent', 'codex'], message: '--agent cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--provider', 'p'], message: '--provider cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--endpoint', 'e'], message: '--endpoint cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--permissions', 'acceptEdits'], message: '--permissions cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--reasoning-effort', 'high'], message: '--reasoning-effort cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--title', 'T'], message: '--title cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--resume', CHAT_ID], message: '--resume cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--model', 'gpt'], message: '--model cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--tag', 'review'], message: '--tag cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--json'], message: '--json cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--allow-steer'], message: '--allow-steer cannot be used with stop' },
    { args: ['stop', CHAT_ID, '-'], message: 'exactly one chat ID' },
    { args: ['list', 'agents', '--allow-steer'], message: '--allow-steer cannot be used with list' },
    { args: ['--agent', 'codex', '--model', 'gpt', '--allow-steer', 'prompt'], message: '--allow-steer can only be used with send-async' },
    { args: ['--resume', CHAT_ID, '--allow-steer', 'prompt'], message: '--allow-steer can only be used with send-async' },
    { args: ['--agent', 'codex', '--model', 'gpt', '--allow-steer', '--', 'prompt'], message: '--allow-steer can only be used with send-async' },
    { args: ['send-async', CHAT_ID, '--tag', '!!!', 'message'], message: 'letters or numbers' },
  ])('rejects invalid control arguments: $message', ({ args, message }) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
    try {
      parseCliArgs(args, ENV);
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });
});
