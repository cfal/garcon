import type { AgentModelOption } from '../../../common/agents.js';
import type { ApiProviderModelDiscoveryResponse } from '../../../common/api-providers.js';
import type { ApiProviderDiscoveryRequest, ExecutorCallOptions } from '@garcon/server-agent-interface';

import { MODEL_DISCOVERY_TIMEOUT_MS } from '../../common/provider-discovery.js';

function dedupeModels(models: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.value || seen.has(model.value)) return false;
    seen.add(model.value);
    return true;
  });
}

function appendPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

function openAiModelListUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  const path = new URL(normalized).pathname.replace(/\/+$/, '');
  return appendPath(normalized, !path || path === '/' ? '/v1/models' : '/models');
}

function parseOpenAiModelList(body: unknown): AgentModelOption[] {
  let entries: unknown[] = [];
  if (Array.isArray(body)) entries = body;
  else if (body && typeof body === 'object') {
    const data = (body as Record<string, unknown>).data;
    if (Array.isArray(data)) entries = data;
  }
  const models: AgentModelOption[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as Record<string, unknown>;
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id) continue;
    const displayName = typeof model.display_name === 'string' ? model.display_name.trim() : '';
    const name = typeof model.name === 'string' ? model.name.trim() : '';
    models.push({ value: id, label: displayName || name || id });
  }
  return dedupeModels(models);
}

async function discoverAnthropicModels(input: ApiProviderDiscoveryRequest, signal: AbortSignal): Promise<ApiProviderModelDiscoveryResponse> {
  const normalized = input.baseUrl.replace(/\/+$/, '');
  const baseUrl = appendPath(normalized, normalized.endsWith('/v1') ? '/models' : '/v1/models');
  const models: AgentModelOption[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const url = new URL(baseUrl);
    url.searchParams.set('limit', '1000');
    if (afterId) url.searchParams.set('after_id', afterId);
    const response = await fetch(url, {
      headers: { ...(input.apiKey ? { 'x-api-key': input.apiKey } : {}), 'anthropic-version': '2023-06-01' },
      signal,
    });
    if (!response.ok) return { success: false, error: `Model discovery failed with HTTP ${response.status}.` };
    const body = await response.json() as {
      data?: Array<{ id?: string; display_name?: string; name?: string }>;
      has_more?: boolean;
      last_id?: string | null;
    };
    for (const model of body.data ?? []) {
      if (typeof model.id !== 'string' || !model.id) continue;
      models.push({ value: model.id, label: model.display_name || model.name || model.id });
    }
    if (!body.has_more || !body.last_id || body.last_id === afterId) break;
    afterId = body.last_id;
  }
  return { success: true, models: models.length > 0 ? dedupeModels(models) : undefined };
}

export async function discoverApiProviderModels(
  input: ApiProviderDiscoveryRequest,
  options?: ExecutorCallOptions,
): Promise<ApiProviderModelDiscoveryResponse> {
  const timeout = AbortSignal.timeout(options?.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    if (input.modelDiscovery === 'none') return { success: true };
    if (input.modelDiscovery === 'anthropic-models') return await discoverAnthropicModels(input, signal);
    if (input.modelDiscovery === 'ollama-tags') {
      const normalized = input.baseUrl.replace(/\/+$/, '');
      const baseUrl = normalized.endsWith('/v1') ? normalized.slice(0, -3) : normalized;
      const response = await fetch(`${baseUrl}/api/tags`, { signal });
      if (!response.ok) return { success: false, error: `Ollama model discovery failed with HTTP ${response.status}.` };
      const body = await response.json() as { models?: Array<{ name?: string }> };
      const models = (body.models ?? [])
        .filter((model): model is { name: string } => typeof model.name === 'string' && model.name.length > 0)
        .map((model) => ({ value: model.name, label: `${model.name} (local)`, isLocal: true }));
      return { success: true, models: models.length > 0 ? dedupeModels(models) : undefined };
    }
    const response = await fetch(openAiModelListUrl(input.baseUrl), {
      headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
      signal,
    });
    if (!response.ok) return { success: false, error: `Model discovery failed with HTTP ${response.status}.` };
    const models = parseOpenAiModelList(await response.json());
    return { success: true, models: models.length > 0 ? models : undefined };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
