import { afterEach, describe, expect, it } from "bun:test";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { LocalWorkspaceTerminalService } from "../../execution-node/local-workspace-terminals.js";
import {
  TERMINAL_STREAM_MAX_PENDING_MESSAGES_PER_SESSION,
  TERMINAL_STREAM_TARGET_MESSAGE_BYTES,
  TerminalStreamHandler,
} from "../terminal-stream.ts";

function principal(expiresAtMs = null) {
  return expiresAtMs === null
    ? { mode: "local", key: "local", username: "local", expiresAtMs: null }
    : {
        mode: "authenticated",
        key: "alice",
        username: "alice",
        expiresAtMs,
      };
}

function socket(expiresAtMs = null) {
  return {
    data: {
      connectionId: "socket-1",
      principal: principal(expiresAtMs),
    },
    readyState: 1,
    sent: [],
    sentByteLengths: [],
    sentCompression: [],
    sendResults: [],
    closes: [],
    send(payload, compress) {
      this.sent.push(JSON.parse(payload));
      this.sentByteLengths.push(Buffer.byteLength(payload, "utf8"));
      this.sentCompression.push(compress);
      return this.sendResults.shift() ?? Buffer.byteLength(payload, "utf8");
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
        "attach",
        receivedPrincipal,
        peer.connectionId,
        message,
      ]);
    },
    input(receivedPrincipal, peer, terminalId, data) {
      this.calls.push([
        "input",
        receivedPrincipal,
        peer.connectionId,
        terminalId,
        data,
      ]);
    },
    resize(receivedPrincipal, peer, terminalId, cols, rows) {
      this.calls.push([
        "resize",
        receivedPrincipal,
        peer.connectionId,
        terminalId,
        cols,
        rows,
      ]);
    },
    detachPeer(receivedPrincipal, peer) {
      this.calls.push(["detach", receivedPrincipal, peer.connectionId]);
    },
    detachTerminal(receivedPrincipal, peer, terminalId) {
      this.calls.push([
        "detach-terminal",
        receivedPrincipal,
        peer.connectionId,
        terminalId,
      ]);
    },
  };
}

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function ownerFixture() {
  const children = [];
  const owner = new LocalWorkspaceTerminalService({
    projectBasePath: homedir(), assertProjectPathAllowed: realpath,
    shell: '/bin/sh', environment: {}, replayBytes: 4 * 1024 * 1024,
    spawnPty: () => {
      const child = {
        writes: [],
        write(data) { this.writes.push(data); },
        resize() {}, kill() {},
        onData(listener) { this.emit = listener; },
        onExit() {},
      };
      children.push(child);
      return child;
    },
  });
  cleanups.push(() => owner.shutdown());
  const handler = new TerminalStreamHandler(owner);
  const ws = socket();
  handler.open(ws);
  cleanups.push(() => handler.close(ws));
  const terminals = [];
  for (const requestId of ['first', 'second']) {
    terminals.push((await owner.create(ws.data.principal, { requestId, requestedInitialWorkingDirectory: null })).terminal);
  }
  const attach = (terminalId) => handler.message(ws, {
    type: 'terminal-attach', terminalId, clientId: 'synthetic-tab', afterSequence: 0, intent: 'restore',
  });
  const input = (terminalId, data) => handler.message(ws, { type: 'terminal-input', terminalId, data });
  return { owner, handler, ws, children, terminals, attach, input };
}

