import { expect, mock, test } from 'bun:test';
import type { SlashCommand } from '../../../../common/slash-commands.js';
import { captureNodeProviderCommandsReply, MAX_NODE_COMMANDS, MAX_NODE_COMMANDS_BYTES, parseNodeProviderCommandsCommand,
  parseNodeProviderCommandsReply } from '../provider-commands-wire.js';

const command = { method: 'provider-commands', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' } as const;
const reply = { kind: 'provider-commands', instanceId: command.instanceId, workspaceId: command.workspaceId,
  commands: [{ name: 'review', source: 'command' }, { name: 'synthetic-skill', source: 'skill', description: 'Synthetic description' }] } as const;

test('command discovery exchanges grant identities and copies the complete shared command DTO', () => {
  expect(parseNodeProviderCommandsCommand(command)).toEqual(command);
  const parsed = parseNodeProviderCommandsReply(reply);
  expect(parsed).toEqual(reply); expect(parsed).not.toBe(reply);
  if (parsed?.kind !== 'provider-commands') throw new Error('Synthetic commands were rejected');
  expect(parsed.commands).not.toBe(reply.commands); expect(parsed.commands[0]).not.toBe(reply.commands[0]);
  expect(parseNodeProviderCommandsReply({ ...reply, commands: [] })).toEqual({ ...reply, commands: [] });
  expect(parseNodeProviderCommandsReply({ kind: 'provider-commands-unavailable', instanceId: command.instanceId,
    workspaceId: command.workspaceId, reason: 'permission-denied' })).toMatchObject({ reason: 'permission-denied' });
});

test('request parsing rejects paths, foreign fields, missing grants, and malformed identities', () => {
  for (const value of [{ ...command, projectPath: '/synthetic/ungranted' }, { ...command, nodeId: 'foreign' },
    { method: command.method, instanceId: command.instanceId }, { ...command, workspaceId: '' }, { ...command, instanceId: 1 }]) {
    expect(parseNodeProviderCommandsCommand(value)).toBeNull();
  }
});

test('wire commands reject unknown fields, invalid sources, and oversized strings, lists and bytes', () => {
  for (const commands of [[{ name: '', source: 'command' }], [{ name: 'review', source: 'shell' }],
    [{ name: 'review', source: 'skill', path: '/synthetic/private' }], [{ name: 'review', source: 'skill', description: undefined }],
    [{ name: 'r'.repeat(257), source: 'command' }], [{ name: 'review', source: 'command', description: 'd'.repeat(8193) }],
    Array.from({ length: MAX_NODE_COMMANDS + 1 }, () => reply.commands[0]),
    Array.from({ length: 100 }, () => ({ name: 'review', source: 'skill', description: 'd'.repeat(8192) }))]) {
    expect(parseNodeProviderCommandsReply({ ...reply, commands })).toBeNull();
  }
  expect(Buffer.byteLength(JSON.stringify({ ...reply, commands: Array.from({ length: 100 }, () => ({ name: 'r', source: 'skill', description: 'd'.repeat(8192) })) })))
    .toBeGreaterThan(MAX_NODE_COMMANDS_BYTES);
  expect(parseNodeProviderCommandsReply({ ...reply, private: true })).toBeNull();
  expect(parseNodeProviderCommandsReply({ kind: 'provider-commands-unavailable', instanceId: command.instanceId, workspaceId: command.workspaceId, reason: 'private-error' })).toBeNull();
});

test('local capture omits undefined description without dropping valid descriptions', () => {
  const commands: SlashCommand[] = [{ name: 'review', source: 'command', description: undefined },
    { name: 'synthetic-skill', source: 'skill', description: 'Synthetic description' }];
  expect(captureNodeProviderCommandsReply(command.instanceId, command.workspaceId, commands)).toEqual(reply);
  expect(Object.hasOwn(commands[0]!, 'description')).toBe(true);
});

test('capture bounds display text without losing the workspace command identities', () => {
  const commands: SlashCommand[] = Array.from({ length: 120 }, (_, index) => ({
    name: `synthetic-skill-${index}`, source: 'skill', description: 'Synthetic description '.repeat(100),
  }));
  commands[0] = { ...commands[0]!, description: 'd'.repeat(8193) };
  const captured = captureNodeProviderCommandsReply(command.instanceId, command.workspaceId, commands);
  if (captured?.kind !== 'provider-commands') throw new Error('Synthetic capture failed');
  expect(captured.commands.map((entry) => entry.name)).toEqual(commands.map((entry) => entry.name));
  expect(captured.commands[0]!.description).toHaveLength(8192);
  expect(captured.commands.some((entry) => entry.description === undefined)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(captured))).toBeLessThanOrEqual(MAX_NODE_COMMANDS_BYTES);
  expect(parseNodeProviderCommandsReply(captured)).toEqual(captured);
  expect(commands[0]!.description).toHaveLength(8193);
});

