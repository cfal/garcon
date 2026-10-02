import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRuntime } from '../../../cli/discovery.js';
import { GarconClient } from '../../../cli/garcon-client.js';
import type { PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';
import type { PreambleSelectionPreviewResponse } from '../../../common/chat-preamble-selection-contracts.js';
import { normalizeExpandSnippetResponse, type ExpandSnippetResponse, type SnippetExpansionContext } from '../../../common/snippets.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';
import { cliEnvironment } from '../../support/cli-environment.js';

test('exact project paths survive validation, prompt context, folder changes and forwarded handoff', async () => {
  await withIntegrationFixture('exact-project-paths', async fixture => {
    const { client } = fixture;
    const executorId = client.executorId;
    const project = join(fixture.executionDirs.project, 'repository ');
    await mkdir(project);
    await initializeFixtureRepository(project);
    const validate = (path: string) => client.get(`/api/v1/chats/validate-start?${new URLSearchParams({ path, executorId })}`);
    expect(await validate(project)).toEqual({ valid: true, isGitRepo: true });
    await mkdir(project.trimEnd());
    expect(await validate(project)).toEqual({ valid: true, isGitRepo: true });
    expect(await validate(project.trimEnd())).toEqual({ valid: true, isGitRepo: false });

    const catalog = await client.get<PreamblesSnapshot>('/api/v1/preambles');
    const saved = await client.post<PreamblesMutationResponse>('/api/v1/preambles', {
      expectedRevision: catalog.revision,
      preamble: {
        enabled: true, title: 'Exact project scope', content: 'Synthetic spaced-project instructions',
        scope: { type: 'project-paths', rules: [{ executorId, projectPath: project, includeNested: false }] },
      },
    });
    const scoped = saved.snapshot.preambles.find(entry => entry.title === 'Exact project scope')!;
    const preview = (projectPath: string) => client.post<PreambleSelectionPreviewResponse>('/api/v1/preambles/selection-preview', {
      executorId, projectPath, agentId: fixture.directAgents.openAi.agentId, tags: [],
    });
    expect(await preview(project)).toMatchObject({ canonicalProjectPath: project, orderedPreambleIds: expect.arrayContaining([scoped.id]) });
    expect((await preview(project.trimEnd())).orderedPreambleIds).not.toContain(scoped.id);

    await client.post('/api/v1/snippets', {
      expectedRevision: 0,
      snippet: { shortName: 'exact_path', template: '{{project_path}}', defaultArguments: '' },
    });
    const chatId = fixture.newChatId();
    const expand = async (context: SnippetExpansionContext) => normalizeExpandSnippetResponse(await client.post<ExpandSnippetResponse>('/api/v1/snippets/expand', {
      shortName: 'exact_path', arguments: { type: 'default' }, context,
    }));
    expect(await expand({ type: 'new-chat', chatId, executorId, projectPath: project }))
      .toMatchObject({ contextProjectPath: project, expandedText: project });

    const held = fixture.fakeProviders.openAi.holdNext({ model: fixture.directAgents.openAi.provider.model });
    const started = await client.startDirectChat({ chatId, projectPath: project, content: 'Synthetic exact path request', agent: fixture.directAgents.openAi });
    const request = await held.received;
    expect(request.lastUserText).toContain(scoped.content);
    held.releaseText('Synthetic result');
    await client.waitForTurnTerminal(chatId, started.turnId);
    expect(await expand({ type: 'chat', chatId })).toMatchObject({ contextProjectPath: project, expandedText: project });

    const destination = join(fixture.executionDirs.project, 'destination ');
    await mkdir(destination);
    await mkdir(destination.trimEnd());
    expect(await client.updateProjectPath({ chatId, projectPath: destination })).toMatchObject({ projectPath: destination });
    expect((await client.getChatSnapshot(chatId)).chat.projectPath).toBe(destination);

    if (executorId !== 'local') await client.patch(`/api/v1/executors/${executorId}`, { allowControllerCli: true });
    const runtime = executorId === 'local' ? 'controller' : 'executor';
    const cli = new GarconClient(await discoverRuntime({ configDir: fixture.executionDirs.config, runtime }));
    const before = await client.getChatSnapshot(chatId);
    if (before.transcript.availability !== 'available') throw new Error('Expected a materialized transcript');
    const agent = fixture.directAgents.anthropic;
    const moved = await cli.runChat({
      chatId, transcriptViewId: before.transcript.transcriptViewId,
      clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'Synthetic handoff request',
      handoff: {
        expectedAgentOwnershipEpoch: before.chat.agentOwnershipEpoch,
        target: {
          executorId, projectPath: project, agentId: agent.agentId, model: agent.provider.model,
          apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
          modelProtocol: agent.provider.protocol, permissionMode: 'default', thinkingMode: 'none', agentSettings: agent.agentSettings,
        },
      },
    });
    await client.waitForTurnTerminal(chatId, moved.turnId);
    expect((await client.getChatSnapshot(chatId)).chat.projectPath).toBe(project);
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('../../../cli/main.ts', import.meta.url)),
      'resume', chatId, 'Synthetic CLI continuation'], {
      cwd: project,
      env: cliEnvironment({ GARCON_CONFIG_DIR: fixture.executionDirs.config, GARCON_RUNTIME: runtime }),
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(stdout).toContain('Synthetic CLI continuation');
    expect((await client.getChatSnapshot(chatId)).chat.projectPath).toBe(project);
  });
}, 90_000);
