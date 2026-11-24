import { expect, spyOn, test } from 'bun:test';
import type { GenerationDiscoveryAgents } from '../generation-config-source.js';
import { resolveTitleModelQuery, TITLE_MODEL_UNAVAILABLE_MESSAGE } from '../title-model.js';

test('warns about a missing automatic title model only when generation is enabled', async () => {
  const agents = {
    getAgentAuthStatusMap: async () => ({}),
    getAgentReadinessMap: async () => ({}),
    getAgentCatalogEntries: async () => [],
  } satisfies GenerationDiscoveryAgents;
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await resolveTitleModelQuery(agents, {}, 'automatic')).toBeNull();
    expect(await resolveTitleModelQuery(agents, { enabled: false }, 'automatic')).toBeNull();
    expect(await resolveTitleModelQuery(agents, { enabled: true }, 'on-demand')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(await resolveTitleModelQuery(agents, { enabled: true }, 'automatic')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'chat-title: generation failed:', TITLE_MODEL_UNAVAILABLE_MESSAGE);
  } finally {
    warn.mockRestore();
  }
});
