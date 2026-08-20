import { describe, expect, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ExpandSnippetResponse,
  Snippet,
  SnippetsMutationResponse,
  SnippetsSnapshot,
} from '../../../common/snippets.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const createdAt = '2026-01-01T00:00:00.000Z';

describe('snippet default arguments', () => {
  test('migrates, resolves omission, preserves explicit empty, and survives restart', async () => {
    await withIntegrationFixture(
      'snippet-default-arguments',
      async (fixture) => {
        const snippetsPath = join(fixture.dirs.workspace, 'snippets.json');
        const migrated = JSON.parse(await readFile(snippetsPath, 'utf8')) as {
          version: number;
          revision: number;
          snippets: Snippet[];
        };
        expect(migrated).toEqual({
          version: 2,
          revision: 7,
          snippets: [
            {
              id: 'snippet-review',
              shortName: 'review',
              template: 'Review {{arguments}} in {{project_path}}',
              defaultArguments: '',
              createdAt,
              updatedAt: createdAt,
            },
          ],
        });
        expect((await stat(snippetsPath)).mode & 0o777).toBe(0o600);

        const initial = await fixture.client.get<SnippetsSnapshot>('/api/v1/snippets');
        expect(initial).toEqual({ revision: 7, snippets: migrated.snippets });

        await expect(
          fixture.client.post('/api/v1/snippets', {
            expectedRevision: 7,
            snippet: {
              shortName: 'missing_default',
              template: 'Missing default arguments',
            },
          }),
        ).rejects.toMatchObject({
          status: 400,
          body: { errorCode: 'SNIPPET_VALIDATION_FAILED' },
        });

        const updated = await fixture.client.put<SnippetsMutationResponse>('/api/v1/snippets', {
          expectedRevision: 7,
          id: 'snippet-review',
          snippet: {
            shortName: 'review',
            template: 'Review {{arguments}} in {{project_path}}',
            defaultArguments: 'staged\nchanges',
          },
        });
        expect(updated.snapshot.revision).toBe(8);
        expect(updated.snapshot.snippets[0]?.defaultArguments).toBe('staged\nchanges');

        const omitted = await fixture.client.post<ExpandSnippetResponse>(
          '/api/v1/snippets/expand',
          {
            shortName: 'review',
            arguments: { type: 'default' },
            context: { type: 'project', projectPath: fixture.dirs.project },
          },
        );
        expect(omitted.expandedText).toBe(`Review staged\nchanges in ${fixture.dirs.project}`);

        const explicitEmpty = await fixture.client.post<ExpandSnippetResponse>(
          '/api/v1/snippets/expand',
          {
            shortName: 'review',
            arguments: { type: 'value', value: '' },
            context: { type: 'project', projectPath: fixture.dirs.project },
          },
        );
        expect(explicitEmpty.expandedText).toBe(`Review  in ${fixture.dirs.project}`);

        for (const argumentsInput of ['', { type: 'unknown' }]) {
          await expect(
            fixture.client.post('/api/v1/snippets/expand', {
              shortName: 'review',
              arguments: argumentsInput,
              context: { type: 'project', projectPath: fixture.dirs.project },
            }),
          ).rejects.toMatchObject({
            status: 400,
            body: { errorCode: 'SNIPPET_VALIDATION_FAILED' },
          });
        }

        await fixture.restartGarcon();
        const restarted = await fixture.client.get<SnippetsSnapshot>('/api/v1/snippets');
        expect(restarted.revision).toBe(8);
        expect(restarted.snippets[0]?.defaultArguments).toBe('staged\nchanges');
        await expect(
          fixture.client.post<ExpandSnippetResponse>('/api/v1/snippets/expand', {
            shortName: 'review',
            arguments: { type: 'default' },
            context: { type: 'project', projectPath: fixture.dirs.project },
          }),
        ).resolves.toMatchObject({
          expandedText: `Review staged\nchanges in ${fixture.dirs.project}`,
        });
      },
      {
        prepareWorkspace: async ({ workspace }) => {
          await writeFile(
            join(workspace, 'snippets.json'),
            JSON.stringify({
              version: 1,
              revision: 7,
              snippets: [
                {
                  id: 'snippet-review',
                  shortName: 'review',
                  template: 'Review {{arguments}} in {{project_path}}',
                  createdAt,
                  updatedAt: createdAt,
                },
              ],
            }),
            { mode: 0o644 },
          );
        },
      },
    );
  });
});
