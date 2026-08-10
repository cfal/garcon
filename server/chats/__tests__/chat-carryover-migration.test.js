import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { CarryOverTranscriptStore } from '../carryover-transcript-store.ts';
import { encodeCarryOverPages } from '../carryover-page-codec.ts';
import { assertMigrationBudget } from '../carryover-migration-budget.ts';
import {
  finalizeCarryOverMigrationValidation,
  markCarryOverMigrationRollbackUnsafe,
  migrateLegacyCarryOverWorkspace,
} from '../chat-carryover-migration.ts';
import { rollbackLegacyCarryOverMigration } from '../chat-carryover-rollback.ts';
import { migratedTranscriptMatches } from '../legacy-carryover-import.ts';

const CHAT_ID = '1786077000000001';
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

describe('legacy carryover migration', () => {
  let workspaceDir;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-carryover-migration-'));
    await writeWorkspaceVersion(3);
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('preserves sanitized messages and empty-segment boundaries in direct segments', async () => {
    await writeLegacyWorkspace({
      segments: [
        segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')], {
          target: { agentId: 'claude', model: 'opus' },
        }),
        segment('claude', 'opus', [], {
          target: { agentId: 'pi', model: 'kimi' },
        }),
      ],
      currentAgentId: 'pi',
      currentModel: 'kimi',
    });

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    const registry = await readJson('chats.json');
    const migrated = registry.sessions[CHAT_ID];
    expect(registry.version).toBe(5);
    expect(migrated.carryOverSegments).toHaveLength(2);
    const store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
    const messages = await store.loadAll(migrated.carryOverSegments);
    expect(messages).toEqual([
      expect.objectContaining({ type: 'user-message', content: 'first' }),
      expect.objectContaining({
        type: 'agent-switch',
        fromAgentId: 'codex',
        toAgentId: 'claude',
      }),
      expect.objectContaining({
        type: 'agent-switch',
        fromAgentId: 'claude',
        toAgentId: 'pi',
      }),
    ]);
  });

  it('promotes a committed staged transfer and retains its source cleanup', async () => {
    const stable = segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')], {
      target: { agentId: 'claude', model: 'opus' },
    });
    const transferred = segment('claude', 'opus', [new UserMessage(TIMESTAMP, 'second')], {
      target: { agentId: 'pi', model: 'kimi' },
    });
    const target = {
      ...legacyEntry('pi', 'kimi'),
      agentSessionId: null,
      nativeSession: null,
    };
    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 3,
      sessions: { [CHAT_ID]: target },
    }));
    await fs.writeFile(path.join(workspaceDir, 'chat-carryover.json'), JSON.stringify({
      version: 4,
      chats: {
        [CHAT_ID]: {
          revision: 1,
          segments: [stable],
          staged: {
            targetEpoch: target.agentOwnershipEpoch,
            ownerId: 'pi',
            revision: 2,
            segments: [stable, transferred],
          },
        },
      },
    }));
    await fs.writeFile(path.join(workspaceDir, 'agent-ownership-journal.json'), JSON.stringify({
      version: 1,
      intents: [{
        id: 'legacy-transfer',
        kind: 'transfer',
        chatId: CHAT_ID,
        oldReference: {
          chatId: CHAT_ID,
          agentId: 'claude',
          agentSessionId: 'claude-session',
          projectPath: '/workspace/project',
          model: 'opus',
          nativeSession: null,
          carryOverRevision: 'carry-v1:1',
          settings: { ownerId: 'claude', schemaVersion: 1, values: {} },
        },
        oldEpoch: 'claude-epoch',
        targetAgentId: 'pi',
        targetEpoch: target.agentOwnershipEpoch,
        createdAt: TIMESTAMP,
      }],
    }));

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    const registry = await readJson('chats.json');
    const migrated = registry.sessions[CHAT_ID];
    const store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
    expect(await store.loadAll(migrated.carryOverSegments)).toEqual([
      expect.objectContaining({ type: 'user-message', content: 'first' }),
      expect.objectContaining({
        type: 'agent-switch',
        fromAgentId: 'codex',
        toAgentId: 'claude',
      }),
      expect.objectContaining({ type: 'user-message', content: 'second' }),
      expect.objectContaining({
        type: 'agent-switch',
        fromAgentId: 'claude',
        toAgentId: 'pi',
      }),
    ]);
    expect(await readJson('agent-ownership-journal.json')).toEqual({
      version: 3,
      ownershipIntents: [],
      transferCleanup: [expect.objectContaining({
        operationId: 'legacy-transfer',
        chatId: CHAT_ID,
        status: 'pending',
        attempts: 0,
        source: expect.objectContaining({
          agentId: 'claude',
          agentSessionId: 'claude-session',
          nativeSeedReceipt: null,
        }),
      })],
    });
  });

  it('resumes after the registry commit and before the ownership-journal commit', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    await migrateLegacyCarryOverWorkspace(workspaceDir);
    const complete = await readJson('carryover-transcripts/migration-v2.json');
    const migratedFile = (await fs.readdir(workspaceDir)).find((file) => (
      file.startsWith('chat-carryover.v5.migrated.')
    ));
    expect(migratedFile).toBeDefined();
    await fs.rename(
      path.join(workspaceDir, migratedFile),
      path.join(workspaceDir, 'chat-carryover.json'),
    );
    await fs.writeFile(
      path.join(workspaceDir, 'agent-ownership-journal.json'),
      JSON.stringify({ version: 1, intents: [] }),
    );
    const {
      completedAt: _completedAt,
      rollbackSafe: _rollbackSafe,
      ...readyFields
    } = complete;
    await fs.writeFile(
      path.join(workspaceDir, 'carryover-transcripts/migration-v2.json'),
      JSON.stringify({ ...readyFields, phase: 'ready-to-commit' }),
    );

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    expect(await readJson('agent-ownership-journal.json')).toEqual({
      version: 3,
      ownershipIntents: [],
      transferCleanup: [],
    });
    expect((await readJson('carryover-transcripts/migration-v2.json')).phase).toBe('complete');
    await expect(fs.stat(path.join(workspaceDir, 'chat-carryover.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('migrates a draft schema-v4 registry without linked history', async () => {
    await fs.writeFile(
      path.join(workspaceDir, 'chats.json'),
      JSON.stringify({ version: 4, sessions: {} }),
    );

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    expect(await readJson('chats.json')).toEqual({ version: 5, sessions: {} });
  });

  it('flattens a draft linked point fork into direct segment references', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const prefixId = '33333333-3333-4333-8333-333333333333';
    await writeLinkedMaterializedNode({
      id: firstId,
      parentId: null,
      source: linkedSource('codex', 'gpt'),
      target: { agentId: 'claude', model: 'opus' },
      messages: [
        new UserMessage(TIMESTAMP, 'linked-a-user'),
        new AssistantMessage(TIMESTAMP, 'linked-a-assistant'),
      ],
    });
    await writeLinkedMaterializedNode({
      id: secondId,
      parentId: firstId,
      source: linkedSource('claude', 'opus'),
      target: { agentId: 'pi', model: 'kimi' },
      messages: [
        new UserMessage(TIMESTAMP, 'linked-b-user'),
        new AssistantMessage(TIMESTAMP, 'linked-b-assistant'),
      ],
    });
    await fs.mkdir(path.join(
      workspaceDir,
      'carryover-transcripts',
      'nodes',
      prefixId,
    ), { recursive: true });
    await fs.writeFile(path.join(
      workspaceDir,
      'carryover-transcripts',
      'nodes',
      prefixId,
      'manifest.json',
    ), JSON.stringify({
      version: 1,
      kind: 'prefix',
      id: prefixId,
      parentId: firstId,
      createdAt: TIMESTAMP,
      sourceNodeId: secondId,
      messageCount: 1,
      source: linkedSource('claude', 'opus'),
    }));
    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 4,
      sessions: {
        [CHAT_ID]: {
          ...legacyEntry('claude', 'opus'),
          carryOverHeadId: prefixId,
          nativeSeedReceipt: null,
          carryOverMigrationQuarantine: null,
        },
      },
    }));
    await fs.writeFile(
      path.join(workspaceDir, 'agent-ownership-journal.json'),
      JSON.stringify({ version: 2, ownershipIntents: [], transferCleanup: [] }),
    );

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    const entry = (await readJson('chats.json')).sessions[CHAT_ID];
    expect(entry).not.toHaveProperty('carryOverHeadId');
    expect(entry.carryOverSegments).toEqual([
      expect.objectContaining({
        id: firstId,
        agentId: 'codex',
        storedMessageCount: 2,
        visibleMessageCount: 2,
        trailingHandoff: { agentId: 'claude', model: 'opus' },
      }),
      expect.objectContaining({
        id: secondId,
        agentId: 'claude',
        storedMessageCount: 2,
        visibleMessageCount: 1,
        trailingHandoff: null,
      }),
    ]);
    const store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
    expect(await store.loadAll(entry.carryOverSegments)).toEqual([
      expect.objectContaining({ type: 'user-message', content: 'linked-a-user' }),
      expect.objectContaining({ type: 'assistant-message', content: 'linked-a-assistant' }),
      expect.objectContaining({
        type: 'agent-switch',
        fromAgentId: 'codex',
        toAgentId: 'claude',
      }),
      expect.objectContaining({ type: 'user-message', content: 'linked-b-user' }),
    ]);
  });

  it('quarantines malformed chat history without treating it as empty history', async () => {
    await writeLegacyWorkspace({
      segments: [{ agentId: 'codex', model: 'gpt', messages: [{ type: 'invalid' }] }],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    const entry = (await readJson('chats.json')).sessions[CHAT_ID];
    expect(entry.carryOverSegments).toEqual([]);
    expect(entry.carryOverMigrationQuarantine).toMatchObject({
      errorCode: 'INVALID_CARRYOVER_ENTRY',
    });
    await expect(fs.stat(path.join(
      workspaceDir,
      'carryover-transcripts',
      'quarantine',
      `${entry.carryOverMigrationQuarantine.artifactId}.json`,
    ))).resolves.toBeDefined();
  });

  it('restores every legacy artifact during the rollback validation window', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    const legacyCarryOver = await readJson('chat-carryover.json');
    const legacyRegistry = await readJson('chats.json');
    const legacyJournal = await readJson('agent-ownership-journal.json');
    await migrateLegacyCarryOverWorkspace(workspaceDir);
    await writeWorkspaceVersion(5);

    expect(await rollbackLegacyCarryOverMigration(workspaceDir)).toBe('restored');

    expect(await readJson('workspace-version.json')).toEqual({ version: 3 });
    expect(await readJson('chats.json')).toEqual(legacyRegistry);
    expect(await readJson('chat-carryover.json')).toEqual(legacyCarryOver);
    expect(await readJson('agent-ownership-journal.json')).toEqual(legacyJournal);
    await expect(fs.stat(path.join(workspaceDir, 'carryover-transcripts/migration-v2.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(path.join(workspaceDir, 'carryover-transcripts'))).some((file) => (
      file.startsWith('migration-v2.rolled-back.')
    ))).toBe(true);
    expect(await rollbackLegacyCarryOverMigration(workspaceDir)).toBe('already-restored');
  });

  it('finishes a rollback that stopped after the journal restore on the next boot', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    await migrateLegacyCarryOverWorkspace(workspaceDir);
    // Crash window: the legacy journal is restored and the resume marker was
    // written, but the workspace version is still 5, so a version-gated
    // recovery would never run. This used to fail the next boot with 'Invalid
    // migrated ownership journal'.
    await fs.writeFile(
      path.join(workspaceDir, 'agent-ownership-journal.json'),
      JSON.stringify({ version: 1, intents: [] }),
    );
    await writeWorkspaceVersion(5);
    await markRollingBack();

    expect(await migrateLegacyCarryOverWorkspace(workspaceDir)).toBe(true);

    const registry = await readJson('chats.json');
    expect(registry.version).toBe(5);
    expect((await readJson('agent-ownership-journal.json')).version).toBe(3);
    expect((await readJson('carryover-transcripts/migration-v2.json')).phase).toBe('complete');
    const store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
    const messages = await store.loadAll(registry.sessions[CHAT_ID].carryOverSegments);
    expect(messages).toEqual([
      expect.objectContaining({ type: 'user-message', content: 'first' }),
      expect.objectContaining({ type: 'agent-switch' }),
    ]);
  });

  it('finishes a rollback that restored the registry before any resume marker existed', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    await migrateLegacyCarryOverWorkspace(workspaceDir);
    // Crash window left by a rollback without a resume marker: the legacy
    // registry is back beside a 'complete' marker. This used to fail the next
    // boot with 'Completed carryover migration marker cannot accompany a legacy
    // registry'.
    const backups = await fs.readdir(path.join(workspaceDir, 'migration-backups'));
    const registryBackup = backups.find((file) => file.startsWith('chats.v3.'));
    await fs.copyFile(
      path.join(workspaceDir, 'migration-backups', registryBackup),
      path.join(workspaceDir, 'chats.json'),
    );

    expect(await migrateLegacyCarryOverWorkspace(workspaceDir)).toBe(true);

    expect((await readJson('chats.json')).version).toBe(5);
    expect((await readJson('carryover-transcripts/migration-v2.json')).phase).toBe('complete');
  });

  it('resumes an interrupted rollback through the rollback command itself', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    const legacyCarryOver = await readJson('chat-carryover.json');
    const legacyRegistry = await readJson('chats.json');
    const legacyJournal = await readJson('agent-ownership-journal.json');
    await migrateLegacyCarryOverWorkspace(workspaceDir);
    await fs.writeFile(
      path.join(workspaceDir, 'agent-ownership-journal.json'),
      JSON.stringify(legacyJournal),
    );
    await writeWorkspaceVersion(3);
    await markRollingBack();

    expect(await rollbackLegacyCarryOverMigration(workspaceDir)).toBe('restored');

    expect(await readJson('chats.json')).toEqual(legacyRegistry);
    expect(await readJson('chat-carryover.json')).toEqual(legacyCarryOver);
    expect(await readJson('agent-ownership-journal.json')).toEqual(legacyJournal);
    await expect(fs.stat(path.join(workspaceDir, 'carryover-transcripts/migration-v2.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await rollbackLegacyCarryOverMigration(workspaceDir)).toBe('already-restored');
  });

  it('closes the rollback window before a normal segment can be accepted', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    await migrateLegacyCarryOverWorkspace(workspaceDir);
    await writeWorkspaceVersion(5);

    await markCarryOverMigrationRollbackUnsafe(workspaceDir);

    expect((await readJson('carryover-transcripts/migration-v2.json')).rollbackSafe).toBe(false);
    await expect(rollbackLegacyCarryOverMigration(workspaceDir))
      .rejects.toThrow('unsafe after new-format history was created');
    expect((await readJson('chats.json')).version).toBe(5);
  });

  it('removes rollback artifacts after a validated subsequent restart', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    await migrateLegacyCarryOverWorkspace(workspaceDir);

    await finalizeCarryOverMigrationValidation(workspaceDir);

    expect((await readJson('carryover-transcripts/migration-v2.json')).rollbackSafe).toBe(false);
    expect((await fs.readdir(workspaceDir)).some((file) => (
      file.startsWith('chat-carryover.v5.migrated.')
    ))).toBe(false);
    expect(await fs.readdir(path.join(workspaceDir, 'migration-backups'))).toEqual([]);
    await expect(rollbackLegacyCarryOverMigration(workspaceDir))
      .rejects.toThrow('unsafe after new-format history was created');
  });

  it('releases a transfer whose chat was deleted instead of aborting the boot', async () => {
    await writeLegacyWorkspace({
      segments: [segment('codex', 'gpt', [new UserMessage(TIMESTAMP, 'first')])],
      currentAgentId: 'codex',
      currentModel: 'gpt',
    });
    // A pending v1 transfer for a chat that no longer exists. This used to throw
    // a plain Error outside the per-chat quarantine loop, so one stale entry
    // failed the whole migration and the workspace could not boot.
    await fs.writeFile(path.join(workspaceDir, 'agent-ownership-journal.json'), JSON.stringify({
      version: 1,
      intents: [{
        id: 'legacy-transfer',
        kind: 'transfer',
        chatId: '1786077000009999',
        oldReference: {
          chatId: '1786077000009999',
          agentId: 'claude',
          agentSessionId: 'claude-session',
          projectPath: '/workspace/project',
          model: 'opus',
          nativeSession: null,
          carryOverRevision: 'carry-v1:1',
          settings: { ownerId: 'claude', schemaVersion: 1, values: {} },
        },
        oldEpoch: 'claude-epoch',
        targetAgentId: 'pi',
        targetEpoch: 'pi-epoch',
        createdAt: TIMESTAMP,
      }],
    }));

    await migrateLegacyCarryOverWorkspace(workspaceDir);

    const journal = await readJson('agent-ownership-journal.json');
    expect(journal.version).toBe(3);
    // Converted to a delete intent so the orphaned provider session is still
    // releasable, matching how the delete branch already handled this state.
    expect(journal.ownershipIntents).toHaveLength(1);
    expect(journal.ownershipIntents[0]).toMatchObject({
      kind: 'delete',
      chatId: '1786077000009999',
      phase: 'registry-removed',
    });
    expect(journal.ownershipIntents[0].releaseReferences).toHaveLength(1);
  });

  it('rejects transcripts that differ from the committed segments', async () => {
    await writeLegacyWorkspace({
      segments: [
        segment('codex', 'gpt', [
          new UserMessage(TIMESTAMP, 'first'),
          new AssistantMessage(TIMESTAMP, 'second'),
        ], { target: { agentId: 'claude', model: 'opus' } }),
      ],
      currentAgentId: 'claude',
      currentModel: 'opus',
    });
    await migrateLegacyCarryOverWorkspace(workspaceDir);

    const refs = (await readJson('chats.json')).sessions[CHAT_ID].carryOverSegments;
    const store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
    const committed = await store.loadAll(refs);

    expect(await migratedTranscriptMatches(store, refs, committed)).toBe(true);
    expect(await migratedTranscriptMatches(store, refs, committed.slice(0, -1))).toBe(false);
    expect(await migratedTranscriptMatches(store, refs, [
      ...committed,
      new UserMessage(TIMESTAMP, 'extra'),
    ])).toBe(false);
    expect(await migratedTranscriptMatches(store, refs, [
      new UserMessage(TIMESTAMP, 'changed'),
      ...committed.slice(1),
    ])).toBe(false);
  });

  async function writeWorkspaceVersion(version) {
    await fs.writeFile(
      path.join(workspaceDir, 'workspace-version.json'),
      JSON.stringify({ version }),
    );
  }

  async function writeLegacyWorkspace({ segments, currentAgentId, currentModel }) {
    await fs.writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 3,
      sessions: {
        [CHAT_ID]: legacyEntry(currentAgentId, currentModel),
      },
    }));
    await fs.writeFile(path.join(workspaceDir, 'chat-carryover.json'), JSON.stringify({
      version: 4,
      chats: {
        [CHAT_ID]: { revision: 1, segments },
      },
    }));
    await fs.writeFile(
      path.join(workspaceDir, 'agent-ownership-journal.json'),
      JSON.stringify({ version: 1, intents: [] }),
    );
  }

  async function writeLinkedMaterializedNode({ id, parentId, source, target, messages }) {
    const encoded = await encodeCarryOverPages(messages);
    const directory = path.join(workspaceDir, 'carryover-transcripts', 'nodes', id);
    await fs.mkdir(path.join(directory, 'pages'), { recursive: true });
    for (const page of encoded) {
      await fs.writeFile(path.join(directory, page.descriptor.file), page.bytes);
    }
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      version: 1,
      kind: 'materialized',
      id,
      parentId,
      createdAt: TIMESTAMP,
      source,
      boundary: { kind: 'handoff', targetAtCapture: target },
      seedSanitation: 'not-applicable',
      messageCount: messages.length,
      pages: encoded.map((page) => page.descriptor),
    }));
  }

  function readJson(relativePath) {
    return fs.readFile(path.join(workspaceDir, relativePath), 'utf8').then(JSON.parse);
  }

  async function markRollingBack() {
    const markerPath = path.join(workspaceDir, 'carryover-transcripts', 'migration-v2.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    await fs.writeFile(markerPath, JSON.stringify({ ...marker, phase: 'rolling-back' }));
  }
});

