import { describe, expect, test } from 'bun:test';
import type { AddRowCliCommand } from '../args.js';
import type { AddChatRowRequest } from '@garcon/common/chat-row-contracts';
import { runAddRow } from '../chat-row.js';
import type { CliOutput } from '../output.js';

const command: AddRowCliCommand = {
  kind: 'add-row',
  workspace: 'default',
  configDir: '/tmp/config',
  chatId: '1787000000000000',
  type: 'error',
  content: '  durable error\n',
  readsContentFromStdin: false,
};

describe('runAddRow', () => {
  test('acquires the target before posting one exact request and prints no content', async () => {
    const calls: string[] = [];
    let submitted: unknown;
    const results: string[] = [];
    const client = {
      async getChatRowTarget(chatId: string) {
        calls.push(`target:${chatId}`);
        return { success: true as const, chatId, transcriptViewId: 'view-1' };
      },
      async addChatRow(request: AddChatRowRequest) {
        calls.push('add');
        submitted = request;
        return {
          success: true as const,
          commandType: 'chat-row-add' as const,
          ...request,
          ordinal: 9,
          status: 'appended' as const,
          timestamp: '2026-08-18T00:00:00.000Z',
        };
      },
    };
    const ids = ['request-1', 'message-1'];

    await runAddRow(
      command,
      command.content!,
      client,
      output(results),
      undefined,
      () => ids.shift()!,
    );

    expect(calls).toEqual([`target:${command.chatId}`, 'add']);
    expect(submitted).toEqual({
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      chatId: command.chatId,
      transcriptViewId: 'view-1',
      type: 'error',
      content: command.content,
    });
    expect(results).toEqual([
      [
        `chat id: ${command.chatId}`,
        'transcript view id: view-1',
        'ordinal: 9',
        'type: error',
        'status: appended',
      ].join('\n'),
    ]);
    expect(results[0]).not.toContain(command.content!);
  });

  test('validates content before making the first client call', async () => {
    let called = false;
    const client = {
      async getChatRowTarget() {
        called = true;
        throw new Error('must not be called');
      },
      async addChatRow() {
        called = true;
        throw new Error('must not be called');
      },
    };

    await expect(runAddRow(command, ' \n ', client, output([]))).rejects.toMatchObject({
      phase: 'arguments',
      exitCode: 2,
    });
    expect(called).toBe(false);
  });
});

function output(results: string[]): CliOutput {
  return {
    accepted() {},
    completed() {},
    result(value) { results.push(value); },
    sent() {},
    stopped() {},
    diagnostic() {},
  };
}
