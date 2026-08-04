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
});
