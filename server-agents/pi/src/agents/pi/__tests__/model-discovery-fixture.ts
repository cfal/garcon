import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PI_DISCOVERY_MODELS = [
  'garcon-discovery/physical',
  'garcon-native/native',
  'garcon-router/auto',
];

export async function preparePiModelDiscoveryFixture(home: string): Promise<string> {
  const agentDir = join(home, '.pi', 'agent');
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
    'garcon-native': { type: 'api_key', key: 'synthetic-key' },
  }));
  await writeFile(join(agentDir, 'extensions', 'discovery.js'), `
export default function (pi) {
  pi.registerProvider('garcon-discovery', {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'synthetic-key',
    models: [{ id: 'physical', name: 'Physical', reasoning: false, input: ['text'],
      contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  pi.registerProvider({
    id: 'garcon-native', name: 'Garcon Native',
    auth: {
      apiKey: {
        name: 'API key',
        async login() { return { type: 'api_key', key: 'synthetic-key' }; },
        async check({ credential }) {
          return credential ? { type: 'api_key', source: 'stored' } : undefined;
        },
        async resolve({ credential }) {
          return credential ? { auth: { apiKey: credential.key }, source: 'stored' } : undefined;
        },
      },
    },
    getModels() {
      return [{ id: 'native', name: 'Native', api: 'openai-completions', provider: 'garcon-native',
        baseUrl: 'http://127.0.0.1:1/v1', reasoning: false, input: ['text'],
        contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
    },
    stream() { throw new Error('Discovery must not perform inference'); },
    streamSimple() { throw new Error('Discovery must not perform inference'); },
  });
  pi.registerVirtualModel({
    provider: 'garcon-router', id: 'auto', name: 'Automatic', thinkingLevels: ['low', 'high'],
    route() { throw new Error('Discovery must not perform inference'); },
  });
}
`);
  return agentDir;
}
