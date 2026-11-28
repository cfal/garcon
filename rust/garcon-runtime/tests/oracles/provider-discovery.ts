import type { ApiProviderDiscoveryRequest } from '@garcon/server-agent-interface';
import { discoverApiProviderModels } from '../../../../server/runtime/providers/discovery.ts';

type Probe = Omit<ApiProviderDiscoveryRequest, 'baseUrl'> & { path: string };
type Reply = { status?: number; body?: unknown; raw?: string };

export async function discoverModels(input: Probe, replies: Reply[]) {
  const calls: { path: string; authorization: string | null; apiKey: string | null; anthropicVersion: string | null }[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const reply = replies[calls.length];
      calls.push({ path: url.pathname + url.search, authorization: request.headers.get('authorization'),
        apiKey: request.headers.get('x-api-key'), anthropicVersion: request.headers.get('anthropic-version') });
      if (!reply) return new Response(null, { status: 500 });
      return new Response(reply.raw ?? JSON.stringify(reply.body ?? null), { status: reply.status ?? 200 });
    },
  });
  try {
    const { path, ...selection } = input;
    const result = await discoverApiProviderModels({ ...selection, baseUrl: `http://127.0.0.1:${provider.port}${path}` });
    return { result, calls };
  } finally {
    provider.stop(true);
  }
}
