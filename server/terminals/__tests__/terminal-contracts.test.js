import { describe, expect, it } from 'bun:test';
import {
  parseTerminalCreateRequest,
  parseTerminalCreateResponse,
  parseTerminalListResponse,
  parseTerminalStreamClientMessage,
  parseTerminalStreamServerMessage,
  parseTerminalTerminateRequest,
  parseTerminalTerminateResponse,
} from '../../../common/terminal.ts';

const metadata = {
  terminalId: 'terminal-1',
  displaySequence: 1,
  initialWorkingDirectory: '/workspace',
  processStatus: 'running',
  attachmentStatus: 'detached',
  createdAt: '2026-07-13T00:00:00.000Z',
  exitCode: null,
  latestOutputSequence: 2,
};

describe('terminal contracts', () => {
  it('parses control requests and responses', () => {
    expect(
      parseTerminalCreateRequest({
        requestId: 'create-1',
        requestedInitialWorkingDirectory: '/workspace',
      }),
    ).toEqual({
      requestId: 'create-1',
      requestedInitialWorkingDirectory: '/workspace',
    });
    expect(
      parseTerminalTerminateRequest({
        terminalId: 'terminal-1',
        requestId: 'delete-1',
      }),
    ).toEqual({ terminalId: 'terminal-1', requestId: 'delete-1' });
    expect(
      parseTerminalListResponse({ success: true, terminals: [metadata] }),
    ).toEqual({ success: true, terminals: [metadata] });
    expect(
      parseTerminalCreateResponse({ success: true, terminal: metadata }),
    ).toEqual({ success: true, terminal: metadata });
    expect(
      parseTerminalTerminateResponse({
        success: true,
        terminalId: 'terminal-1',
        terminal: metadata,
      }),
    ).toEqual({ success: true, terminalId: 'terminal-1', terminal: metadata });
  });

  it('round-trips every client stream message', () => {
    const messages = [
      {
        type: 'terminal-attach',
        terminalId: 'terminal-1',
        clientId: 'client-1',
        afterSequence: 0,
        intent: 'restore',
      },
      { type: 'terminal-input', terminalId: 'terminal-1', data: 'pwd\n' },
      {
        type: 'terminal-resize',
        terminalId: 'terminal-1',
        cols: 120,
        rows: 40,
      },
    ];
    for (const message of messages) {
      expect(
        parseTerminalStreamClientMessage(JSON.parse(JSON.stringify(message))),
      ).toEqual(message);
    }
  });

  it('round-trips every server stream message', () => {
    const messages = [
      {
        type: 'terminal-attached',
        terminal: metadata,
        replay: [{ sequence: 2, data: 'ok' }],
      },
      {
        type: 'terminal-output',
        terminalId: 'terminal-1',
        sequence: 3,
        data: 'next',
      },
      { type: 'terminal-status', terminal: metadata },
      {
        type: 'terminal-taken-over',
        terminalId: 'terminal-1',
        replacementClientId: 'client-2',
      },
      {
        type: 'terminal-replay-truncated',
        terminalId: 'terminal-1',
        firstSequence: 2,
      },
      {
        type: 'terminal-error',
        terminalId: 'terminal-1',
        code: 'terminal-not-attached',
        message: 'Not attached',
      },
    ];
    for (const message of messages) {
      expect(
        parseTerminalStreamServerMessage(JSON.parse(JSON.stringify(message))),
      ).toEqual(message);
    }
  });

  it('rejects malformed and oversized messages', () => {
    expect(
      parseTerminalCreateRequest({
        requestId: '',
        requestedInitialWorkingDirectory: null,
      }),
    ).toBeNull();
    expect(
      parseTerminalTerminateRequest({ terminalId: 'terminal-1' }),
    ).toBeNull();
    expect(
      parseTerminalCreateRequest({
        requestId: 'x'.repeat(257),
        requestedInitialWorkingDirectory: null,
      }),
    ).toBeNull();
    expect(
      parseTerminalTerminateRequest({
        terminalId: 'terminal-1',
        requestId: 'x'.repeat(257),
      }),
    ).toBeNull();
    expect(
      parseTerminalStreamClientMessage({
        type: 'terminal-attach',
        terminalId: 'terminal-1',
        clientId: 'client-1',
        afterSequence: -1,
        intent: 'restore',
      }),
    ).toBeNull();
    expect(
      parseTerminalStreamClientMessage({
        type: 'terminal-resize',
        terminalId: 'terminal-1',
        cols: 0,
        rows: 24,
      }),
    ).toBeNull();
    expect(
      parseTerminalStreamClientMessage({
        type: 'terminal-input',
        terminalId: 'terminal-1',
        data: 'x'.repeat(64 * 1024 + 1),
      }),
    ).toBeNull();
    expect(
      parseTerminalStreamServerMessage({
        type: 'terminal-error',
        code: 'unknown-code',
        message: 'No',
      }),
    ).toBeNull();
  });
});