test('capture skips unrepresentable identities and caps the emitted list without renaming commands', () => {
  const commands: SlashCommand[] = [{ name: 'x'.repeat(257), source: 'skill' },
    ...Array.from({ length: MAX_NODE_COMMANDS + 1 }, (_, index) => ({ name: `synthetic-${index}`, source: 'skill' as const }))];
  const captured = captureNodeProviderCommandsReply(command.instanceId, command.workspaceId, commands);
  if (captured?.kind !== 'provider-commands') throw new Error('Synthetic capture failed');
  expect(captured.commands).toEqual(commands.slice(1, MAX_NODE_COMMANDS + 1));
  expect(parseNodeProviderCommandsReply(captured)).toEqual(captured);
  const escaped = Array.from({ length: MAX_NODE_COMMANDS }, (_, index) => ({
    name: `synthetic-${index}-${'é'.repeat(110)}`, source: 'skill' as const, description: '\n'.repeat(8192),
  }));
  const bounded = captureNodeProviderCommandsReply(command.instanceId, command.workspaceId, escaped);
  expect(bounded).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_NODE_COMMANDS_BYTES);
  expect(parseNodeProviderCommandsReply(bounded)).toEqual(bounded);
});

test('description truncation preserves complete Unicode characters at the length boundary', () => {
  const commands: SlashCommand[] = [
    { name: 'split-pair', source: 'skill', description: 'd'.repeat(8191) + '\u{1F680}' },
    { name: 'whole-pair', source: 'skill', description: 'd'.repeat(8190) + '\u{1F680}' },
    { name: 'untruncated', source: 'skill', description: 'existing\uD800' },
  ];
  const captured = captureNodeProviderCommandsReply(command.instanceId, command.workspaceId, commands);
  if (captured?.kind !== 'provider-commands') throw new Error('Synthetic Unicode capture failed');
  expect(captured.commands[0]!.description).toBe('d'.repeat(8191));
  expect(captured.commands[1]!.description).toBe(commands[1]!.description);
  expect(captured.commands[2]!.description).toBe(commands[2]!.description);
  expect(parseNodeProviderCommandsReply(captured)).toEqual(captured);
});

test('accessors and proxies are rejected without invoking executable behavior', () => {
  const getter = mock(() => 'review');
  const entry = Object.defineProperty({ source: 'skill' }, 'name', { enumerable: true, get: getter });
  const trap = mock(() => { throw new Error('Synthetic proxy must not execute'); });
  const proxy = new Proxy({ ...reply }, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  expect(parseNodeProviderCommandsReply({ ...reply, commands: [entry] })).toBeNull();
  expect(parseNodeProviderCommandsReply(proxy)).toBeNull();
  expect(parseNodeProviderCommandsCommand(new Proxy(command, { get: trap }))).toBeNull();
  const commands: SlashCommand[] = [{ name: 'review', source: 'skill' }];
  Object.defineProperty(commands[0], 'name', { get: getter });
  expect(captureNodeProviderCommandsReply(command.instanceId, command.workspaceId, commands)).toBeNull();
  expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
});
