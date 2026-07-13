import { describe, expect, it } from 'bun:test';
import {
  TERMINAL_AUTH_EXPIRED_CLOSE_CODE,
  TERMINAL_AUTH_EXPIRED_REASON,
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
    closes: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
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
    attach(receivedPrincipal, peer, message) {
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
});
