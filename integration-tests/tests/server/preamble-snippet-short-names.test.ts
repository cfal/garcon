import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PreamblesMutationResponse,
  PreamblesSnapshot,
} from '../../../common/preambles.js';
import type {
  ExpandSnippetResponse,
  SnippetsMutationResponse,
  SnippetsSnapshot,
} from '../../../common/snippets.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('preamble snippet short names', () => {
  test('expands named preambles with preamble semantics and enforces one namespace', async () => {
    await withIntegrationFixture('preamble-snippet-short-names', async (fixture) => {
      const catalog = await fixture.client.get<PreamblesSnapshot>('/api/v1/preambles');
      const unmatchedProject = join(fixture.dirs.project, 'unmatched');
      await mkdir(unmatchedProject);
      const created = await fixture.client.post<PreamblesMutationResponse>('/api/v1/preambles', {
        expectedRevision: catalog.revision,
        preamble: {
          enabled: false,
          title: 'Manual context',
          snippetShortName: 'manual_context',
          content: 'Chat {{chat_id}} / {{arguments}} / {{project_path}} / \\{{chat_id}}',
          scope: {
            type: 'project-paths',
            rules: [{ projectPath: fixture.dirs.project, includeNested: false }],
          },
          agentIds: ['codex'],
          tagFilter: { mode: 'all', tags: ['manual'] },
        },
      });
      const preamble = created.snapshot.preambles.find(
        (entry) => entry.snippetShortName === 'manual_context',
      );
      if (!preamble) throw new Error('Named preamble was not persisted');
      const chatId = fixture.newChatId();

      const expanded = await fixture.client.post<ExpandSnippetResponse>(
        '/api/v1/snippets/expand',
        {
          shortName: 'manual_context',
          arguments: { type: 'value', value: 'ignored' },
          context: {
            type: 'new-chat',
            chatId,
            projectPath: unmatchedProject,
          },
        },
      );
      expect(expanded).toEqual({
        success: true,
        source: 'preamble',
        sourceId: preamble.id,
        sourceUpdatedAt: preamble.updatedAt,
        shortName: 'manual_context',
        contextProjectPath: unmatchedProject,
        expandedText: `Chat ${chatId} / {{arguments}} / {{project_path}} / {{chat_id}}`,
      });

      const snippets = await fixture.client.get<SnippetsSnapshot>('/api/v1/snippets');
      await expect(fixture.client.post('/api/v1/snippets', {
        expectedRevision: snippets.revision,
        snippet: {
          shortName: 'manual_context',
          template: 'Conflicting snippet',
          defaultArguments: '',
        },
      })).rejects.toMatchObject({
        status: 409,
        body: { errorCode: 'SNIPPET_NAME_CONFLICT' },
      });

      const saved = await fixture.client.post<SnippetsMutationResponse>('/api/v1/snippets', {
        expectedRevision: snippets.revision,
        snippet: { shortName: 'saved', template: 'Saved snippet', defaultArguments: '' },
      });
      await expect(fixture.client.post('/api/v1/preambles', {
        expectedRevision: created.snapshot.revision,
        preamble: {
          enabled: true,
          title: 'Conflicting preamble',
          snippetShortName: 'saved',
          content: 'Conflicting preamble',
          scope: { type: 'global' },
        },
      })).rejects.toMatchObject({
        status: 409,
        body: { errorCode: 'PREAMBLE_SNIPPET_NAME_CONFLICT' },
      });
      expect(saved.snapshot.snippets).toHaveLength(1);

      await fixture.restartGarcon();
      await expect(fixture.client.post<ExpandSnippetResponse>('/api/v1/snippets/expand', {
        shortName: 'manual_context',
        arguments: { type: 'default' },
        context: { type: 'new-chat', chatId, projectPath: unmatchedProject },
      })).resolves.toMatchObject({
        source: 'preamble',
        sourceId: preamble.id,
        expandedText: `Chat ${chatId} / {{arguments}} / {{project_path}} / {{chat_id}}`,
      });
    });
  });
});
