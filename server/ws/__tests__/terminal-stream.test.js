import { describe, expect, it } from 'bun:test';
import {
  TERMINAL_AUTH_EXPIRED_CLOSE_CODE,
  TERMINAL_AUTH_EXPIRED_REASON,
  TERMINAL_STREAM_BACKPRESSURE_CLOSE_CODE,
  TERMINAL_STREAM_BACKPRESSURE_CLOSE_REASON,
  TERMINAL_STREAM_MAX_PENDING_MESSAGES_PER_SESSION,
  TERMINAL_STREAM_TARGET_MESSAGE_BYTES,
  TerminalStreamHandler,
} from '../terminal-stream.ts';

function principal(expiresAtMs = null) {
  return expiresAtMs === null
    ? { mode: 'local', key: 'local', username: 'local', expiresAtMs: null }
    : {
        mode: 'authenticated',
        key: 'alice',
        username: 'alice',
        expiresAtMs,
      };
}

function socket(expiresAtMs = null) {
  return {
    data: {
      pathname: '/shell',
      connectionId: 'socket-1',
      principal: principal(expiresAtMs),
      expiresAtMs,
    },
    readyState: 1,
    sent: [],
    sentByteLengths: [],
    sendResults: [],
    closes: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
      this.sentByteLengths.push(Buffer.byteLength(payload, 'utf8'));
      return this.sendResults.shift() ?? Buffer.byteLength(payload, 'utf8');
    },
    close(code, reason) {
      this.closes.push({ code, reason });
      this.readyState = 3;
    },
  };
}

function manager() {
  return {
    calls: [],
    peer: null,
    attach(receivedPrincipal, peer, message) {
      this.peer = peer;
      this.calls.push([
        'attach',
        receivedPrincipal,
        peer.connectionId,
        message,
      ]);
    },
    input(receivedPrincipal, peer, terminalId, data) {
      this.calls.push([
        'input',
        receivedPrincipal,
        peer.connectionId,
        terminalId,
        data,
      ]);
    },
    resize(receivedPrincipal, peer, terminalId, cols, rows) {
      this.calls.push([
        'resize',
        receivedPrincipal,
        peer.connectionId,
        terminalId,
        cols,
        rows,
      ]);
    },
    detachPeer(receivedPrincipal, peer) {
      this.calls.push(['detach', receivedPrincipal, peer.connectionId]);
    },
  };
}

