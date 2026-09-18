import { describe, expect, test } from 'bun:test';
import { emptyChatExecutionControlState } from '@garcon/common/chat-execution-control';
import type {
  AgentStopResponse,
  AgentTurnCommandResponse,
  StartChatCommandResponse,
} from '@garcon/common/chat-command-contracts';
import {
  resumeAsyncJsonEnvelope,
  resumeJsonEnvelope,
  startAsyncJsonEnvelope,
  startJsonEnvelope,
  stopJsonEnvelope,
} from '../automation-output.js';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';

const CHAT_ID = '1785337200123456';
const PARENT_ID = '1785337200123455';
const context = { workspace: 'default', serverInstanceId: 'instance-1' };
const receipt = {
  success: true as const,
  clientRequestId: 'request-1',
  chatId: CHAT_ID,
  turnId: 'turn-1',
  status: 'accepted' as const,
  acceptedAt: '2026-09-08T00:00:00.000Z',
  parentChat: { chatId: PARENT_ID, relation: 'delegation' as const },
};
const terminalReceipt: AgentTurnReceipt = {
  state: 'completed',
  chatId: CHAT_ID,
  turnId: 'turn-1',
  clientRequestId: 'request-1',
  acceptedAt: receipt.acceptedAt,
  updatedAt: receipt.acceptedAt,
  settledAt: receipt.acceptedAt,
  output: { availability: 'available', completeness: 'complete', text: 'Done' },
};

describe('automation JSON output', () => {
  test('projects a stable start-async envelope including accepted work and title failure', () => {
    const accepted: StartChatCommandResponse = {
      ...receipt,
      commandType: 'chat-start',
      chat: null,
    };
    expect(startAsyncJsonEnvelope(context, {
      accepted,
      titleUpdate: { status: 'failed', error: new Error('title unavailable') },
    })).toEqual({
      schemaVersion: 1,
      command: 'start-async',
      workspace: 'default',
      serverInstanceId: 'instance-1',
      receipt: {
        commandType: 'chat-start',
        clientRequestId: 'request-1',
        chatId: CHAT_ID,
        turnId: 'turn-1',
        status: 'accepted',
        acceptedAt: '2026-09-08T00:00:00.000Z',
      },
      parentChat: { chatId: PARENT_ID, relation: 'delegation' },
      titleUpdate: {
        status: 'failed',
        error: { phase: 'submission', errorCode: null, message: 'title unavailable' },
      },
    });
  });

  test('keeps resume delivery and stop control state distinct from receipt status', () => {
    const resumed: AgentTurnCommandResponse = { ...receipt, commandType: 'agent-run' };
    expect(resumeAsyncJsonEnvelope(context, {
      delivery: 'new-turn',
      response: resumed,
    })).toMatchObject({
      schemaVersion: 1,
      command: 'resume-async',
      receipt: { chatId: CHAT_ID, turnId: 'turn-1', status: 'accepted' },
      parentChat: { chatId: PARENT_ID, relation: 'delegation' },
      delivery: 'new-turn',
    });

    const stopped: AgentStopResponse = {
      ...receipt,
      commandType: 'agent-stop',
      outcome: 'interrupt-requested',
      control: emptyChatExecutionControlState('instance-1'),
    };
    expect(stopJsonEnvelope(context, { response: stopped })).toMatchObject({
      schemaVersion: 1,
      command: 'stop',
      receipt: {
        commandType: 'agent-stop',
        chatId: CHAT_ID,
        status: 'accepted',
      },
      outcome: 'interrupt-requested',
      control: { serverInstanceId: 'instance-1', version: 0 },
    });
    expect(stopJsonEnvelope(context, { response: stopped }).receipt).not.toHaveProperty('turnId');
  });

  test('extends the matching async lifecycle envelope for synchronous settlement', () => {
    const started: StartChatCommandResponse = {
      ...receipt,
      commandType: 'chat-start',
      chat: null,
    };
    const startTitleUpdate = { status: 'not-requested' as const };
    const asyncStart = startAsyncJsonEnvelope(context, {
      accepted: started,
      titleUpdate: startTitleUpdate,
    });
    const synchronousStart = startJsonEnvelope(context, {
      accepted: started,
      titleUpdate: startTitleUpdate,
      turnReceipt: terminalReceipt,
    });
    expect(synchronousStart).toEqual({
      ...asyncStart,
      command: 'start',
      turnReceipt: terminalReceipt,
    });

    const resumed: AgentTurnCommandResponse = { ...receipt, commandType: 'agent-run' };
    const asyncResume = resumeAsyncJsonEnvelope(context, {
      delivery: 'new-turn',
      response: resumed,
    });
    const synchronousResume = resumeJsonEnvelope(context, {
      accepted: resumed,
      titleUpdate: { status: 'not-requested' },
      turnReceipt: terminalReceipt,
    });
    expect(synchronousResume).toEqual({
      ...asyncResume,
      command: 'resume',
      titleUpdate: { status: 'not-requested' },
      turnReceipt: terminalReceipt,
    });
  });
});
