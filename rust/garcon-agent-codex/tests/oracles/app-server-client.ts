import { CodexAppServerClient } from '../../../../server-agents/codex/src/agents/codex/app-server/client.ts';

const command = process.argv[2]!;
const trace = process.argv[3]!;
const client = new CodexAppServerClient({
  resolveCli: async () => ({ command, source: 'path' }),
  env: { SYNTHETIC_CODEX_TRACE: trace },
  config: {
    model_providers: { 'synthetic.provider': { name: 'fixture', supports_websockets: false } },
    features: { parallel: true },
  },
  modelCatalogPath: '/synthetic/catalog.json',
});
await client.connect();
await client.request('ping', null);
await client.request('ping', { label: 'synthetic', '9': 1e-7, '2': 1e20, rounded: 9007199254740993 });
await client.steerTurn({ threadId: 'thread', expectedTurnId: 'turn', input: [{ type: 'text', text: 'synthetic' }] },
  { prepareDelivery: async () => {}, acknowledgementTimeoutMs: 1_000 });
await client.shutdown();