describe('carryover migration budget', () => {
  const ample = { availableDisk: 64 * 1024 ** 3, availableMemory: 64 * 1024 ** 3 };

  it('accepts a source that the retired heap probe would have rejected', () => {
    // Bun reports a ~350MB heap limit at startup, which refused every legacy file
    // over ~120MB even on hosts with tens of gigabytes free.
    expect(() => assertMigrationBudget({
      sourceBytes: 218 * 1024 ** 2,
      availableDisk: 8 * 1024 ** 3,
      availableMemory: 2 * 1024 ** 3,
    })).not.toThrow();
  });

  it('skips both budgets when there is no legacy source', () => {
    expect(() => assertMigrationBudget({
      sourceBytes: 0,
      availableDisk: 0,
      availableMemory: 0,
    })).not.toThrow();
  });

  it('refuses when free disk cannot hold the converted store', () => {
    expect(() => assertMigrationBudget({
      ...ample,
      sourceBytes: 100 * 1024 ** 2,
      availableDisk: 100 * 1024 ** 2,
    })).toThrow('free bytes');
  });

  it('refuses when free memory cannot hold the parse', () => {
    expect(() => assertMigrationBudget({
      ...ample,
      sourceBytes: 100 * 1024 ** 2,
      availableMemory: 700 * 1024 ** 2,
    })).toThrow('bytes of free memory');
  });
});

function segment(agentId, model, messages, options = {}) {
  return {
    agentId,
    model,
    messages,
    at: TIMESTAMP,
    boundary: true,
    boundaryTarget: options.target ?? null,
  };
}

function legacyEntry(agentId, model) {
  return {
    agentId,
    agentSessionId: `${agentId}-session`,
    nativeSession: null,
    agentOwnershipEpoch: `${agentId}-epoch`,
    agentSettingsById: {
      [agentId]: { ownerId: agentId, schemaVersion: 1, values: {} },
    },
    projectPath: '/workspace/project',
    tags: [],
    model,
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    lastReadAt: null,
    permissionMode: 'default',
    thinkingMode: 'none',
  };
}

function linkedSource(agentId, model) {
  return {
    agentId,
    model,
    nativeSessionId: `${agentId}-session`,
    nativeRevision: `${agentId}-revision`,
  };
}
