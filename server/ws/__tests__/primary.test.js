import { describe, expect, it, mock } from 'bun:test';
import { ChatHandler } from '../chat.ts';
import { PrimaryWsHandler } from '../primary.ts';
import { TerminalStreamHandler } from '../terminal-stream.ts';

function createFixture() {
  const calls = [];
  const chatHandler = {
    open: mock(() => calls.push('chat-open')),
    message: mock(async () => calls.push('chat-message')),
    close: mock((_socket, code, reason) => calls.push(`chat-close:${code}:${reason}`)),
  };
  const terminalHandler = {
    open: mock(() => calls.push('terminal-open')),
    message: mock(async () => calls.push('terminal-message')),
    drain: mock(() => calls.push('terminal-drain')),
    close: mock(() => calls.push('terminal-close')),
  };
  const primary = new PrimaryWsHandler(
    { createHandler: () => chatHandler },
    { createHandler: () => terminalHandler },
  );
  return {
    calls,
    chatHandler,
    terminalHandler,
    primary,
    socket: {},
  };
}

describe('PrimaryWsHandler', () => {
  it('opens chat before terminal and drains terminal output', () => {
    const { calls, primary, socket } = createFixture();

    primary.open(socket);
    primary.drain(socket);

    expect(calls).toEqual(['chat-open', 'terminal-open', 'terminal-drain']);
  });

  for (const type of ['terminal-attach', 'terminal-input', 'terminal-resize']) {
    it(`routes ${type} only to the terminal handler`, async () => {
      const { chatHandler, primary, socket, terminalHandler } = createFixture();

      await primary.message(socket, { type });

      expect(terminalHandler.message).toHaveBeenCalledTimes(1);
      expect(chatHandler.message).not.toHaveBeenCalled();
    });
  }

  for (const type of ['reconnect-state-query', 'chat-subscribe', 'chat-reload', 'ws-ping']) {
    it(`routes ${type} only to the chat handler`, async () => {
      const { chatHandler, primary, socket, terminalHandler } = createFixture();

      await primary.message(socket, { type });

      expect(chatHandler.message).toHaveBeenCalledTimes(1);
      expect(terminalHandler.message).not.toHaveBeenCalled();
    });
  }

  it('routes a malformed known terminal request to terminal validation', async () => {
    const { chatHandler, primary, socket, terminalHandler } = createFixture();

    await primary.message(socket, { type: 'terminal-input' });

    expect(terminalHandler.message).toHaveBeenCalledWith(socket, {
      type: 'terminal-input',
    });
    expect(chatHandler.message).not.toHaveBeenCalled();
  });

  it('closes terminal before chat and forwards close diagnostics', () => {
    const { calls, primary, socket } = createFixture();

    primary.close(socket, 1006, 'network-lost');

    expect(calls).toEqual([
      'terminal-close',
      'chat-close:1006:network-lost',
    ]);
  });

  it('always closes chat when terminal cleanup throws', () => {
    const { chatHandler, primary, socket, terminalHandler } = createFixture();
    terminalHandler.close.mockImplementationOnce(() => {
      throw new Error('terminal cleanup failed');
    });

    expect(() => primary.close(socket, 1013, 'capacity')).toThrow(
      'terminal cleanup failed',
    );
    expect(chatHandler.close).toHaveBeenCalledWith(socket, 1013, 'capacity');
  });

  it('allows close without a prior open', () => {
    const { chatHandler, primary, socket, terminalHandler } = createFixture();

    expect(() => primary.close(socket, 1013, 'unknown-reservation')).not.toThrow();
    expect(terminalHandler.close).toHaveBeenCalledTimes(1);
    expect(chatHandler.close).toHaveBeenCalledTimes(1);
  });

  it('keeps chat responsive after terminal authorization expires', async () => {
    const terminalManager = {
      attach: mock(() => undefined),
      input: mock(() => undefined),
      resize: mock(() => undefined),
      detachPeer: mock(() => undefined),
      detachTerminal: mock(() => undefined),
    };
    const chat = new ChatHandler({
      agents: { getRunningChatIdsSnapshot: () => [] },
      chatViews: { readReplay: () => ({}) },
      nativeReloader: { reloadFromNative: async () => ({}) },
      queue: { readChatQueue: async () => ({}) },
      pendingInputs: { listForChat: () => [] },
      registry: { getChat: () => null },
    });
    const primary = new PrimaryWsHandler(
      chat,
      new TerminalStreamHandler(terminalManager, () => 1_000),
    );
    const socket = {
      data: {
        connectionId: 'socket-1',
        principal: {
          mode: 'authenticated',
          key: 'alice',
          username: 'alice',
          expiresAtMs: 999,
        },
      },
      readyState: 1,
      sent: [],
      closes: [],
      subscribe: mock(() => undefined),
      publish: mock(() => undefined),
      send(payload) {
        this.sent.push(JSON.parse(payload));
        return Buffer.byteLength(payload);
      },
      close(code, reason) {
        this.closes.push({ code, reason });
      },
    };
    primary.open(socket);

    await primary.message(socket, {
      type: 'terminal-input',
      terminalId: 'terminal-1',
      data: 'ignored',
    });
    await primary.message(socket, {
      type: 'ws-ping',
      clientRequestId: 'ping-1',
      sentAt: 42,
    });

    expect(socket.sent[0]).toMatchObject({
      type: 'terminal-error',
      code: 'terminal-auth-expired',
    });
    expect(socket.sent[1]).toMatchObject({
      type: 'ws-pong',
      clientRequestId: 'ping-1',
      sentAt: 42,
    });
    expect(socket.closes).toEqual([]);
    expect(terminalManager.detachPeer).toHaveBeenCalledTimes(1);
  });

  it('keeps chat responsive while terminal output waits for drain', async () => {
    const terminalManager = {
      peer: null,
      attach: mock((_principal, peer) => {
        terminalManager.peer = peer;
      }),
      input: mock(() => undefined),
      resize: mock(() => undefined),
      detachPeer: mock(() => undefined),
      detachTerminal: mock(() => undefined),
    };
    const chat = new ChatHandler({
      agents: { getRunningChatIdsSnapshot: () => [] },
      chatViews: { readReplay: () => ({}) },
      nativeReloader: { reloadFromNative: async () => ({}) },
      queue: { readChatQueue: async () => ({}) },
      pendingInputs: { listForChat: () => [] },
      registry: { getChat: () => null },
    });
    const primary = new PrimaryWsHandler(
      chat,
      new TerminalStreamHandler(terminalManager),
    );
    const socket = {
      data: {
        connectionId: 'socket-1',
        principal: {
          mode: 'local',
          key: 'local',
          username: 'local',
          expiresAtMs: null,
        },
      },
      readyState: 1,
      sent: [],
      sendResults: [],
      closes: [],
      subscribe: mock(() => undefined),
      publish: mock(() => undefined),
      send(payload) {
        this.sent.push(JSON.parse(payload));
        return this.sendResults.shift() ?? Buffer.byteLength(payload);
      },
      close(code, reason) {
        this.closes.push({ code, reason });
      },
    };
    primary.open(socket);
    await primary.message(socket, {
      type: 'terminal-attach',
      terminalId: 'terminal-1',
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });

    socket.sendResults.push(-1);
    terminalManager.peer.sendTerminalMessage({
      type: 'terminal-output',
      terminalId: 'terminal-1',
      sequence: 1,
      data: 'blocked',
    });
    terminalManager.peer.sendTerminalMessage({
      type: 'terminal-output',
      terminalId: 'terminal-1',
      sequence: 2,
      data: 'queued',
    });
    await primary.message(socket, {
      type: 'ws-ping',
      clientRequestId: 'ping-1',
      sentAt: 42,
    });
    primary.drain(socket);

    expect(socket.sent.map((message) => message.type)).toEqual([
      'terminal-output',
      'ws-pong',
      'terminal-output',
    ]);
    expect(socket.sent[1]).toMatchObject({
      clientRequestId: 'ping-1',
      sentAt: 42,
    });
    expect(socket.closes).toEqual([]);
  });
});
