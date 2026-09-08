import { describe, expect, test } from 'bun:test';
import {
  ASK_USER_QUESTION_ID_MAX_BYTES,
  ASK_USER_QUESTION_MAX_ANSWERS,
  ASK_USER_QUESTION_MAX_SELECTED_OPTIONS,
} from '@garcon/common/chat-command-contracts';
import { PREAMBLE_MAX_COUNT } from '@garcon/common/preambles';
import { CLI_HELP, parseCliArgs } from '../args.js';
import { CliError } from '../errors.js';

const CHAT_ID = '1785337200123456';
const PARENT_CHAT_ID = '1785337200123455';
const PREAMBLE_ID = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const SECOND_PREAMBLE_ID = '3502b645-222b-49d2-ac39-1c91f9fb1175';
const ENV = { HOME: '/home/test' };

describe('parseCliArgs', () => {
  test('parses a write-capable new chat without forcing plan mode', () => {
    expect(parseCliArgs([
      'start',
      '--workspace', 'work',
      '--cwd', './project',
      '--parent', PARENT_CHAT_ID,
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
      parentChatId: PARENT_CHAT_ID,
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
    expect(parseCliArgs(['resume', CHAT_ID, '-'], ENV, '/repo')).toEqual({
      kind: 'resume',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      prompt: null,
      readsPromptFromStdin: true,
    });
  });

  test('canonicalizes conversational message presentation independently of chat title', () => {
    expect(parseCliArgs([
      'start',
      '--agent', 'codex',
      '--model', 'gpt',
      '--title', 'Chat title',
      '--message-title', '  Operator context  ',
      'prompt',
    ], ENV)).toMatchObject({
      kind: 'start',
      title: 'Chat title',
      userMessagePresentation: {
        origin: 'cli',
        style: 'notice',
        title: 'Operator context',
      },
    });

    expect(parseCliArgs([
      'resume', CHAT_ID,
      '--message-style', 'error',
      '--collapsible',
      'prompt',
    ], ENV)).toMatchObject({
      kind: 'resume',
      userMessagePresentation: { origin: 'cli', style: 'error', disclosure: 'collapsed' },
    });
    expect(parseCliArgs(['resume-async', CHAT_ID, '--collapsible', 'prompt'], ENV)).toMatchObject({
      kind: 'resume-async',
      userMessagePresentation: { origin: 'cli', disclosure: 'collapsed' },
    });
  });

  test('normalizes custom presentation accents for new and resumed messages', () => {
    expect(parseCliArgs([
      'start', '--agent', 'codex', '--model', 'gpt', '--color', '7C3AED', 'prompt',
    ], ENV)).toMatchObject({
      kind: 'start',
      userMessagePresentation: {
        origin: 'cli',
        style: 'custom',
        customStyle: { lightAccent: '#7c3aed', darkAccent: '#7c3aed' },
      },
    });
    expect(parseCliArgs([
      'resume', CHAT_ID,
      '--message-style', 'custom',
      '--color', '#0EA5E9,c4b5fd',
      'prompt',
    ], ENV)).toMatchObject({
      kind: 'resume',
      userMessagePresentation: {
        origin: 'cli',
        style: 'custom',
        customStyle: { lightAccent: '#0ea5e9', darkAccent: '#c4b5fd' },
      },
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
    expect(parseCliArgs(['list', 'preambles', '--json'], ENV)).toEqual({
      kind: 'list',
      resource: 'preambles',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      json: true,
    });
  });

  test('normalizes and deduplicates repeatable additional tags', () => {
    expect(parseCliArgs([
      'start',
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
      'start',
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
      'start',
      '--agent', 'codex',
      '--model', 'gpt',
      '  preserve this spacing  ',
    ], ENV);

    expect(result).toMatchObject({ prompt: '  preserve this spacing  ' });
  });

  test('accepts prompt text beginning with a command after start', () => {
    expect(parseCliArgs([
      'start',
      '--agent', 'codex',
      '--model', 'gpt',
      'list', 'the', 'open', 'issues',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'list the open issues',
    });
  });

  test.each([
    { args: ['start', '--agent', 'codex', 'prompt'], message: '--model is required' },
    { args: ['start', '--model', 'gpt', 'prompt'], message: '--agent is required' },
    { args: ['resume', CHAT_ID, '--cwd', '.', 'prompt'], message: '--cwd cannot' },
    { args: ['resume', CHAT_ID, '--parent', PARENT_CHAT_ID, 'prompt'], message: '--parent cannot' },
    { args: ['start', '--parent', 'invalid', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: '--parent must be a valid' },
    { args: ['start', '--parent', PARENT_CHAT_ID, '--parent', CHAT_ID, '--agent', 'codex', '--model', 'gpt', 'prompt'], message: 'only once' },
    { args: ['resume-async', CHAT_ID, '--parent', PARENT_CHAT_ID, 'prompt'], message: '--parent cannot be used' },
    { args: ['resume', CHAT_ID, '--provider', 'p', 'prompt'], message: 'require --model' },
    { args: ['start', '--endpoint', 'e', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: 'requires --provider' },
    { args: ['start', '--workspace', '../other', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: 'without path separators' },
    { args: ['start', '--permissions', 'dangerous', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: '--permissions must be' },
    { args: ['resume', '123', 'prompt'], message: 'valid Garcon chat ID' },
    { args: ['start', '--agent', 'codex', '--agent', 'claude', '--model', 'gpt', 'prompt'], message: 'only once' },
    { args: ['start', '--agent', 'codex', '--model', 'gpt', 'prompt', '-'], message: 'must be the only prompt argument' },
    { args: ['list', 'models'], message: 'requires --agent' },
    { args: ['list', 'endpoints'], message: 'requires --provider' },
    { args: ['list', 'models', '--agent', 'codex', '--endpoint', 'east'], message: 'requires --provider' },
    { args: ['list', 'agents', '--agent', 'codex'], message: '--agent cannot be used' },
    { args: ['list', 'preambles', '--provider', 'acme'], message: '--provider cannot be used' },
    { args: ['start', '--json', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: '--json cannot be used with start' },
    { args: ['list', 'agents', '--title', 'Review'], message: '--title cannot be used' },
    { args: ['start', '--title', '  ', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: '--title must not be empty' },
    { args: ['start', '--tag', '!!!', '--agent', 'codex', '--model', 'gpt', 'prompt'], message: 'letters or numbers' },
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

  test('requires a known explicit command', () => {
    expect(() => parseCliArgs([], ENV)).toThrow('a command is required');
    expect(() => parseCliArgs(['Review', 'this'], ENV)).toThrow('unknown command: Review');
    expect(() => parseCliArgs(['send-async', CHAT_ID, 'message'], ENV))
      .toThrow('unknown command: send-async');
  });

  test('parses start-async with the new-chat options', () => {
    expect(parseCliArgs([
      'start-async',
      '--cwd', './project',
      '--parent', PARENT_CHAT_ID,
      '--agent', 'codex',
      '--model', 'gpt-5.4',
      'Review', 'this',
    ], ENV, '/repo')).toMatchObject({
      kind: 'start-async',
      cwd: '/repo/project',
      parentChatId: PARENT_CHAT_ID,
      agentId: 'codex',
      model: 'gpt-5.4',
      prompt: 'Review this',
      readsPromptFromStdin: false,
      json: false,
    });
  });

  test('parses explicit ordered and empty preamble selections for new chats', () => {
    expect(parseCliArgs([
      'start', '--agent', 'codex', '--model', 'gpt',
      '--preamble', PREAMBLE_ID,
      '--preamble', SECOND_PREAMBLE_ID,
      'Review',
    ], ENV)).toMatchObject({
      kind: 'start',
      orderedPreambleIds: [PREAMBLE_ID, SECOND_PREAMBLE_ID],
    });
    expect(parseCliArgs([
      'start-async', '--agent', 'codex', '--model', 'gpt', '--no-preamble', '--json', 'Review',
    ], ENV)).toMatchObject({
      kind: 'start-async',
      orderedPreambleIds: [],
      json: true,
    });
  });

  test('accepts at most the shared preamble selection limit', () => {
    const preambleIds = Array.from(
      { length: PREAMBLE_MAX_COUNT },
      (_, index) => `3502b645-222b-49d2-ac39-${index.toString().padStart(12, '0')}`,
    );
    const selectionArgs = preambleIds.flatMap((id) => ['--preamble', id]);

    expect(parseCliArgs([
      'start', '--agent', 'codex', '--model', 'gpt', ...selectionArgs, 'Review',
    ], ENV)).toMatchObject({ orderedPreambleIds: preambleIds });
    expect(() => parseCliArgs([
      'start', '--agent', 'codex', '--model', 'gpt',
      ...selectionArgs,
      '--preamble', '3502b645-222b-49d2-ac39-000000000100',
      'Review',
    ], ENV)).toThrow(`--preamble may be specified at most ${PREAMBLE_MAX_COUNT} times`);
  });

  test('documents presentation on conversational commands and its native-history boundary', () => {
    expect(CLI_HELP).toContain(
      'garcon-cli [options] start [--parent <chat-id>] [--no-preamble | --preamble <id>...] [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <prompt>',
    );
    expect(CLI_HELP).toContain(
      'resume <chat-id> [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <prompt>',
    );
    expect(CLI_HELP).toContain(
      'resume-async <chat-id> [--allow-steer] [--json] [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <message>',
    );
    expect(CLI_HELP).toContain('Native-history\nReload');
    expect(CLI_HELP).toContain('provider-native fork segments may drop');
    expect(CLI_HELP).toContain('--color selects custom styling');
    expect(CLI_HELP).toContain('--parent <chat-id>');
  });

  test('parses an exact turn wait with connection options and JSON output', () => {
    expect(parseCliArgs([
      '--workspace', 'work',
      '--config-dir', '/conf',
      '--server', 'http://127.0.0.1:8080',
      'wait', CHAT_ID,
      '--turn', 'turn-1',
      '--json',
    ], ENV)).toEqual({
      kind: 'wait',
      workspace: 'work',
      configDir: '/conf',
      serverUrl: 'http://127.0.0.1:8080',
      chatId: CHAT_ID,
      turnId: 'turn-1',
      json: true,
    });
  });

  test('parses chat status with a bounded transcript tail', () => {
    expect(parseCliArgs([
      '--workspace', 'work',
      '--config-dir', '/conf',
      '--server', 'http://127.0.0.1:8080',
      'status', CHAT_ID,
      '--messages', '20',
      '--json',
    ], ENV)).toEqual({
      kind: 'status',
      workspace: 'work',
      configDir: '/conf',
      serverUrl: 'http://127.0.0.1:8080',
      chatId: CHAT_ID,
      messageLimit: 20,
      json: true,
    });
    expect(parseCliArgs(['status', CHAT_ID], ENV)).toMatchObject({
      kind: 'status',
      messageLimit: 10,
      json: false,
    });
    expect(parseCliArgs(['status', CHAT_ID, '--messages', '0'], ENV)).toMatchObject({
      messageLimit: 0,
    });
  });

  test('accepts a prompt beginning with wait after start and the option terminator', () => {
    expect(parseCliArgs([
      'start',
      '--agent', 'codex',
      '--model', 'gpt',
      '--', 'wait', 'for', 'the', 'review',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'wait for the review',
    });
  });

  test('accepts a prompt beginning with status after start and the option terminator', () => {
    expect(parseCliArgs([
      'start',
      '--agent', 'codex',
      '--model', 'gpt',
      '--', 'status', 'the', 'current', 'work',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'status the current work',
    });
  });

  test.each([
    { args: ['status'], message: 'exactly one chat ID' },
    { args: ['status', CHAT_ID, 'extra'], message: 'exactly one chat ID' },
    { args: ['status', '123'], message: 'valid Garcon chat ID' },
    { args: ['status', CHAT_ID, '--messages=-1'], message: 'integer from 0 through 200' },
    { args: ['status', CHAT_ID, '--messages', '201'], message: 'integer from 0 through 200' },
    { args: ['status', CHAT_ID, '--messages', '1.5'], message: 'integer from 0 through 200' },
    { args: ['status', CHAT_ID, '--messages', '1e2'], message: 'integer from 0 through 200' },
    { args: ['status', CHAT_ID, '--messages', '1', '--messages', '2'], message: 'only once' },
    { args: ['status', CHAT_ID, '--turn', 'turn-1'], message: '--turn cannot be used with status' },
    { args: ['status', CHAT_ID, '--cwd', '.'], message: '--cwd cannot be used with status' },
    { args: ['status', CHAT_ID, '--agent', 'codex'], message: '--agent cannot be used with status' },
    { args: ['status', CHAT_ID, '--provider', 'p'], message: '--provider cannot be used with status' },
    { args: ['status', CHAT_ID, '--endpoint', 'e'], message: '--endpoint cannot be used with status' },
    { args: ['status', CHAT_ID, '--model', 'gpt'], message: '--model cannot be used with status' },
    { args: ['status', CHAT_ID, '--permissions', 'plan'], message: '--permissions cannot be used with status' },
    { args: ['status', CHAT_ID, '--reasoning-effort', 'high'], message: '--reasoning-effort cannot be used with status' },
    { args: ['status', CHAT_ID, '--title', 'T'], message: '--title cannot be used with status' },
    { args: ['status', CHAT_ID, '--tag', 'review'], message: '--tag cannot be used with status' },
    { args: ['status', CHAT_ID, '--resume', CHAT_ID], message: 'Unknown option' },
    { args: ['status', CHAT_ID, '--allow-steer'], message: '--allow-steer cannot be used with status' },
    { args: ['status', CHAT_ID, '--collapsible'], message: '--collapsible cannot be used with status' },
    { args: ['wait', CHAT_ID, '--turn', 'turn-1', '--messages', '1'], message: '--messages cannot be used with wait' },
    { args: ['list', 'agents', '--messages', '1'], message: '--messages cannot be used with list' },
    { args: ['stop', CHAT_ID, '--messages', '1'], message: '--messages cannot be used with stop' },
    { args: ['resume-async', CHAT_ID, '--messages', '1', 'message'], message: '--messages cannot be used with resume-async' },
    { args: ['start', '--agent', 'codex', '--model', 'gpt', '--messages', '1', 'prompt'], message: '--messages cannot be used with start' },
  ])('rejects invalid status arguments: $message', ({ args, message }) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test.each([
    { args: ['wait', CHAT_ID], message: 'valid --turn ID' },
    { args: ['wait', CHAT_ID, '--turn', ''], message: 'valid --turn ID' },
    { args: ['wait', CHAT_ID, '--turn', ' padded '], message: 'valid --turn ID' },
    { args: ['wait', CHAT_ID, '--turn', 'a'.repeat(257)], message: 'valid --turn ID' },
    { args: ['wait', '123', '--turn', 'turn-1'], message: 'valid Garcon chat ID' },
    { args: ['wait', CHAT_ID, 'extra', '--turn', 'turn-1'], message: 'exactly one chat ID' },
    { args: ['wait', CHAT_ID, '--turn', 'one', '--turn', 'two'], message: 'only once' },
    { args: ['wait', CHAT_ID, '--turn', 'turn-1', '--cwd', '.'], message: '--cwd cannot be used with wait' },
    { args: ['wait', CHAT_ID, '--turn', 'turn-1', '--allow-steer'], message: '--allow-steer cannot be used with wait' },
    { args: ['wait', CHAT_ID, '--turn', 'turn-1', '--collapsible'], message: '--collapsible cannot be used with wait' },
    { args: ['list', 'agents', '--turn', 'turn-1'], message: '--turn cannot be used with list' },
    { args: ['stop', CHAT_ID, '--turn', 'turn-1'], message: '--turn cannot be used with stop' },
    { args: ['resume-async', CHAT_ID, '--turn', 'turn-1', 'message'], message: '--turn cannot be used with resume-async' },
    { args: ['start', '--agent', 'codex', '--model', 'gpt', '--turn', 'turn-1', 'prompt'], message: '--turn cannot be used with start' },
  ])('rejects invalid wait arguments: $message', ({ args, message }) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test('parses a minimal resume-async command', () => {
    expect(parseCliArgs(['resume-async', CHAT_ID, 'Implement the review'], ENV)).toEqual({
      kind: 'resume-async',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      allowSteer: false,
      message: 'Implement the review',
      readsMessageFromStdin: false,
      json: false,
    });
  });

  test('parses resume-async message presentation', () => {
    expect(parseCliArgs([
      'resume-async', CHAT_ID,
      '--message-title', 'Blocker',
      '--message-style', 'info',
      'Do not deploy',
    ], ENV)).toMatchObject({
      kind: 'resume-async',
      message: 'Do not deploy',
      userMessagePresentation: { origin: 'cli', style: 'info', title: 'Blocker' },
    });
  });

  test('parses a connection-qualified resume-async with --allow-steer before or after the chat ID', () => {
    expect(parseCliArgs([
      '--workspace', 'work',
      '--config-dir', '/conf',
      '--server', 'http://127.0.0.1:8080',
      'resume-async',
      '--allow-steer',
      CHAT_ID,
      'Follow up',
    ], ENV)).toEqual({
      kind: 'resume-async',
      workspace: 'work',
      configDir: '/conf',
      serverUrl: 'http://127.0.0.1:8080',
      chatId: CHAT_ID,
      allowSteer: true,
      message: 'Follow up',
      readsMessageFromStdin: false,
      json: false,
    });
    expect(parseCliArgs(['resume-async', CHAT_ID, '--allow-steer', 'Follow up'], ENV)).toMatchObject({
      kind: 'resume-async',
      chatId: CHAT_ID,
      allowSteer: true,
      message: 'Follow up',
    });
  });

  test('reads the resume-async message from stdin and preserves quoted whitespace', () => {
    expect(parseCliArgs(['resume-async', CHAT_ID, '-'], ENV)).toMatchObject({
      kind: 'resume-async',
      chatId: CHAT_ID,
      message: null,
      readsMessageFromStdin: true,
    });
    expect(parseCliArgs(['resume-async', CHAT_ID, '  preserve  spacing  '], ENV)).toMatchObject({
      kind: 'resume-async',
      message: '  preserve  spacing  ',
    });
  });

  test('parses a minimal stop command with connection options', () => {
    expect(parseCliArgs(['stop', CHAT_ID], ENV)).toEqual({
      kind: 'stop',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      json: false,
    });
    expect(parseCliArgs(['--workspace', 'work', 'stop', CHAT_ID], ENV)).toMatchObject({
      kind: 'stop',
      workspace: 'work',
      chatId: CHAT_ID,
    });
  });

  test('accepts a resume-async message after the option terminator', () => {
    expect(parseCliArgs(['resume-async', CHAT_ID, '--', '--fix-the-parser'], ENV)).toMatchObject({
      kind: 'resume-async',
      chatId: CHAT_ID,
      message: '--fix-the-parser',
    });
  });

  test('accepts prompts beginning with control commands after start', () => {
    expect(parseCliArgs([
      'start',
      '--agent', 'codex',
      '--model', 'gpt',
      '--', 'resume-async', 'is', 'the', 'command', 'to', 'review',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'resume-async is the command to review',
    });
    expect(parseCliArgs([
      'start',
      '--agent', 'codex',
      '--model', 'gpt',
      '--', 'stop', 'the', 'agent',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'stop the agent',
    });
  });

  test.each([
    { args: ['resume-async'], message: 'requires a chat ID and one message' },
    { args: ['resume-async', CHAT_ID], message: 'requires a chat ID and one message' },
    { args: ['resume-async', CHAT_ID, 'a', 'b'], message: 'requires a chat ID and one message' },
    { args: ['resume-async', '123', 'message'], message: 'valid Garcon chat ID' },
    { args: ['resume-async', CHAT_ID, '   '], message: 'message must not be empty' },
    { args: ['stop', CHAT_ID, 'extra'], message: 'exactly one chat ID' },
    { args: ['stop', '123'], message: 'valid Garcon chat ID' },
    { args: ['stop'], message: 'exactly one chat ID' },
    { args: ['resume-async', CHAT_ID, '--cwd', '.', 'message'], message: '--cwd cannot be used with resume-async' },
    { args: ['resume-async', CHAT_ID, '--agent', 'codex', 'message'], message: '--agent cannot be used with resume-async' },
    { args: ['resume-async', CHAT_ID, '--provider', 'p', 'message'], message: '--provider cannot be used with resume-async' },
    { args: ['resume-async', CHAT_ID, '--endpoint', 'e', 'message'], message: '--endpoint cannot be used with resume-async' },
    { args: ['resume-async', CHAT_ID, '--model', 'gpt', 'message'], message: '--model cannot be used with resume-async' },
    { args: ['resume-async', CHAT_ID, '--permissions', 'acceptEdits', 'message'], message: '--permissions cannot be used with resume-async' },
    { args: ['resume-async', CHAT_ID, '--reasoning-effort', 'high', 'message'], message: '--reasoning-effort cannot be used with resume-async' },
    { args: ['resume-async', CHAT_ID, '--title', 'T', 'message'], message: '--title cannot be used with resume-async' },
    { args: ['resume-async', CHAT_ID, '--tag', 'review', 'message'], message: '--tag cannot be used with resume-async' },
    { args: ['resume-async', CHAT_ID, '--resume', CHAT_ID, 'message'], message: 'Unknown option' },
    { args: ['stop', CHAT_ID, '--cwd', '.'], message: '--cwd cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--agent', 'codex'], message: '--agent cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--provider', 'p'], message: '--provider cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--endpoint', 'e'], message: '--endpoint cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--permissions', 'acceptEdits'], message: '--permissions cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--reasoning-effort', 'high'], message: '--reasoning-effort cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--title', 'T'], message: '--title cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--resume', CHAT_ID], message: 'Unknown option' },
    { args: ['stop', CHAT_ID, '--model', 'gpt'], message: '--model cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--tag', 'review'], message: '--tag cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--allow-steer'], message: '--allow-steer cannot be used with stop' },
    { args: ['stop', CHAT_ID, '-'], message: 'exactly one chat ID' },
    { args: ['list', 'agents', '--allow-steer'], message: '--allow-steer cannot be used with list' },
    { args: ['start', '--agent', 'codex', '--model', 'gpt', '--allow-steer', 'prompt'], message: '--allow-steer cannot be used with start' },
    { args: ['--resume', CHAT_ID, '--allow-steer', 'prompt'], message: 'Unknown option' },
    { args: ['start', '--agent', 'codex', '--model', 'gpt', '--allow-steer', '--', 'prompt'], message: '--allow-steer cannot be used with start' },
    { args: ['resume-async', CHAT_ID, '--tag', '!!!', 'message'], message: 'letters or numbers' },
    { args: ['resume-async', CHAT_ID, '--message-style', 'INFO', 'message'], message: 'must be one of: info, notice, error, custom' },
    { args: ['resume-async', CHAT_ID, '--message-style', 'custom', 'message'], message: 'requires --color' },
    { args: ['resume-async', CHAT_ID, '--message-style', 'error', '--color', '7c3aed', 'message'], message: 'preset --message-style' },
    { args: ['resume-async', CHAT_ID, '--color', 'red', 'message'], message: 'six-digit hex colors' },
    { args: ['resume-async', CHAT_ID, '--markdown', 'message'], message: '--markdown cannot be used with resume-async' },
    { args: ['stop', CHAT_ID, '--message-title', 'Heading'], message: '--message-title cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--collapsible'], message: '--collapsible cannot be used with stop' },
    { args: ['status', CHAT_ID, '--message-style', 'notice'], message: '--message-style cannot be used with status' },
    { args: ['list', 'agents', '--message-title', 'Heading'], message: '--message-title cannot be used with list' },
    { args: ['list', 'agents', '--collapsible'], message: '--collapsible cannot be used with list' },
  ])('rejects invalid control arguments: $message', ({ args, message }) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
    try {
      parseCliArgs(args, ENV);
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });

  test('parses JSON output for asynchronous delivery and stop', () => {
    expect(parseCliArgs(['resume-async', CHAT_ID, '--json', 'message'], ENV)).toMatchObject({
      kind: 'resume-async',
      json: true,
    });
    expect(parseCliArgs(['stop', CHAT_ID, '--json'], ENV)).toMatchObject({
      kind: 'stop',
      json: true,
    });
  });

  test('parses permission decisions and desired metadata state', () => {
    expect(parseCliArgs([
      '--workspace', 'work',
      'permission-decision', CHAT_ID, 'permission-1', 'allow',
      '--run', 'run-1', '--server-instance', 'instance-1', '--json',
    ], ENV)).toEqual({
      kind: 'permission-decision',
      workspace: 'work',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      permissionOccurrenceId: 'permission-1',
      runId: 'run-1',
      serverInstanceId: 'instance-1',
      allow: true,
      json: true,
    });
    expect(parseCliArgs([
      'permission-answer', CHAT_ID, 'permission-1',
      '--answers', JSON.stringify([{
        questionId: 'question-1',
        selectedOptionIds: ['option-1', 'option-2'],
      }]),
      '--run', 'run-1', '--server-instance', 'instance-1', '--json',
    ], ENV)).toEqual({
      kind: 'permission-answer',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      permissionOccurrenceId: 'permission-1',
      runId: 'run-1',
      serverInstanceId: 'instance-1',
      response: {
        type: 'ask-user-question-response',
        outcome: 'answered',
        answers: [{
          questionId: 'question-1',
          selectedOptionIds: ['option-1', 'option-2'],
        }],
      },
      json: true,
    });
    expect(parseCliArgs(['unarchive', CHAT_ID], ENV)).toMatchObject({
      kind: 'unarchive', chatId: CHAT_ID, json: false,
    });
    expect(parseCliArgs(['rename', CHAT_ID, '  Review', 'results  ', '--json'], ENV)).toMatchObject({
      kind: 'rename', chatId: CHAT_ID, title: 'Review results', json: true,
    });
    expect(parseCliArgs([
      'set-tags', CHAT_ID, '--tag', 'Review Needed', '--tag', 'ops!', '--json',
    ], ENV)).toMatchObject({
      kind: 'set-tags', chatId: CHAT_ID, tags: ['ops', 'review-needed'], json: true,
    });
    expect(parseCliArgs(['set-tags', CHAT_ID, '--clear'], ENV)).toMatchObject({
      kind: 'set-tags', chatId: CHAT_ID, tags: [], json: false,
    });
  });

  test.each([
    [['permission-decision', CHAT_ID, 'permission-1', 'allow', '--run', 'run-1'], '--server-instance'],
    [['permission-decision', CHAT_ID, 'permission-1', 'maybe', '--run', 'run-1', '--server-instance', 'instance-1'], 'allow or deny'],
    [['permission-decision', CHAT_ID, ' padded ', 'deny', '--run', 'run-1', '--server-instance', 'instance-1'], 'permission occurrence ID'],
    [['archive', CHAT_ID, 'extra'], 'exactly one chat ID'],
    [['rename', CHAT_ID], 'chat ID and title'],
    [['set-tags', CHAT_ID], 'either repeatable --tag or --clear'],
    [['set-tags', CHAT_ID, '--clear', '--tag', 'ops'], 'either repeatable --tag or --clear'],
    [['start', '--agent', 'codex', '--model', 'gpt', '--no-preamble', '--preamble', PREAMBLE_ID, 'prompt'], 'cannot be combined'],
    [['start', '--agent', 'codex', '--model', 'gpt', '--preamble', PREAMBLE_ID, '--preamble', PREAMBLE_ID, 'prompt'], 'duplicate IDs'],
    [['start', '--agent', 'codex', '--model', 'gpt', '--preamble', 'not-a-uuid', 'prompt'], 'canonical UUID v4'],
    [['resume', CHAT_ID, '--no-preamble', 'prompt'], '--no-preamble cannot be used with resume'],
  ])('rejects invalid automation arguments: %s', (args, message) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test.each([
    [undefined, 'requires --answers'],
    ['not-json', 'valid JSON'],
    [JSON.stringify({ questionId: 'question-1' }), 'bounded array'],
    [JSON.stringify([
      { questionId: 'question-1', selectedOptionIds: [] },
      { questionId: 'question-1', selectedOptionIds: [] },
    ]), 'bounded array'],
    [JSON.stringify([{
      questionId: 'question-1',
      selectedOptionIds: ['option-1', 'option-1'],
    }]), 'bounded array'],
    [JSON.stringify(Array.from(
      { length: ASK_USER_QUESTION_MAX_ANSWERS + 1 },
      (_, index) => ({ questionId: `question-${index}`, selectedOptionIds: [] }),
    )), 'bounded array'],
    [JSON.stringify([{
      questionId: 'question-1',
      selectedOptionIds: Array.from(
        { length: ASK_USER_QUESTION_MAX_SELECTED_OPTIONS + 1 },
        (_, index) => `option-${index}`,
      ),
    }]), 'bounded array'],
    [JSON.stringify([{
      questionId: 'q'.repeat(ASK_USER_QUESTION_ID_MAX_BYTES + 1),
      selectedOptionIds: [],
    }]), 'bounded array'],
  ])('rejects invalid structured permission answers', (answers, message) => {
    const args = [
      'permission-answer', CHAT_ID, 'permission-1',
      '--run', 'run-1', '--server-instance', 'instance-1',
    ];
    if (answers !== undefined) args.push('--answers', answers);
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test('rejects repeated structured permission answer payloads', () => {
    expect(() => parseCliArgs([
      'permission-answer', CHAT_ID, 'permission-1',
      '--answers', '[]', '--answers', '[]',
      '--run', 'run-1', '--server-instance', 'instance-1',
    ], ENV)).toThrow('option may be specified only once: --answers');
  });
});

describe('chat research arguments', () => {
  test('parses chat catalog filters and paging', () => {
    expect(parseCliArgs([
      'chats',
      '--filter', 'project:/garcon tag:cli',
      '--limit', '25',
      '--offset', '50',
      '--json',
    ], ENV)).toEqual({
      kind: 'chats',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      filter: 'project:/garcon tag:cli',
      limit: 25,
      offset: 50,
      json: true,
    });
    expect(parseCliArgs(['chats'], ENV)).toMatchObject({
      filter: '',
      limit: 50,
      offset: 0,
      json: false,
    });
  });

  test('parses transcript search paging and preserves the query', () => {
    expect(parseCliArgs([
      'search', '"version bump"',
      '--filter', 'agent:codex',
      '--sort', 'created',
      '--limit', '100',
      '--offset', '12',
      '--snippets', '2',
      '--json',
    ], ENV)).toMatchObject({
      kind: 'search',
      query: '"version bump"',
      filter: 'agent:codex',
      sort: 'created',
      limit: 100,
      offset: 12,
      snippetLimit: 2,
      json: true,
    });
    expect(parseCliArgs(['search', 'root', 'cause'], ENV)).toMatchObject({
      query: 'root cause',
      sort: 'relevance',
      limit: 20,
      offset: 0,
      snippetLimit: 3,
    });
  });

  test('parses grep-style read context and canonical include categories', () => {
    expect(parseCliArgs([
      'read', CHAT_ID, '84',
      '-B', '3',
      '--after-context', '8',
      '--include', 'tools,reasoning',
      '--include', 'permissions,tool-calls',
      '--transcript-view-id', 'view-1',
      '--json',
    ], ENV)).toEqual({
      kind: 'read',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      anchorOrdinal: 84,
      beforeContext: 3,
      afterContext: 8,
      includedCategories: ['tool-calls', 'tool-results', 'reasoning', 'permissions'],
      transcriptViewId: 'view-1',
      json: true,
    });
    expect(parseCliArgs(['read', CHAT_ID, '1'], ENV)).toMatchObject({
      beforeContext: 5,
      afterContext: 5,
      includedCategories: [],
      json: false,
    });
  });

  test('rejects extra chat catalog positionals', () => {
    expect(() => parseCliArgs(['chats', 'extra'], ENV)).toThrow(
      'chats accepts no positional arguments',
    );
  });

  test.each([
    [['search'], 'search requires a query'],
    [['search', 'term', '--limit', '0'], '--limit must be an integer from 1 through 100'],
    [['search', 'term', '--limit', '101'], '--limit must be an integer from 1 through 100'],
    [['search', 'term', '--offset', '10000'], '--offset must be an integer from 0 through 9999'],
    [['search', 'term', '--snippets', '4'], '--snippets must be an integer from 1 through 3'],
    [['search', 'term', '--sort', 'latest'], '--sort must be one of'],
    [['chats', '--limit', '1.5'], '--limit must be an integer from 1 through 100'],
    [['chats', '--filter', ''], '--filter must not be empty'],
    [['search', 'term', '--filter', ''], '--filter must not be empty'],
    [['read', CHAT_ID], 'read requires one chat ID and one anchor ordinal'],
    [['read', CHAT_ID, '0'], 'positive integer anchor ordinal'],
    [['read', CHAT_ID, '1', '-A', '101'], '--after-context must be an integer from 0 through 100'],
    [['read', CHAT_ID, '1', '-B=-1'], '--before-context must be an integer from 0 through 100'],
    [['read', CHAT_ID, '1', '--include', 'unknown'], '--include must be one of'],
    [['read', CHAT_ID, '1', '--include', 'tools,,reasoning'], 'empty category'],
    [['read', CHAT_ID, '1', '--transcript-view-id', ''], '--transcript-view-id must not be empty'],
    [['chats', '--snippets', '1'], '--snippets cannot be used with chats'],
    [['search', 'term', '-A', '1'], '--after-context cannot be used with search'],
    [['read', CHAT_ID, '1', '--sort', 'created'], '--sort cannot be used with read'],
  ])('rejects invalid research arguments: %s', (args, message) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });
});

describe('add-row arguments', () => {
  test('parses positional and stdin content with connection options', () => {
    expect(parseCliArgs([
      '--workspace', 'review',
      'add-row', CHAT_ID,
      '--type', 'notice',
      '--title', '  Deployment  ',
      '  exact content\n',
    ], ENV)).toEqual({
      kind: 'add-row',
      workspace: 'review',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      presentation: { style: 'notice' },
      format: 'plain',
      disclosure: 'expanded',
      title: 'Deployment',
      content: '  exact content\n',
      readsContentFromStdin: false,
    });
    expect(parseCliArgs([
      'add-row', CHAT_ID, '-', '--type', 'error', '--title', 'Release validation',
      '--collapsible',
    ], ENV)).toMatchObject({
      kind: 'add-row',
      presentation: { style: 'error' },
      format: 'plain',
      disclosure: 'collapsed',
      title: 'Release validation',
      content: null,
      readsContentFromStdin: true,
    });
    expect(parseCliArgs([
      'add-row', CHAT_ID, '--type', 'info', '--', '--starts-with-dash',
    ], ENV)).toMatchObject({
      presentation: { style: 'info' },
      format: 'plain',
      content: '--starts-with-dash',
    });
    expect(parseCliArgs([
      'add-row', CHAT_ID,
      '--color', '7C3AED,c4b5fd',
      '--markdown',
      '## Complete',
    ], ENV)).toMatchObject({
      presentation: {
        style: 'custom',
        customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
      },
      format: 'markdown',
      content: '## Complete',
    });
  });

  test.each([
    [['add-row', CHAT_ID, 'content'], 'requires --type info or --type notice or --type error or --color'],
    [['add-row', CHAT_ID, '--type', 'alert', 'content'], 'requires --type info or --type notice or --type error or --color'],
    [['add-row', CHAT_ID, '--type', 'custom', 'content'], 'requires --color'],
    [['add-row', CHAT_ID, '--type', 'error', '--color', '7c3aed', 'content'], 'preset --type'],
    [['add-row', CHAT_ID, '--color', '7c3aed,', 'content'], 'six-digit hex colors'],
    [['add-row', CHAT_ID, '--type', 'notice', '--type', 'error', 'content'], 'only once'],
    [['add-row', CHAT_ID, '--type', 'notice'], 'requires a chat ID and one content argument'],
    [['add-row', CHAT_ID, '--type', 'notice', 'one', 'two'], 'requires a chat ID and one content argument'],
    [['add-row', 'bad', '--type', 'notice', 'content'], 'valid Garcon chat ID'],
    [['add-row', CHAT_ID, '--type', 'notice', '   '], 'row content must not be empty'],
    [['add-row', CHAT_ID, '--type', 'notice', '--title', '   ', 'content'], 'title must not be empty'],
    [['add-row', CHAT_ID, '--type', 'notice', '--title', 'first\nsecond', 'content'], 'title must be a single line'],
    [['add-row', CHAT_ID, '--type', 'notice', '--title', 'x'.repeat(121), 'content'], 'title must be at most 120 characters'],
    [['add-row', CHAT_ID, '--type', 'notice', '--title', 'one', '--title', 'two', 'content'], 'only once'],
    [['add-row', CHAT_ID, '--type', 'notice', '--json', 'content'], '--json cannot be used with add-row'],
    [['resume-async', CHAT_ID, '--type', 'notice', 'content'], '--type cannot be used with resume-async'],
    [['stop', CHAT_ID, '--type', 'notice'], '--type cannot be used with stop'],
    [['status', CHAT_ID, '--type', 'notice'], '--type cannot be used with status'],
    [['list', 'agents', '--type', 'notice'], '--type cannot be used with list'],
    [['start', '--agent', 'codex', '--model', 'gpt', '--type', 'notice', 'prompt'], '--type cannot be used with start'],
  ])('rejects invalid add-row arguments: %s', (args, message) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test('accepts an option-terminated add-row prompt after start', () => {
    expect(parseCliArgs([
      'start',
      '--agent', 'codex', '--model', 'gpt', '--', 'add-row', 'is', 'documented',
    ], ENV)).toMatchObject({ kind: 'start', prompt: 'add-row is documented' });
  });
});

describe('export arguments', () => {
  test('parses formats, repeatable exclusions, aliases, and file output canonically', () => {
    expect(parseCliArgs([
      '--workspace', 'review',
      'export', CHAT_ID,
      '--format', 'xml',
      '--exclude', 'handoffs,tools',
      '--exclude', 'reasoning,tool-calls',
      '--output', './transcript.xml',
      '--force',
    ], ENV)).toEqual({
      kind: 'export',
      workspace: 'review',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      format: 'xml',
      exclusions: ['tool-calls', 'tool-results', 'reasoning', 'handoffs'],
      outputPath: './transcript.xml',
      force: true,
    });
    expect(parseCliArgs(['export', CHAT_ID], ENV)).toMatchObject({
      kind: 'export',
      format: 'markdown',
      exclusions: [],
      force: false,
    });
  });

  test.each([
    [['export'], 'exactly one chat ID'],
    [['export', 'bad'], 'valid Garcon chat ID'],
    [['export', CHAT_ID, '--format', 'json'], '--format must be markdown or xml'],
    [['export', CHAT_ID, '--format', 'xml', '--format', 'markdown'], 'only once'],
    [['export', CHAT_ID, '--exclude', 'unknown'], '--exclude must be one of'],
    [['export', CHAT_ID, '--exclude', 'toString'], '--exclude must be one of'],
    [['export', CHAT_ID, '--exclude', 'tools,,reasoning'], 'empty category'],
    [['export', CHAT_ID, '--output', '-'], 'omit --output'],
    [['export', CHAT_ID, '--force'], '--force requires --output'],
    [['export', CHAT_ID, '--json'], '--json cannot be used with export'],
    [['export', CHAT_ID, '--collapsible'], '--collapsible cannot be used with export'],
    [['status', CHAT_ID, '--format', 'xml'], '--format cannot be used with status'],
    [['wait', CHAT_ID, '--turn', 'turn-1', '--exclude', 'tools'], '--exclude cannot be used with wait'],
    [['list', 'agents', '--output', 'file'], '--output cannot be used with list'],
    [['resume-async', CHAT_ID, '--force', 'message'], '--force cannot be used with resume-async'],
    [['start', '--agent', 'codex', '--model', 'gpt', '--format', 'xml', 'prompt'], '--format cannot be used with start'],
  ])('rejects invalid export arguments: %s', (args, message) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test('accepts an option-terminated export prompt after start', () => {
    expect(parseCliArgs([
      'start',
      '--agent', 'codex', '--model', 'gpt', '--', 'export', 'the', 'results',
    ], ENV)).toMatchObject({ kind: 'start', prompt: 'export the results' });
  });
});

describe('handoff artifact arguments', () => {
  test('documents read-only semantics and estimated token headroom', () => {
    expect(CLI_HELP).toContain('handoff creates a read-only XML projection');
    expect(CLI_HELP).toContain('creates no chat, changes no agent or owner, starts no run');
    expect(CLI_HELP).toContain('artifact to 75% of this token capacity using');
    expect(CLI_HELP).toContain('token usage varies by model');
  });

  test('parses the default and arbitrary bounded context windows', () => {
    expect(parseCliArgs(['handoff', CHAT_ID], ENV)).toEqual({
      kind: 'handoff',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      contextWindowTokens: 500_000,
      force: false,
    });
    expect(parseCliArgs([
      '--workspace', 'review',
      'handoff', CHAT_ID,
      '--context-window-size', '131072',
      '--output', './handoff.xml',
      '--force',
    ], ENV)).toEqual({
      kind: 'handoff',
      workspace: 'review',
      configDir: '/home/test/.garcon',
      chatId: CHAT_ID,
      contextWindowTokens: 131_072,
      outputPath: './handoff.xml',
      force: true,
    });
    expect(parseCliArgs([
      'handoff', CHAT_ID, '--context-window-size', '1024',
    ], ENV)).toMatchObject({ contextWindowTokens: 1_024 });
    expect(parseCliArgs([
      'handoff', CHAT_ID, '--context-window-size', '10000000',
    ], ENV)).toMatchObject({ contextWindowTokens: 10_000_000 });
  });

  test.each([
    [['handoff'], 'exactly one chat ID'],
    [['handoff', 'bad'], 'valid Garcon chat ID'],
    [['handoff', CHAT_ID, '--context-window-size', '0'], 'between 1024 and 10000000'],
    [['handoff', CHAT_ID, '--context-window-size=-1'], 'base-10 integer'],
    [['handoff', CHAT_ID, '--context-window-size', '1023'], 'between 1024 and 10000000'],
    [['handoff', CHAT_ID, '--context-window-size', '10000001'], 'between 1024 and 10000000'],
    [['handoff', CHAT_ID, '--context-window-size', '1.5'], 'base-10 integer'],
    [['handoff', CHAT_ID, '--context-window-size', '1e5'], 'base-10 integer'],
    [['handoff', CHAT_ID, '--context-window-size', '200k'], 'base-10 integer'],
    [['handoff', CHAT_ID, '--context-window-size', '200000', '--context-window-size', '500000'], 'only once'],
    [['handoff', CHAT_ID, '--output', '-'], 'omit --output'],
    [['handoff', CHAT_ID, '--force'], '--force requires --output'],
    [['handoff', CHAT_ID, '--format', 'xml'], '--format cannot be used with handoff'],
    [['handoff', CHAT_ID, '--exclude', 'tools'], '--exclude cannot be used with handoff'],
    [['handoff', CHAT_ID, '--json'], '--json cannot be used with handoff'],
    [['export', CHAT_ID, '--context-window-size', '500000'], '--context-window-size cannot be used with export'],
    [['status', CHAT_ID, '--context-window-size', '500000'], '--context-window-size cannot be used with status'],
    [['list', 'agents', '--context-window-size', '500000'], '--context-window-size cannot be used with list'],
    [['resume-async', CHAT_ID, '--context-window-size', '500000', 'message'], '--context-window-size cannot be used with resume-async'],
    [['start', '--agent', 'codex', '--model', 'gpt', '--context-window-size', '500000', 'prompt'], '--context-window-size cannot be used with start'],
  ])('rejects invalid handoff arguments: %s', (args, message) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test('accepts an option-terminated handoff prompt after start', () => {
    expect(parseCliArgs([
      'start',
      '--agent', 'codex', '--model', 'gpt', '--', 'handoff', 'the', 'review',
    ], ENV)).toMatchObject({ kind: 'start', prompt: 'handoff the review' });
  });
});

describe('native session lookup arguments', () => {
  test('documents and parses the positional lookup with an optional exact agent ID', () => {
    expect(CLI_HELP).toContain(
      'Lookup the Garcon chat associated with a native agent session ID.',
    );
    expect(parseCliArgs(['lookup-native-session', 'session-123'], ENV)).toEqual({
      kind: 'lookup-native-session',
      workspace: 'default',
      configDir: '/home/test/.garcon',
      nativeSessionId: 'session-123',
    });
    expect(parseCliArgs([
      '--workspace', 'review',
      'lookup-native-session', 'ses_123',
      '--agent', 'codex',
    ], ENV)).toEqual({
      kind: 'lookup-native-session',
      workspace: 'review',
      configDir: '/home/test/.garcon',
      nativeSessionId: 'ses_123',
      agentId: 'codex',
    });
  });

  test('preserves native session IDs as ordinary argv data', () => {
    expect(parseCliArgs([
      'lookup-native-session', 'ses_$(touch should-not-run);$HOME',
    ], ENV)).toMatchObject({
      nativeSessionId: 'ses_$(touch should-not-run);$HOME',
    });
  });

  test.each([
    [['lookup-native-session'], 'requires one native session ID'],
    [['lookup-native-session', 'one', 'two'], 'accepts exactly one native session ID'],
    [['lookup-native-session', ''], 'native session ID is required'],
    [['lookup-native-session', 'x'.repeat(257)], 'native session ID must be at most 256 bytes'],
    [['lookup-native-session', 'session\nid'], 'native session ID must not contain control characters'],
    [['lookup-native-session', 'session-123', '--agent', 'Codex'], '--agent must be a valid agent ID'],
    [['lookup-native-session', 'session-123', '--agent', 'codex', '--agent', 'claude'], 'only once'],
    [['lookup-native-session', 'session-123', '--provider', 'provider'], '--provider cannot be used'],
    [['lookup-native-session', 'session-123', '--json'], '--json cannot be used'],
    [['lookup-native-session', 'session-123', '--unknown'], 'Unknown option'],
  ])('rejects invalid lookup arguments: %s', (args, message) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test('accepts an option-terminated lookup prompt after start', () => {
    expect(parseCliArgs([
      'start',
      '--agent', 'codex', '--model', 'gpt', '--',
      'lookup-native-session', 'session-123',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'lookup-native-session session-123',
    });
  });
});
