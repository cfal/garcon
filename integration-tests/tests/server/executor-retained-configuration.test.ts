import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreambleDefinition, PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';
import { GENERATION_UI_SETTING_KEYS, type GenerationSelectionUiSettings, type RemoteSettingsSnapshot, type RemoteUiSettings } from '../../../common/settings.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`unchanged preamble scopes remain editable after executor loss and deletion (${executionBackend})`, async () => {
    await withIntegrationFixture(`retained-preamble-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const executorId = client.executorId;
      const definition: PreambleDefinition = {
        title: 'Synthetic retained scope', content: 'Synthetic scope instructions', enabled: true,
        agentIds: [], tagFilter: { mode: 'any', tags: [] },
        scope: { type: 'project-paths', rules: [
          { executorId: 'local', projectPath: fixture.dirs.project, includeNested: true },
          { executorId, projectPath: fixture.executionDirs.project, includeNested: true },
        ] },
      };
      let snapshot = await client.get<PreamblesSnapshot>('/api/v1/preambles');
      ({ snapshot } = await client.post<PreamblesMutationResponse>('/api/v1/preambles', {
        expectedRevision: snapshot.revision, preamble: definition,
      }));
      const id = snapshot.preambles.find(preamble => preamble.title === definition.title)!.id;
      await client.patch(`/api/v1/executors/${executorId}`, { enabled: false });
      ({ snapshot } = await client.put<PreamblesMutationResponse>('/api/v1/preambles', {
        id, expectedRevision: snapshot.revision, preamble: { ...definition, enabled: false },
      }));
      expect(snapshot.preambles.find(preamble => preamble.id === id)?.enabled).toBe(false);
      await expect(client.put('/api/v1/preambles', {
        id, expectedRevision: snapshot.revision,
        preamble: { ...definition, scope: { type: 'project-paths', rules: [
          { executorId, projectPath: fixture.executionDirs.project, includeNested: false },
        ] } },
      })).rejects.toMatchObject({ status: 503, body: { errorCode: 'EXECUTOR_UNAVAILABLE' } });
      await client.delete(`/api/v1/executors/${executorId}`);
      ({ snapshot } = await client.put<PreamblesMutationResponse>('/api/v1/preambles', {
        id, expectedRevision: snapshot.revision,
        preamble: { ...definition, enabled: false, content: 'Synthetic edited instructions' },
      }));
      expect(await client.get<PreamblesSnapshot>('/api/v1/preambles')).toEqual(snapshot);
      expect(JSON.parse(await readFile(join(fixture.dirs.workspace, 'preambles.json'), 'utf8'))).toMatchObject(snapshot);
    }, { executionBackend, projectRoots: 'separate' });
  }, 40_000);

  test(`retained generation targets do not block unrelated settings edits (${executionBackend})`, async () => {
    await withIntegrationFixture(`retained-generation-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const executorId = client.executorId;
      const agent = fixture.directAgents.openAi;
      const selection = {
        executorId, agentId: agent.agentId, model: agent.provider.model,
        apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
        modelProtocol: agent.provider.protocol, thinkingMode: 'none',
      } satisfies GenerationSelectionUiSettings;
      await client.updateSettings({ ui: Object.fromEntries(GENERATION_UI_SETTING_KEYS.map(key => [key, selection])) });
      await client.delete(`/api/v1/executors/${executorId}`);
      const ui = {
        chatTitle: { ...selection, enabled: false },
        agentSwitchCompaction: { ...selection, enabled: false, contextWindowTokens: 200_000 },
        commitMessage: { ...selection, useCommonDirPrefix: true },
        promptRefinement: { ...selection, customPrompt: 'Synthetic instructions: {{USER_PROMPT}}' },
      } satisfies Partial<RemoteUiSettings>;
      await client.updateSettings({ ui });
      await expect(client.put('/api/v1/app/settings', { ui: { chatTitle: { ...ui.chatTitle, thinkingMode: 'high' } } }))
        .rejects.toMatchObject({ status: 422, body: { errorCode: 'UNSUPPORTED_AGENT' } });
      const saved = await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
      expect(saved.ui).toMatchObject(ui);
      expect(JSON.parse(await readFile(join(fixture.dirs.workspace, 'project-settings.json'), 'utf8'))).toMatchObject({ ui });
      await client.updateSettings({ ui: { chatTitle: { ...selection, enabled: true } } });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(0);
    }, { executionBackend });
  }, 40_000);
}
