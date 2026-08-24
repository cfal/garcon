import { describe, expect, test } from 'bun:test';
import { CLI_HELP, parseCliArgs } from '../args.js';
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

  test('canonicalizes conversational message presentation independently of chat title', () => {
    expect(parseCliArgs([
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
      '--resume', CHAT_ID,
      '--message-style', 'error',
      '--collapsible',
      'prompt',
    ], ENV)).toMatchObject({
      kind: 'resume',
      userMessagePresentation: { origin: 'cli', style: 'error', disclosure: 'collapsed' },
    });
    expect(parseCliArgs(['send-async', CHAT_ID, '--collapsible', 'prompt'], ENV)).toMatchObject({
      kind: 'send-async',
      userMessagePresentation: { origin: 'cli', disclosure: 'collapsed' },
    });
  });

  test('normalizes custom presentation accents for new and resumed messages', () => {
    expect(parseCliArgs([
      '--agent', 'codex', '--model', 'gpt', '--color', '7C3AED', 'prompt',
    ], ENV)).toMatchObject({
      kind: 'start',
      userMessagePresentation: {
        origin: 'cli',
        style: 'custom',
        customStyle: { lightAccent: '#7c3aed', darkAccent: '#7c3aed' },
      },
    });
    expect(parseCliArgs([
      '--resume', CHAT_ID,
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

  test('documents presentation on conversational commands and its native-history boundary', () => {
    expect(CLI_HELP).toContain(
      'garcon-cli [options] [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <prompt>',
    );
    expect(CLI_HELP).toContain(
      '--resume <chat-id> [--message-title <title>] [--message-style <info|notice|error|custom>] [--collapsible] <prompt>',
    );
    expect(CLI_HELP).toContain('Native-history\nReload');
    expect(CLI_HELP).toContain('provider-native fork segments may drop');
    expect(CLI_HELP).toContain('--color selects custom styling');
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

  test('treats -- wait as a new-chat prompt', () => {
    expect(parseCliArgs([
      '--agent', 'codex',
      '--model', 'gpt',
      '--', 'wait', 'for', 'the', 'review',
    ], ENV)).toMatchObject({
      kind: 'start',
      prompt: 'wait for the review',
    });
  });

  test('treats -- status as a new-chat prompt', () => {
    expect(parseCliArgs([
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
    { args: ['status', CHAT_ID, '--resume', CHAT_ID], message: '--resume cannot be used with status' },
    { args: ['status', CHAT_ID, '--allow-steer'], message: '--allow-steer cannot be used with status' },
    { args: ['status', CHAT_ID, '--collapsible'], message: '--collapsible cannot be used with status' },
    { args: ['wait', CHAT_ID, '--turn', 'turn-1', '--messages', '1'], message: '--messages cannot be used with wait' },
    { args: ['list', 'agents', '--messages', '1'], message: '--messages cannot be used with list' },
    { args: ['stop', CHAT_ID, '--messages', '1'], message: '--messages cannot be used with stop' },
    { args: ['send-async', CHAT_ID, '--messages', '1', 'message'], message: '--messages cannot be used with send-async' },
    { args: ['--agent', 'codex', '--model', 'gpt', '--messages', '1', 'prompt'], message: '--messages can only be used with status' },
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
    { args: ['send-async', CHAT_ID, '--turn', 'turn-1', 'message'], message: '--turn cannot be used with send-async' },
    { args: ['--agent', 'codex', '--model', 'gpt', '--turn', 'turn-1', 'prompt'], message: '--turn can only be used with wait' },
  ])('rejects invalid wait arguments: $message', ({ args, message }) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
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

  test('parses send-async message presentation', () => {
    expect(parseCliArgs([
      'send-async', CHAT_ID,
      '--message-title', 'Blocker',
      '--message-style', 'info',
      'Do not deploy',
    ], ENV)).toMatchObject({
      kind: 'send-async',
      message: 'Do not deploy',
      userMessagePresentation: { origin: 'cli', style: 'info', title: 'Blocker' },
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
    { args: ['send-async', CHAT_ID, '--message-style', 'INFO', 'message'], message: 'must be one of: info, notice, error, custom' },
    { args: ['send-async', CHAT_ID, '--message-style', 'custom', 'message'], message: 'requires --color' },
    { args: ['send-async', CHAT_ID, '--message-style', 'error', '--color', '7c3aed', 'message'], message: 'preset --message-style' },
    { args: ['send-async', CHAT_ID, '--color', 'red', 'message'], message: 'six-digit hex colors' },
    { args: ['send-async', CHAT_ID, '--markdown', 'message'], message: '--markdown cannot be used with send-async' },
    { args: ['stop', CHAT_ID, '--message-title', 'Heading'], message: 'message presentation cannot be used with stop' },
    { args: ['stop', CHAT_ID, '--collapsible'], message: 'message presentation cannot be used with stop' },
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
    [['send-async', CHAT_ID, '--type', 'notice', 'content'], '--type cannot be used with send-async'],
    [['stop', CHAT_ID, '--type', 'notice'], '--type cannot be used with stop'],
    [['status', CHAT_ID, '--type', 'notice'], '--type cannot be used with status'],
    [['list', 'agents', '--type', 'notice'], '--type cannot be used with list'],
    [['--agent', 'codex', '--model', 'gpt', '--type', 'notice', 'prompt'], '--type can only be used with add-row'],
  ])('rejects invalid add-row arguments: %s', (args, message) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test('treats an option-terminated add-row token as a new-chat prompt', () => {
    expect(parseCliArgs([
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
    [['send-async', CHAT_ID, '--force', 'message'], '--force cannot be used with send-async'],
    [['--agent', 'codex', '--model', 'gpt', '--format', 'xml', 'prompt'], '--format can only be used with export'],
  ])('rejects invalid export arguments: %s', (args, message) => {
    expect(() => parseCliArgs(args, ENV)).toThrow(message);
  });

  test('treats an option-terminated export token as a new-chat prompt', () => {
    expect(parseCliArgs([
      '--agent', 'codex', '--model', 'gpt', '--', 'export', 'the', 'results',
    ], ENV)).toMatchObject({ kind: 'start', prompt: 'export the results' });
  });
});
