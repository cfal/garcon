import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PI_DISCOVERY_MODELS = ['garcon-discovery/physical', 'garcon-router/auto'];

export async function preparePiModelDiscoveryFixture(home: string): Promise<string> {
  const agentDir = join(home, '.pi', 'agent');
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await writeFile(join(agentDir, 'extensions', 'discovery.js'), `
export default function (pi) {
  pi.registerProvider('garcon-discovery', {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'synthetic-key',
    models: [{ id: 'physical', name: 'Physical', reasoning: false, input: ['text'],
      contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  pi.registerVirtualModel({
    provider: 'garcon-router', id: 'auto', name: 'Automatic', thinkingLevels: ['low', 'high'],
    route() { throw new Error('Discovery must not perform inference'); },
  });
}
`);
  return agentDir;
}