describe("TerminalStreamHandler", () => {
  it("validates and dispatches multiplexed messages using trusted socket identity", async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);

    await handler.message(ws, { type: "unknown" });
    await handler.message(ws, {
      type: "terminal-attach",
      terminalId: "terminal-1",
      clientId: "client-1",
      afterSequence: 0,
      intent: "restore",
    });
    await handler.message(ws, {
      type: "terminal-input",
      terminalId: "terminal-1",
      data: "pwd\n",
    });
    await handler.message(ws, {
      type: "terminal-resize",
      terminalId: "terminal-1",
      cols: 100,
      rows: 30,
    });

    expect(ws.sent[0]).toEqual({
      type: "terminal-error",
      code: "terminal-validation",
      message: "Invalid terminal stream message.",
    });
    expect(ws.sentCompression).toEqual([true]);
    expect(terminals.calls.map((call) => call[0])).toEqual([
      "attach",
      "input",
      "resize",
    ]);
    expect(terminals.calls[0][1]).toBe(ws.data.principal);
  });

  it("detaches every owned terminal without terminating on socket close", () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);
    handler.close(ws);
    handler.close(ws);

    expect(terminals.calls).toEqual([
      ["detach", ws.data.principal, "socket-1"],
    ]);
  });

  it("expires terminal capability without closing the primary socket", async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals, () => 1_000);
    const ws = socket(999);
    handler.open(ws);
    await handler.message(ws, {
      type: "terminal-input",
      terminalId: "terminal-1",
      data: "ignored",
    });

    expect(ws.closes).toEqual([]);
    expect(ws.sent).toEqual([
      {
        type: "terminal-error",
        code: "terminal-auth-expired",
        message: "Terminal authorization expired.",
      },
    ]);
    expect(terminals.calls.map((call) => call[0])).toEqual(["detach"]);

    await handler.message(ws, {
      type: "terminal-input",
      terminalId: "terminal-1",
      data: "still ignored",
    });
    expect(ws.sent).toHaveLength(1);
    expect(terminals.calls).toHaveLength(1);
  });

  it("lazily expires an attached terminal and stops passive output", async () => {
    const terminals = manager();
    const expiresAtMs = Date.now() + 5;
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket(expiresAtMs);
    handler.open(ws);
    await handler.message(ws, {
      type: "terminal-attach",
      terminalId: "terminal-1",
      clientId: "client-1",
      afterSequence: 0,
      intent: "restore",
    });

    await Bun.sleep(15);
    terminals.peer.sendTerminalMessage({
      type: "terminal-output",
      terminalId: "terminal-1",
      sequence: 1,
      data: "late",
    });

    expect(ws.closes).toEqual([]);
    expect(ws.sent).toContainEqual({
      type: "terminal-error",
      code: "terminal-auth-expired",
      message: "Terminal authorization expired.",
    });
    expect(ws.sent).not.toContainEqual(expect.objectContaining({
      type: "terminal-output",
      data: "late",
    }));
    expect(terminals.calls.map((call) => call[0])).toEqual(["attach", "detach"]);
  });

  it("flushes pending terminal output fairly when Bun signals drain", async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);
    await handler.message(ws, {
      type: "terminal-attach",
      terminalId: "terminal-1",
      clientId: "client-1",
      afterSequence: 0,
      intent: "restore",
    });
    ws.sendResults.push(-1);

    terminals.peer.sendTerminalMessage({
      type: "terminal-output",
      terminalId: "terminal-1",
      sequence: 1,
      data: "one",
    });
    terminals.peer.sendTerminalMessage({
      type: "terminal-output",
      terminalId: "terminal-1",
      sequence: 2,
      data: "two",
    });
    terminals.peer.sendTerminalMessage({
      type: "terminal-output",
      terminalId: "terminal-1",
      sequence: 3,
      data: "three",
    });
    terminals.peer.sendTerminalMessage({
      type: "terminal-output",
      terminalId: "terminal-2",
      sequence: 1,
      data: "other",
    });

    handler.drain(ws);

    expect(
      ws.sent.map(({ terminalId, sequence }) => [terminalId, sequence]),
    ).toEqual([
      ["terminal-1", 1],
      ["terminal-1", 2],
      ["terminal-2", 1],
      ["terminal-1", 3],
    ]);
    expect(ws.closes).toEqual([]);
  });

  it("bounds a noisy terminal without closing other multiplexed sessions", async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);
    await handler.message(ws, {
      type: "terminal-attach",
      terminalId: "terminal-1",
      clientId: "client-1",
      afterSequence: 0,
      intent: "restore",
    });
    ws.sendResults.push(-1);
    terminals.peer.sendTerminalMessage({
      type: "terminal-output",
      terminalId: "terminal-1",
      sequence: 1,
      data: "blocked",
    });

    for (
      let sequence = 2;
      sequence <= TERMINAL_STREAM_MAX_PENDING_MESSAGES_PER_SESSION + 2;
      sequence += 1
    ) {
      terminals.peer.sendTerminalMessage({
        type: "terminal-output",
        terminalId: "terminal-1",
        sequence,
        data: "pending",
      });
    }

    handler.drain(ws);

    expect(ws.closes).toEqual([]);
    expect(terminals.calls.at(-1)).toEqual([
      "detach-terminal",
      ws.data.principal,
      "socket-1",
      "terminal-1",
    ]);
    expect(ws.sent).toContainEqual({
      type: "terminal-error",
      terminalId: "terminal-1",
      code: "terminal-backpressure",
      message: "Terminal output exceeded this client connection capacity.",
    });
  });

  it("fragments a large replay while backpressured without closing the multiplexed socket", async () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    handler.open(ws);
    await handler.message(ws, {
      type: "terminal-attach",
      terminalId: "terminal-1",
      clientId: "client-1",
      afterSequence: 0,
      intent: "restore",
    });
    ws.sendResults.push(-1);
    terminals.peer.sendTerminalMessage({
      type: "terminal-output",
      terminalId: "terminal-1",
      sequence: 1,
      data: "blocked",
    });
    terminals.peer.sendTerminalMessage({
      type: "terminal-attached",
      terminal: {
        terminalId: "terminal-2",
        displaySequence: 2,
        title: null,
        initialWorkingDirectory: "/workspace",
        processStatus: "running",
        attachmentStatus: "attached",
        createdAt: "2026-07-13T00:00:00.000Z",
        exitCode: null,
        latestOutputSequence: 1,
      },
      replay: [{ sequence: 1, data: "\0".repeat(200_000) }],
    });

    handler.drain(ws);

    expect(ws.closes).toEqual([]);
    expect(
      ws.sent.some((message) => message.type === "terminal-output-fragment"),
    ).toBe(true);
    expect(Math.max(...ws.sentByteLengths)).toBeLessThanOrEqual(
      TERMINAL_STREAM_TARGET_MESSAGE_BYTES,
    );
  });

  it('aborts an immutable peer before detach and fences its output after reopening', () => {
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals);
    const ws = socket();
    cleanups.push(() => handler.close(ws));
    const attach = () => handler.message(ws, {
      type: 'terminal-attach', terminalId: 'terminal-1', clientId: 'tab', afterSequence: 0, intent: 'restore',
    });
    handler.open(ws);
    attach();
    const retired = terminals.peer;
    expect(Object.isFrozen(retired)).toBe(true);
    let abortedAtDetach = false;
    terminals.detachPeer = (_principal, peer) => { abortedAtDetach = peer.signal.aborted; };
    handler.close(ws);
    expect(abortedAtDetach).toBe(true);
    handler.open(ws);
    attach();
    retired.sendTerminalMessage({ type: 'terminal-output', terminalId: 'terminal-1', sequence: 1, data: 'stale' });
    terminals.peer.sendTerminalMessage({ type: 'terminal-output', terminalId: 'terminal-1', sequence: 2, data: 'current' });
    expect(ws.sent).toEqual([{ type: 'terminal-output', terminalId: 'terminal-1', sequence: 2, data: 'current' }]);
  });

  it.each(['drain', 'output'])('checks authorization expiry on %s before the expiry timer runs', (callback) => {
    let now = 0;
    const terminals = manager();
    const handler = new TerminalStreamHandler(terminals, () => now);
    const ws = socket(60_000);
    cleanups.push(() => handler.close(ws));
    handler.open(ws);
    handler.message(ws, { type: 'terminal-attach', terminalId: 'terminal-1', clientId: 'tab', afterSequence: 0, intent: 'restore' });
    ws.sendResults.push(-1);
    const output = (sequence) => terminals.peer.sendTerminalMessage({
      type: 'terminal-output', terminalId: 'terminal-1', sequence, data: 'synthetic',
    });
    output(1);
    output(2);
    ws.sent.length = 0;
    now = 60_000;
    if (callback === 'drain') handler.drain(ws);
    else output(3);
    handler.drain(ws);
    expect(terminals.peer.signal.aborted).toBe(true);
    expect(ws.sent).toEqual([{
      type: 'terminal-error', code: 'terminal-auth-expired', message: 'Terminal authorization expired.',
    }]);
    expect(ws.closes).toEqual([]);
  });

  it('admits same-tick attach/input and discards queued input on close', async () => {
    const { handler, ws, children, terminals, attach, input } = await ownerFixture();
    expect(attach(terminals[0].terminalId)).toBeUndefined();
    expect(input(terminals[0].terminalId, 'accepted')).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(children[0].writes).toEqual(['accepted']);
    input(terminals[0].terminalId, 'closed');
    handler.close(ws);
    await new Promise((resolve) => setImmediate(resolve));
    expect(children[0].writes).toEqual(['accepted']);
  });

  it('a send failure during attach detaches ownership before the next input', async () => {
    const { owner, ws, children, terminals, attach, input } = await ownerFixture();
    ws.sendResults.push(0);
    attach(terminals[0].terminalId);
    input(terminals[0].terminalId, 'closed');
    await new Promise((resolve) => setImmediate(resolve));
    expect(children[0].writes).toEqual([]);
    expect(owner.list(ws.data.principal)[0].attachmentStatus).toBe('detached');
    expect(ws.closes).toEqual([{ code: 1011, reason: 'TERMINAL_STREAM_SEND_FAILED' }]);
  });

  it.each(['live output', 'attach replay'])('stops an overflowing %s expansion and preserves the other terminal', async (delivery) => {
    const { owner, handler, ws, children, terminals, attach, input } = await ownerFixture();
    const noisy = terminals[0].terminalId;
    const other = terminals[1].terminalId;
    attach(other);
    if (delivery === 'live output') attach(noisy);
    ws.sent.length = 0;
    ws.sendResults.push(-1);
    children[1].emit('blocked');
    children[0].emit('x'.repeat(2 * 1024 * 1024));
    if (delivery === 'attach replay') attach(noisy);
    expect(owner.list(ws.data.principal).map((terminal) => terminal.attachmentStatus)).toEqual(['detached', 'attached']);
    handler.drain(ws);
    expect(ws.sent.filter((message) => message.terminalId === noisy)).toEqual([{
      type: 'terminal-error', terminalId: noisy, code: 'terminal-backpressure',
      message: 'Terminal output exceeded this client connection capacity.',
    }]);
    input(noisy, 'rejected');
    input(other, 'accepted');
    await new Promise((resolve) => setImmediate(resolve));
    expect(children.map((child) => child.writes)).toEqual([[], ['accepted']]);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'terminal-error', terminalId: noisy, code: 'terminal-not-attached' });
    expect(ws.closes).toEqual([]);
  });
});
