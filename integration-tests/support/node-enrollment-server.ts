import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { initializeServerConfig, isAuthDisabled } from '../../server/config.js';
import { init as initAuthStore, needsSetup } from '../../server/auth/store.js';
import { generateAuthToken } from '../../server/auth/token.js';
import { NodeEnrollmentService } from '../../server/execution-nodes/enrollment.js';
import { NodePairingStore } from '../../server/execution-nodes/pairing-store.js';
import { ExecutionNodesStore } from '../../server/execution-nodes/store.js';
import { NodeEnrollmentTransport } from '../../server/execution-nodes/trust.js';
import { createNodeEnrollmentRoutes } from '../../server/routes/execution-node-enrollment.js';
import { wrapRoutes } from '../../server/lib/http-route.js';
import { NODE_ENROLLMENT_TTL_MS } from '../../common/execution-node-config.js';
import { parseControllerTlsTrust } from '../../common/controller-tls.js';
import { writeJsonFileAtomic } from '../../server/lib/json-file-store.js';

export type EnrollmentFixtureCommand =
  | { readonly kind: 'inspect' | 'revoke' | 'expire' | 'drop-reply' | 'stop' }
  | { readonly kind: 'hold-write' | 'wait-for-write' | 'release-write' | 'disable-administration' }
  | { readonly kind: 'authenticate'; readonly credential: string };
export interface EnrollmentFixtureRequest { readonly id: number; readonly command: EnrollmentFixtureCommand }
export interface EnrollmentFixtureReply {
  readonly type: 'reply'; readonly id: number; readonly exchanges: number; readonly authenticated: boolean | null;
}
export interface EnrollmentFixtureReady {
  readonly type: 'ready'; readonly baseUrl: string; readonly nodeId: string; readonly localNodeId: string;
  readonly accountToken: string; readonly localCapability: string;
}

// Runs only as a fixture process so the real auth wrapper never changes the test runner's config.
if (import.meta.main) {
  const config = initializeServerConfig();
  await initAuthStore();
  const nodes = new ExecutionNodesStore(config.workspaceDir);
  await nodes.init();
  const node = nodes.snapshot().nodes.find((node) => node.kind === 'remote') ?? await nodes.addRemoteNode('Synthetic node');
  let now = Date.now();
  let exchanges = 0;
  let dropReply = false;
  let administrationEnabled = true;
  let holdWrite = false;
  let writeBarrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  const pairings = new NodePairingStore(config.workspaceDir, { now: () => now, write: async (...args) => {
    await writeJsonFileAtomic(...args);
    if (holdWrite) {
      holdWrite = false;
      writeBarrier.entered.resolve();
      await writeBarrier.release.promise;
    }
  } });
  const localCapability = randomBytes(32).toString('base64url');
  const trust = parseControllerTlsTrust(JSON.parse(process.env.GARCON_ENROLLMENT_TEST_TRUST ?? 'null'));
  if (!trust) throw new Error('Missing synthetic controller trust');
  let routes: ReturnType<typeof wrapRoutes> = {};
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    ...(config.tls ? { tls: { cert: await readFile(config.tls.certificatePath, 'utf8'), key: await readFile(config.tls.keyPath, 'utf8') } } : {}),
    async fetch(request, server) {
      const url = new URL(request.url);
      const exchange = url.pathname === '/api/v1/execution-nodes/enroll';
      if (exchange) exchanges++;
      const response = await routes[url.pathname]?.[request.method]?.(request, server) ?? new Response(null, { status: 404 });
      if (exchange && response.ok && dropReply) {
        dropReply = false;
        void response.body?.cancel();
        return new Response('{"version":', { headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    },
  });
  const enrollment = new NodeEnrollmentService({
    pairings, nodes, controller: { controllerUrl: `https://127.0.0.1:${server.port}`, trust },
    isAdministrationEnabled: async () => administrationEnabled && !isAuthDisabled() && !await needsSetup(),
  });
  const raw = createNodeEnrollmentRoutes({ enrollment, transport: new NodeEnrollmentTransport({ listenerUsesTls: config.tls !== null }) });
  routes = wrapRoutes(raw, { localCapability });
  process.on('disconnect', async () => { writeBarrier.release.resolve(); await server.stop(true); process.exit(0); });
  process.on('message', async (request: EnrollmentFixtureRequest) => {
    let authenticated: boolean | null = null;
    switch (request.command.kind) {
      case 'revoke': await pairings.init(); await pairings.revoke(node.id); break;
      case 'expire': now += NODE_ENROLLMENT_TTL_MS; break;
      case 'drop-reply': dropReply = true; break;
      case 'authenticate': await pairings.init(); authenticated = pairings.authenticate(request.command.credential) !== null; break;
      case 'inspect': break;
      case 'hold-write':
        await pairings.init();
        writeBarrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
        holdWrite = true; break;
      case 'wait-for-write': await writeBarrier.entered.promise; break;
      case 'release-write': writeBarrier.release.resolve(); break;
      case 'disable-administration': administrationEnabled = false; break;
      case 'stop': writeBarrier.release.resolve(); await server.stop(true); process.exit(0);
    }
    process.send?.({ type: 'reply', id: request.id, exchanges, authenticated } satisfies EnrollmentFixtureReply);
  });
  process.send?.({
    type: 'ready', baseUrl: `${config.tls ? 'https' : 'http'}://127.0.0.1:${server.port}`, nodeId: node.id, localNodeId: nodes.localNodeId,
    accountToken: await generateAuthToken({ username: 'synthetic-user' }), localCapability,
  } satisfies EnrollmentFixtureReady);
}
