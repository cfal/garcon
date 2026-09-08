import { describe, expect, test } from 'bun:test';
import type { PermissionDecisionCommandRequest } from '@garcon/common/chat-command-contracts';
import type { PermissionAnswerCliCommand, PermissionDecisionCliCommand } from '../args.js';
import {
  permissionDecisionClientRequestId,
  runPermissionAnswer,
  runPermissionDecision,
} from '../chat-permission.js';
import type { CliOutput } from '../output.js';

const command: PermissionDecisionCliCommand = {
  kind: 'permission-decision',
  workspace: 'default',
  configDir: '/config',
  chatId: '1785337200123456',
  permissionOccurrenceId: 'permission-1',
  runId: 'run-1',
  serverInstanceId: 'instance-1',
  allow: true,
  json: false,
};

const answerCommand: PermissionAnswerCliCommand = {
  ...command,
  kind: 'permission-answer',
  response: {
    type: 'ask-user-question-response',
    outcome: 'answered',
    answers: [{ questionId: 'question-1', selectedOptionIds: ['option-1'] }],
  },
};

function captureOutput(): CliOutput & { readonly results: string[] } {
  const results: string[] = [];
  return {
    results,
    accepted() {},
    completed() {},
    diagnostic() {},
    result(value) { results.push(value); },
    sent() {},
    stopped() {},
  };
}

describe('permission decision', () => {
  test('binds a deterministic retry identity to the exact permission occurrence', () => {
    const first = permissionDecisionClientRequestId(command);
    expect(first).toMatch(/^permission-v1:[a-f0-9]{64}$/u);
    expect(permissionDecisionClientRequestId({ ...command, allow: false })).toBe(first);
    expect(permissionDecisionClientRequestId({
      ...command,
      permissionOccurrenceId: 'permission-2',
    })).not.toBe(first);
    expect(permissionDecisionClientRequestId({ ...command, runId: 'run-2' })).not.toBe(first);
    expect(permissionDecisionClientRequestId({
      ...command,
      serverInstanceId: 'instance-2',
    })).not.toBe(first);
  });

  test('submits only the explicit fence and emits one stable JSON receipt', async () => {
    let request: PermissionDecisionCommandRequest | undefined;
    const output = captureOutput();
    await runPermissionDecision({ ...command, json: true }, {
      async decidePermission(value) {
        request = value;
        return {
          success: true,
          commandType: 'permission-decision',
          clientRequestId: value.clientRequestId,
          chatId: value.chatId,
          status: 'accepted',
          acceptedAt: '2026-09-08T00:00:00.000Z',
        };
      },
    }, output);

    expect(request).toEqual({
      clientRequestId: permissionDecisionClientRequestId(command),
      chatId: command.chatId,
      permissionOccurrenceId: 'permission-1',
      allow: true,
      alwaysAllow: false,
      control: {
        serverInstanceId: 'instance-1',
        chatId: command.chatId,
        runId: 'run-1',
        permissionOccurrenceId: 'permission-1',
      },
    });
    expect(output.results).toHaveLength(1);
    expect(JSON.parse(output.results[0]!)).toMatchObject({
      commandType: 'permission-decision',
      chatId: command.chatId,
      status: 'accepted',
    });
  });

  test('submits structured answers through the same occurrence-bound identity', async () => {
    let request: PermissionDecisionCommandRequest | undefined;
    const output = captureOutput();
    await runPermissionAnswer(answerCommand, {
      async decidePermission(value) {
        request = value;
        return {
          success: true,
          commandType: 'permission-decision',
          clientRequestId: value.clientRequestId,
          chatId: value.chatId,
          status: 'duplicate',
          acceptedAt: '2026-09-08T00:00:00.000Z',
        };
      },
    }, output);

    expect(request).toEqual({
      clientRequestId: permissionDecisionClientRequestId(answerCommand),
      chatId: answerCommand.chatId,
      permissionOccurrenceId: 'permission-1',
      allow: true,
      alwaysAllow: false,
      response: answerCommand.response,
      control: {
        serverInstanceId: 'instance-1',
        chatId: answerCommand.chatId,
        runId: 'run-1',
        permissionOccurrenceId: 'permission-1',
      },
    });
    expect(output.results).toEqual([
      [
        `chat id: ${answerCommand.chatId}`,
        'permission occurrence: permission-1',
        'answers: 1',
        'status: duplicate',
      ].join('\n'),
    ]);
  });
});
