import { TestWebSocketLink as WebSocketLink } from '../../__tests__/test-session-transport.js';
import { expect, test } from 'bun:test';
import { connectNoiseWebSocket, createNoiseServer, type NoiseOptions, type NoiseWebSocket } from '@cfal/noise-ws';
import { primaryHello, signedProof, selectedDecision } from '../../__tests__/link-hello.js';
import { isLinkHello, isLinkProof, type LinkHello, type LinkRole } from '../link-handshake.js';
import { protocolProfileId, type ProtocolDecision } from '../protocol-compatibility.js';
import { EXECUTOR_NOISE_CONTEXT, type LinkFailure } from '../websocket-link.js';

const secret = Buffer.alloc(32, 42).toString('base64url');

async function handshake(role: LinkRole, dialer: 'link' | 'peer', bootstrap: number, attack?: 'offer' | 'decision' | 'selection' | 'oversized') {
  const link = new WebSocketLink({ role, executorId: 'synthetic-executor', secret, noTls: true, redialDelaysMs: [60_000] });
  const failures: LinkFailure[] = [];
  link.onError(failure => failures.push(failure));
  const hello: LinkHello = { ...primaryHello(role === 'controller' ? 'worker' : 'controller'),
    build: 'independent-build', protocol: { bootstrap, contracts: { 'synthetic.unknown': [1, 3] } } };
  // The sender's key order and whitespace are part of the signed transcript.
  const local = JSON.stringify(Object.fromEntries(Object.entries(hello).reverse()), null, 2);
  const received = Promise.withResolvers<ProtocolDecision>();
  let peerFrame = '';
  let socket: NoiseWebSocket | undefined;
  let accepted = 0;
  link.onSession(() => { accepted++; });
  const options: NoiseOptions = {
    psk: Buffer.from(secret, 'base64url'), context: EXECUTOR_NOISE_CONTEXT,
    onOpen(opened) {
      socket = opened;
      opened.send(attack === 'oversized' ? local + ' '.repeat(60 * 1024) : local);
    },
    onMessage(opened, data) {
      if (typeof data !== 'string') return;
      const frame: unknown = JSON.parse(data);
      if (isLinkHello(frame)) {
        peerFrame = data;
        const decision = attack === 'selection'
          ? { ok: true as const, profileId: protocolProfileId({ bootstrap: 1, contracts: { 'synthetic.unknown': [3] } }) }
          : selectedDecision(hello.protocol!, frame.protocol!);
        const proof = signedProof(secret, hello.role, attack === 'offer' ? JSON.stringify(hello) : local, data, decision);
        opened.send(JSON.stringify(attack === 'decision' ? { ...proof, decision: { ok: false, code: 'BOOTSTRAP_MISMATCH' } } : proof));
      } else if (isLinkProof(frame)) {
        expect(frame.signature).toBe(signedProof(secret, role, peerFrame, local, frame.decision).signature);
        received.resolve(frame.decision);
      }
    },
  };
  const noise = createNoiseServer();
  let server: ReturnType<typeof Bun.serve> | undefined;
  if (dialer === 'peer') socket = connectNoiseWebSocket(link.listen(), options);
  else {
    server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: (request, server) => noise.upgrade(request, server, options), websocket: noise.websocket });
    link.dial(`ws://127.0.0.1:${server.port}/executor`);
  }
  return {
    link, failures, received: received.promise, accepted: () => accepted,
    async closed() {
      // Failure notification is synchronous with closing the authenticated socket.
      if (failures.length) return;
      await new Promise<void>(resolve => { const unsubscribe = link.onError(() => { unsubscribe(); resolve(); }); });
    },
    async dispose() { socket?.close(); await link.dispose(); noise.close(); await server?.stop(true); },
  };
}

for (const role of ['controller', 'worker'] as const) for (const dialer of ['link', 'peer'] as const) {
  test(`different builds authenticate exact hello bytes without selecting unknown contracts (${role}, ${dialer} dials)`, async () => {
    const pair = await handshake(role, dialer, 1);
    try {
      const session = await pair.link.ready;
      expect(await pair.received).toEqual({ ok: true, profileId: protocolProfileId({ bootstrap: 1, contracts: {} }) });
      expect(session.profile).toEqual({ bootstrap: 1, contracts: {} });
      expect(Object.isFrozen(session.profile.contracts)).toBe(true);
      expect(session.continuity.executorId).toBe('synthetic-executor');
      expect(pair.failures).toEqual([]);
    } finally { await pair.dispose(); }
  });

  test(`both peers receive an authenticated refusal before any session exists (${role}, ${dialer} dials)`, async () => {
    const pair = await handshake(role, dialer, 2);
    try {
      expect(await pair.received).toEqual({ ok: false, code: 'BOOTSTRAP_MISMATCH' });
      await pair.closed();
      expect(pair.accepted()).toBe(0);
      expect(pair.failures[0]?.message).toContain('BOOTSTRAP_MISMATCH');
      expect(pair.failures[0]?.message).toContain('peer bootstrap 2 build independent-build');
    } finally { await pair.dispose(); }
  });
}

for (const attack of ['offer', 'decision', 'selection', 'oversized'] as const) {
  test(`rejects ${attack} before exposing a session`, async () => {
    const pair = await handshake('controller', 'peer', 1, attack);
    try {
      await pair.closed();
      expect(pair.accepted()).toBe(0);
      expect(pair.link.current).toBeNull();
    } finally { await pair.dispose(); }
  });
}
