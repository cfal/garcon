import { describe, expect, test } from 'bun:test';
import { captureStep, isUnported, type CapturedSocket } from '../capture.js';
import type { StartedServer } from '../environment.js';
import { normalizeCapture } from '../normalize.js';
import { resolvePlaceholders } from '../placeholders.js';
import type { ScenarioStep } from '../scenario.js';

// A controller stand-in for the WebSocket capture: `/ws-accept` upgrades,
// answers, and closes, `/ws-keep` upgrades and answers, and every other path
// refuses the upgrade.
function standIn(): StartedServer {
  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (['/ws-accept', '/ws-keep'].includes(path) && server.upgrade(request, { data: path })) return;
      if (path === '/ws-unported') return new Response('Not implemented', { status: 501, headers: { 'X-Garcon-Rs-Unported': '1' } });
      return new Response('Sign in first', { status: 401, headers: { 'Content-Type': 'text/plain' } });
    },
    websocket: {
      open(socket: Bun.ServerWebSocket<string>) {
        socket.send(JSON.stringify({ type: 'ws-pong', clientRequestId: 'r1' }));
        if (socket.data === '/ws-accept') socket.close(4001, 'answered');
      },
      message() {},
    },
  });
  const origin = `http://127.0.0.1:${listener.port}`;
  return {
    origin,
    baseUrl: origin,
    port: String(listener.port),
    token: '',
    credentials: { username: 'parity', password: '' },
    dirs: {
      root: '/parity',
      configDir: '/parity/config',
      workspaceDir: '/parity/workspace',
      projectDir: '/parity/project',
      homeDir: '/parity/home',
    },
    fallbackLogPath: '/parity/fallback.log',
    pid: process.pid,
    startupMs: 0,
    logs: () => '',
    stop: async () => {
      listener.stop(true);
    },
  };
}

// What a step records, and what the recording holds after normalization.
async function capture(step: ScenarioStep): Promise<{ raw: CapturedSocket; recorded: unknown }> {
  const server = standIn();
  try {
    // The stand-in upgrades or refuses, and never answers with a plain HTTP success.
    const raw = await captureStep(server, step, resolvePlaceholders(server, step, new Map(), new Date())) as CapturedSocket;
    return { raw, recorded: normalizeCapture(raw, server) };
  } finally {
    await server.stop();
  }
}

describe('captureStep on a WebSocket step', () => {
  test('records the raw HTTP response to a refused upgrade, and no close code', async () => {
    const { raw, recorded } = await capture({ name: 'refused', ws: { path: '/ws-refuse', auth: 'none' } });
    expect(isUnported(raw)).toBe(false);
    expect(recorded).toEqual({
      request: { path: '/ws-refuse', auth: 'none', protocols: ['(default)'] },
      opened: false,
      protocol: '',
      frames: [],
      // The client's close code and reason for a refused upgrade are its own invention.
      close: null,
      refusal: { status: 401, contentType: 'text/plain', body: 'Sign in first' },
    });
  });

  test('a refused upgrade can be unported without recording the control header', async () => {
    const { raw, recorded } = await capture({ name: 'unported', ws: { path: '/ws-unported', auth: 'none' } });
    expect(isUnported(raw)).toBe(true);
    expect(recorded).toMatchObject({ opened: false, refusal: { status: 501 } });
    expect(recorded).not.toHaveProperty('rawHeaders');
  });

  test('records the replies and the close code of a connection the server accepted and closed', async () => {
    // The server closes long before the step's quiet time ends.
    const { raw, recorded } = await capture({
      name: 'accepted',
      ws: { path: '/ws-accept', auth: 'none', send: [{ type: 'ws-ping', clientRequestId: 'r1' }], quietMs: 5_000 },
    });
    expect(raw.opened).toBe(true);
    // The raw HTTP request is repeated only for a refused upgrade.
    expect(raw.refusal).toBeNull();
    expect(raw.frames).toEqual([{ type: 'ws-pong', clientRequestId: 'r1' }]);
    expect(raw.close).toEqual({ code: 4001, reason: 'answered' });
    expect(recorded).toEqual(raw);
  });

  test('records no close for an accepted connection that is still open when the step ends', async () => {
    const { raw } = await capture({
      name: 'kept',
      ws: { path: '/ws-keep', auth: 'none', send: [{ type: 'ws-ping', clientRequestId: 'r1' }], frames: 1 },
    });
    expect(raw.opened).toBe(true);
    expect(raw.frames).toEqual([{ type: 'ws-pong', clientRequestId: 'r1' }]);
    expect(raw.close).toBeNull();
  });
});
