import { fileURLToPath } from 'node:url';
import type { AgentHistoryImport, AgentIntegration } from '../../server-agents/interface/src/index.js';
import { AssistantMessage } from '../../common/chat-types.js';
import { IntegrationRegistry } from '../../server/agents/integration-registry.js';
import { NodeNativeOccupancy } from '../../server/execution-node/native-occupancy.js';
import { startNodeInstanceRuntime } from '../../server/execution-node/worker/instance-runtime.js';
import { runNodeWorkerRuntime } from '../../server/execution-node/worker/main.js';
import { createNodeSessionRuntime } from '../../server/execution-node/worker/session-runtime.js';

const role = process.argv[2];
if (process.argv.length !== 3 || (role !== 'session' && role !== 'instance')) process.exit(2);

async function gate(stage: string): Promise<void> {
  const address = process.env.GARCON_TEST_HISTORY_GATE;
  const token = process.env.GARCON_TEST_HISTORY_TOKEN;
  if (!address || !token) throw new Error('Synthetic history gate is unconfigured');
  const response = await fetch(`${address}/${stage}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Synthetic history gate refused');
}

if (role === 'instance') {
  const required = IntegrationRegistry.prototype.require;
  const patched = new WeakSet<AgentIntegration>();
  IntegrationRegistry.prototype.require = function (agentId) {
    const provider = required.call(this, agentId);
    if (patched.has(provider)) return provider;
    if (agentId !== 'direct-anthropic-compatible' || !provider.nativeHistoryImport) throw new Error('Unexpected synthetic history provider');
    patched.add(provider);
    const ordinary = provider.nativeHistoryImport.load.bind(provider.nativeHistoryImport);
    let first = true;
    provider.nativeHistoryImport.load = (request) => {
      if (!first) return ordinary(request);
      first = false;
      const mode = process.env.GARCON_TEST_HISTORY_LIFETIME;
      if (mode !== 'held-advance' && mode !== 'encoding-cleanup' && mode !== 'late-invalid') throw new Error('Invalid synthetic history mode');
      request.signal.addEventListener('abort', () => { void gate('aborted').catch(() => {}); }, { once: true });
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (mode === 'held-advance') await gate('advance');
              const rows = Array.from({ length: mode === 'late-invalid' ? 257 : 1 }, (_, index) => ({
                message: new AssistantMessage('2026-01-01T00:00:00.000Z', mode === 'encoding-cleanup'
                  ? 'Synthetic large row '.repeat(3000) : `Synthetic row ${index}`),
                providerMeta: { index },
              }));
              if (mode === 'late-invalid') rows[256]!.providerMeta.index = NaN;
              return { done: false, value: rows };
            },
            async return() {
              if (mode !== 'late-invalid') await gate('cleanup');
              return { done: true, value: undefined };
            },
          };
        },
      } satisfies ReturnType<AgentHistoryImport['load']>;
    };
    return provider;
  };
  const reserve = NodeNativeOccupancy.prototype.reserveExecution;
  let observeFirstRelease = true;
  NodeNativeOccupancy.prototype.reserveExecution = function (chatId) {
    const reservation = reserve.call(this, chatId);
    if (!observeFirstRelease) return reservation;
    observeFirstRelease = false;
    return { enter: () => reservation.enter(), release() {
      reservation.release();
      void gate('released').catch(() => {});
    } };
  };
}

await runNodeWorkerRuntime(role, (context, writer) => role === 'instance'
  ? startNodeInstanceRuntime(context, writer)
  : createNodeSessionRuntime(context, writer, () => [process.execPath, '--no-env-file', '--config=/dev/null', fileURLToPath(import.meta.url), 'instance']));
