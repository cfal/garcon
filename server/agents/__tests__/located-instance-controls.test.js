import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createLocatedInstanceFixture, LOCATED_CHATS } from './located-instance-fixture.js';

describe('instance-qualified controls', () => {
  let fixture;
  const chatId = LOCATED_CHATS.secondary;
  beforeEach(async () => {
    fixture = await createLocatedInstanceFixture();
    await fixture.adoption.ensure(chatId);
  });
  afterEach(async () => { await fixture?.dispose(); });

  it('discovers project-only commands from the configured default, not the provider-type registry', async () => {
    fixture.integrations.get = () => fixture.secondary.integration;
    const alias = path.join(fixture.root, 'project-alias');
    await symlink(fixture.root, alias);
    const canonicalRoot = await realpath(fixture.root);
    const signal = new AbortController().signal;
    expect(await fixture.agents.getDefaultSlashCommands('test', alias, signal)).toEqual([
      { name: 'primary-command', source: 'command' },
    ]);
    expect(fixture.primary.integration.commands.discover).toHaveBeenCalledWith(canonicalRoot, signal);
    expect(fixture.secondary.integration.commands.discover).not.toHaveBeenCalled();
  });

  it.each([false, true])('reads the single-query tool policy from its configured default: %s', async (runsToolsWithoutPermission) => {
    const run = mock(async () => 'synthetic response');
    fixture.primary.integration.singleQuery = { runsToolsWithoutPermission, run };
    fixture.secondary.integration.singleQuery = { runsToolsWithoutPermission: !runsToolsWithoutPermission, run: mock(async () => '') };
    fixture.integrations.get = () => fixture.secondary.integration;
    expect(fixture.agents.singleQueryRunsToolsWithoutPermission('test')).toBe(runsToolsWithoutPermission);
    expect(await fixture.agents.runSingleQuery('synthetic prompt', { agentId: 'test' })).toBe('synthetic response');
    expect(run).toHaveBeenCalledOnce();
    expect(fixture.secondary.integration.singleQuery.run).not.toHaveBeenCalled();
  });

  it('does not borrow single-query policy or execution from an unavailable default', async () => {
    fixture.primary.integration.singleQuery = { runsToolsWithoutPermission: true, run: mock(async () => '') };
    fixture.instances.defaultFor = () => null;
    expect(fixture.agents.singleQueryRunsToolsWithoutPermission('test')).toBe(false);
    await expect(fixture.agents.runSingleQuery('synthetic prompt', { agentId: 'test' }))
      .rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(fixture.primary.integration.singleQuery.run).not.toHaveBeenCalled();
  });

  it('rejects project-only discovery when the configured default is unavailable', async () => {
    fixture.instances.defaultFor = () => null;
    await expect(fixture.agents.getDefaultSlashCommands('test', fixture.root, new AbortController().signal))
      .rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(fixture.primary.integration.commands.discover).not.toHaveBeenCalled();
    expect(fixture.secondary.integration.commands.discover).not.toHaveBeenCalled();
  });

  it('captures and delivers steering on the selected instance despite a colliding native ID', async () => {
    await fixture.agents.runAgentTurn(chatId, 'synthetic prompt');
    const target = fixture.agents.captureSteerTarget(chatId);
    await fixture.agents.prepareSteerTarget(chatId, target);
    const prepare = mock(async () => {});
    expect(await fixture.agents.steerInput(chatId, 'synthetic guidance', {
      clientRequestId: 'request-steer', clientMessageId: 'message-steer',
      transcriptViewId: fixture.ledger.currentView(chatId).viewId,
    }, target, prepare)).toEqual({ kind: 'accepted' });
    expect(fixture.secondary.integration.steering.steer).toHaveBeenCalledWith(expect.objectContaining({
      target: fixture.secondary.target, agentSessionId: 'colliding-session',
    }));
    expect(prepare).toHaveBeenCalledOnce();
    expect(fixture.primary.integration.steering.captureTarget).not.toHaveBeenCalled();
    expect(fixture.primary.integration.steering.steer).not.toHaveBeenCalled();
  });

  it.each(['missing', 'provider-mismatch'])('returns no steer target when its exact owner is %s', (unavailable) => {
    if (unavailable === 'missing') {
      const owner = fixture.chats.getChat(chatId);
      fixture.chats.updateChat(chatId, {
        projectPath: owner.projectPath,
        executionLocation: { ...owner.executionLocation, instanceId: 'missing-instance' },
      });
    } else {
      fixture.secondary.integration.descriptor.id = 'different-provider';
    }
    expect(fixture.agents.captureSteerTarget(chatId)).toBeNull();
    expect(fixture.primary.integration.steering.captureTarget).not.toHaveBeenCalled();
    expect(fixture.secondary.integration.steering.captureTarget).not.toHaveBeenCalled();
  });

  it('routes goal control and its settings to the active instance', async () => {
    await fixture.agents.runAgentTurn(chatId, 'synthetic prompt');
    expect(await fixture.agents.submitGoalControl(chatId, '/goal synthetic', {}, async () => {})).toBe(true);
    expect(fixture.secondary.integration.goals.submitControl).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'colliding-session', settings: expect.objectContaining({ values: { parsedBy: 'secondary' } }),
    }));
    expect(fixture.primary.integration.goals.submitControl).not.toHaveBeenCalled();
    expect(fixture.primary.integration.settings.parse).not.toHaveBeenCalled();
  });

  it('compacts and aborts only the owning instance', async () => {
    await fixture.agents.compactSession(chatId);
    expect(await fixture.agents.abortSession(chatId)).toBe(true);
    expect(fixture.secondary.integration.compaction.compact).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'colliding-session', settings: expect.objectContaining({ values: { parsedBy: 'secondary' } }),
    }));
    expect(fixture.secondary.integration.execution.abort).toHaveBeenCalledWith(fixture.secondary.handle);
    expect(fixture.primary.integration.compaction.compact).not.toHaveBeenCalled();
    expect(fixture.primary.integration.execution.abort).not.toHaveBeenCalled();
  });

  it('prepares relocation and applies live configuration on the same captured instance', async () => {
    const owner = fixture.chats.getChat(chatId);
    expect(await fixture.agents.prepareProjectPathUpdate('test', {
      chatId, agentSessionId: owner.agentSessionId, nativeSession: owner.nativeSession,
      previousProjectPath: owner.projectPath, nextProjectPath: `${fixture.root}/next`,
    })).toBe(fixture.secondary.preparation);
    await fixture.agents.updateSessionSettings(chatId, { model: 'changed-model' });
    expect(fixture.secondary.integration.projectPathUpdates.prepare).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ settings: expect.objectContaining({ values: { parsedBy: 'secondary' } }) }),
    }));
    expect(fixture.secondary.integration.sessionConfiguration.apply).toHaveBeenCalledWith(
      'colliding-session', expect.objectContaining({ model: 'changed-model' }), expect.objectContaining({ model: 'synthetic-model' }),
    );
    expect(fixture.chats.getChat(chatId).model).toBe('changed-model');
    expect(fixture.primary.integration.projectPathUpdates.prepare).not.toHaveBeenCalled();
    expect(fixture.primary.integration.sessionConfiguration.apply).not.toHaveBeenCalled();
  });

  it('forks and disposes through the captured owner even after its registry entry changes', async () => {
    const sourceSession = fixture.chats.getChat(chatId);
    const fork = await fixture.agents.forkAgentSession({
      sourceSession, sourceChatId: chatId, targetChatId: '1000000000000003', signal: new AbortController().signal,
    });
    expect(fork.kind).toBe('materialized');
    fixture.chats.updateChat(chatId, {
      projectPath: fixture.root, executionLocation: fixture.chats.getChat(LOCATED_CHATS.primary).executionLocation,
    });
    await fixture.agents.discardForkedAgentSession(sourceSession, fork.session);
    expect(fixture.secondary.integration.forking.fork).toHaveBeenCalledOnce();
    expect(fixture.secondary.integration.forking.discard).toHaveBeenCalledWith(fork.session, expect.any(AbortSignal));
    expect(fixture.primary.integration.forking.fork).not.toHaveBeenCalled();
    expect(fixture.primary.integration.forking.discard).not.toHaveBeenCalled();
  });

  it('never borrows compaction from the default when the selected instance lacks it', async () => {
    fixture.secondary.integration.compaction = null;
    await expect(fixture.agents.compactSession(chatId)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fixture.primary.integration.compaction.compact).not.toHaveBeenCalled();
    expect(fixture.ledger.activeRunId(chatId)).toBeNull();
  });
});