describe('TerminalStreamHandler', () => {
  it('validates and dispatches multiplexed messages using trusted socket identity', async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);

    await handler.message(ws, { type: 'unknown' });
    await handler.message(ws, {
      type: 'terminal-attach',
      terminalId: 'terminal-1',
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });
    await handler.message(ws, {
      type: 'terminal-input',
      terminalId: 'terminal-1',
      data: 'pwd\n',
    });
    await handler.message(ws, {
      type: 'terminal-resize',
      terminalId: 'terminal-1',
      cols: 100,
      rows: 30,
    });

    expect(ws.sent[0]).toEqual({
      type: 'terminal-error',
      code: 'terminal-validation',
      message: 'Invalid terminal stream message.',
    });
    expect(terminals.calls.map((call) => call[0])).toEqual([
      'attach',
      'input',
      'resize',
    ]);
    expect(terminals.calls[0][1]).toBe(ws.data.principal);
  });

  it('detaches every owned terminal without terminating on socket close', () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);
    handler.close(ws);
    handler.close(ws);

    expect(terminals.calls).toEqual([
      ['detach', ws.data.principal, 'socket-1'],
    ]);
  });

  it('rejects an already expired authenticated stream before dispatch', async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals, () => 1_000);
    const ws = socket(999);
    handler.open(ws);
    await handler.message(ws, {
      type: 'terminal-input',
      terminalId: 'terminal-1',
      data: 'ignored',
    });

    expect(ws.closes).toEqual([
      {
        code: TERMINAL_AUTH_EXPIRED_CLOSE_CODE,
        reason: TERMINAL_AUTH_EXPIRED_REASON,
      },
    ]);
    expect(terminals.calls.map((call) => call[0])).toEqual(['detach']);
  });

  it('flushes pending terminal output fairly when Bun signals drain', async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);
    await handler.message(ws, {
      type: 'terminal-attach',
      terminalId: 'terminal-1',
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });
    ws.sendResults.push(-1);

    terminals.peer.sendTerminalMessage({
      type: 'terminal-output',
      terminalId: 'terminal-1',
      sequence: 1,
      data: 'one',
    });
    terminals.peer.sendTerminalMessage({
      type: 'terminal-output',
      terminalId: 'terminal-1',
      sequence: 2,
      data: 'two',
    });
    terminals.peer.sendTerminalMessage({
      type: 'terminal-output',
      terminalId: 'terminal-1',
      sequence: 3,
      data: 'three',
    });
    terminals.peer.sendTerminalMessage({
      type: 'terminal-output',
      terminalId: 'terminal-2',
      sequence: 1,
      data: 'other',
    });

    handler.drain(ws);

    expect(
      ws.sent.map(({ terminalId, sequence }) => [terminalId, sequence]),
    ).toEqual([
      ['terminal-1', 1],
      ['terminal-1', 2],
      ['terminal-2', 1],
      ['terminal-1', 3],
    ]);
    expect(ws.closes).toEqual([]);
  });

  it('bounds a noisy terminal queue and detaches for replay on reconnect', async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);
    await handler.message(ws, {
      type: 'terminal-attach',
      terminalId: 'terminal-1',
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });
    ws.sendResults.push(-1);
    terminals.peer.sendTerminalMessage({
      type: 'terminal-output',
      terminalId: 'terminal-1',
      sequence: 1,
      data: 'blocked',
    });

    for (
      let sequence = 2;
      sequence <= TERMINAL_STREAM_MAX_PENDING_MESSAGES_PER_SESSION + 2;
      sequence += 1
    ) {
      terminals.peer.sendTerminalMessage({
        type: 'terminal-output',
        terminalId: 'terminal-1',
        sequence,
        data: 'pending',
      });
    }

    expect(ws.closes).toEqual([
      {
        code: TERMINAL_STREAM_BACKPRESSURE_CLOSE_CODE,
        reason: TERMINAL_STREAM_BACKPRESSURE_CLOSE_REASON,
      },
    ]);
    expect(terminals.calls.at(-1)).toEqual([
      'detach',
      ws.data.principal,
      'socket-1',
    ]);
  });

  it('fragments a large replay while backpressured without closing the multiplexed socket', async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);
    await handler.message(ws, {
      type: 'terminal-attach',
      terminalId: 'terminal-1',
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });
    ws.sendResults.push(-1);
    terminals.peer.sendTerminalMessage({
      type: 'terminal-output',
      terminalId: 'terminal-1',
      sequence: 1,
      data: 'blocked',
    });
    terminals.peer.sendTerminalMessage({
      type: 'terminal-attached',
      terminal: {
        terminalId: 'terminal-2',
        displaySequence: 2,
        initialWorkingDirectory: '/workspace',
        processStatus: 'running',
        attachmentStatus: 'attached',
        createdAt: '2026-07-13T00:00:00.000Z',
        exitCode: null,
        latestOutputSequence: 1,
      },
      replay: [{ sequence: 1, data: '\0'.repeat(200_000) }],
    });

    handler.drain(ws);

    expect(ws.closes).toEqual([]);
    expect(
      ws.sent.some((message) => message.type === 'terminal-output-fragment'),
    ).toBe(true);
    expect(Math.max(...ws.sentByteLengths)).toBeLessThanOrEqual(
      TERMINAL_STREAM_TARGET_MESSAGE_BYTES,
    );
  });
});
