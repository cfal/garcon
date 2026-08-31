import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateAgentIntegrationCoreRecords } from '../core-record-migration.js';

const MIGRATION_DIR = path.join('migration-journals', 'agent-integration-v1');

function envelope(ownerId, values = {}) {
  return { ownerId, schemaVersion: 1, values };
}

function integration(id, legacyKey, defaultValue) {
  const defaults = () => envelope(id, { [legacyKey]: defaultValue });
  const parse = (input) => {
    if (input.ownerId !== id || input.schemaVersion !== 1) {
      throw new Error(`wrong settings for ${id}`);
    }
    return input;
  };
  return {
    descriptor: { id },
    settings: {
      defaults,
      parse,
      migrate: async (input) => parse(input),
      applyPatch(current, patch) {
        const parsed = parse(current);
        return envelope(id, { ...parsed.values, ...patch });
      },
    },
    migration: {
      translateLegacyNativeSession: async ({ legacyNativePath }) => ({
        ownerId: id,
        schemaVersion: 1,
        value: { path: legacyNativePath ?? '' },
      }),
      translateLegacySettings: async ({ legacyValues }) => envelope(id, {
        [legacyKey]: Object.hasOwn(legacyValues, legacyKey)
          ? legacyValues[legacyKey]
          : defaultValue,
      }),
    },
  };
}

function codexIntegration() {
  const defaults = () => ({
    ownerId: 'codex',
    schemaVersion: 2,
    values: { codexFastMode: 'off' },
  });
  const parse = (input) => {
    if (input.ownerId !== 'codex' || input.schemaVersion !== 2) {
      throw new Error('invalid codex settings');
    }
    for (const [key, value] of Object.entries(input.values)) {
      if (key !== 'codexFastMode' || !['on', 'off'].includes(value)) {
        throw new Error('invalid codex settings');
      }
    }
    return { ...input, values: { ...input.values } };
  };
  return {
    descriptor: { id: 'codex' },
    settings: {
      defaults,
      parse,
      async migrate(input) {
        if (input.ownerId !== 'codex') throw new Error('invalid codex settings');
        if (input.schemaVersion === 1) return defaults();
        return parse(input);
      },
      applyPatch(current, patch) {
        const parsed = parse(current);
        return parse({ ...parsed, values: { ...parsed.values, ...patch } });
      },
    },
    migration: {
      translateLegacyNativeSession: async () => null,
      translateLegacySettings: async () => defaults(),
    },
  };
}

function integrations(...values) {
  const byId = new Map(values.map((value) => [value.descriptor.id, value]));
  return {
    list: () => [...byId.values()],
    require(id) {
      const value = byId.get(id);
      if (!value) throw new Error(`missing integration ${id}`);
      return value;
    },
  };
}

function digest(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

describe('agent integration core-record migration', () => {
  let workspaceDir;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-core-migration-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('atomically translates core records while preserving existing settings envelopes', async () => {
    const originalChats = {
      version: 2,
      sessions: {
        '100': {
          provider: 'claude',
          providerSessionId: 'native-100',
          nativePath: '/tmp/native-100.jsonl',
          projectPath: '/workspace/project',
          model: 'opus',
          claudeThinkingMode: 'legacy-value',
          ampAgentMode: 'rush',
          unknownCoreField: { retained: true },
          agentSettingsById: {
            claude: envelope('claude', { claudeThinkingMode: 'existing-value' }),
            custom: envelope('custom', { customMode: 'kept' }),
          },
        },
      },
    };
    const originalSettings = {
      ui: { theme: 'system' },
      lastAgentId: 'claude',
      lastPermissionMode: 'plan',
      lastThinkingMode: 'high',
      lastClaudeThinkingMode: 'off',
      lastAmpAgentMode: 'deep',
      executionDefaults: {
        global: { claudeThinkingMode: 'on' },
        byAgent: {
          amp: {
            ampAgentMode: 'rush',
            agentSettingsById: { custom: envelope('custom', { customMode: 'kept' }) },
          },
        },
      },
    };
    const originalScheduled = {
      version: 1,
      prompts: [{
        id: 'scheduled-1',
        target: {
          type: 'new-chat',
          agentId: 'amp',
          ampAgentMode: 'rush',
          agentSettingsById: { custom: envelope('custom', { customMode: 'kept' }) },
        },
      }],
    };
    await Promise.all([
      fs.writeFile(path.join(workspaceDir, 'chats.json'), `${JSON.stringify(originalChats)}\n`),
      fs.writeFile(path.join(workspaceDir, 'project-settings.json'), `${JSON.stringify(originalSettings)}\n`),
      fs.writeFile(path.join(workspaceDir, 'scheduled-prompts.json'), `${JSON.stringify(originalScheduled)}\n`),
    ]);

    await migrateAgentIntegrationCoreRecords({
      workspaceDir,
      integrations: integrations(
        integration('claude', 'claudeThinkingMode', 'auto'),
        integration('amp', 'ampAgentMode', 'smart'),
      ),
    });

    const chats = JSON.parse(await fs.readFile(path.join(workspaceDir, 'chats.json'), 'utf8'));
    const chat = chats.sessions['100'];
    expect(chats.version).toBe(3);
    expect(chat).not.toHaveProperty('provider');
    expect(chat).not.toHaveProperty('providerSessionId');
    expect(chat).not.toHaveProperty('nativePath');
    expect(chat).not.toHaveProperty('claudeThinkingMode');
    expect(chat).not.toHaveProperty('ampAgentMode');
    expect(chat).toMatchObject({
      agentId: 'claude',
      agentSessionId: 'native-100',
      nativeSession: {
        ownerId: 'claude',
        schemaVersion: 1,
        value: { path: '/tmp/native-100.jsonl' },
      },
      unknownCoreField: { retained: true },
    });
    expect(chat.agentOwnershipEpoch).toEqual(expect.any(String));
    expect(chat.agentSettingsById).toEqual({
      claude: envelope('claude', { claudeThinkingMode: 'existing-value' }),
      amp: envelope('amp', { ampAgentMode: 'rush' }),
      custom: envelope('custom', { customMode: 'kept' }),
    });

    const settings = JSON.parse(await fs.readFile(path.join(workspaceDir, 'project-settings.json'), 'utf8'));
    expect(settings).not.toHaveProperty('lastPermissionMode');
    expect(settings).not.toHaveProperty('lastThinkingMode');
    expect(settings).not.toHaveProperty('lastClaudeThinkingMode');
    expect(settings).not.toHaveProperty('lastAmpAgentMode');
    expect(settings.executionDefaults.global).toMatchObject({
      permissionMode: 'plan',
      thinkingMode: 'high',
    });
    expect(settings.executionDefaults.global).not.toHaveProperty('claudeThinkingMode');
    expect(settings.executionDefaults.global.agentSettingsById.claude).toEqual(
      envelope('claude', { claudeThinkingMode: 'on' }),
    );
    expect(settings.executionDefaults.global.agentSettingsById.amp).toEqual(
      envelope('amp', { ampAgentMode: 'deep' }),
    );
    expect(settings.executionDefaults.byAgent.claude).toMatchObject({
      permissionMode: 'plan',
      thinkingMode: 'high',
      agentSettingsById: {
        claude: envelope('claude', { claudeThinkingMode: 'off' }),
        amp: envelope('amp', { ampAgentMode: 'deep' }),
      },
    });
    expect(settings.executionDefaults.byAgent.amp).not.toHaveProperty('ampAgentMode');
    expect(settings.executionDefaults.byAgent.amp.agentSettingsById).toMatchObject({
      amp: envelope('amp', { ampAgentMode: 'rush' }),
      custom: envelope('custom', { customMode: 'kept' }),
    });

    const scheduled = JSON.parse(await fs.readFile(path.join(workspaceDir, 'scheduled-prompts.json'), 'utf8'));
    expect(scheduled.prompts[0].target).not.toHaveProperty('ampAgentMode');
    expect(scheduled.prompts[0].target.agentSettingsById).toMatchObject({
      amp: envelope('amp', { ampAgentMode: 'rush' }),
      custom: envelope('custom', { customMode: 'kept' }),
    });
    const manifest = JSON.parse(await fs.readFile(
      path.join(workspaceDir, MIGRATION_DIR, 'manifest.json'),
      'utf8',
    ));
    expect(manifest.state).toBe('committed');

  });

  it('normalizes installed integration schemas and preserves chat parentage', async () => {
    const codexV1 = { ownerId: 'codex', schemaVersion: 1, values: {} };
    const codexV2MissingDefault = { ownerId: 'codex', schemaVersion: 2, values: {} };
    const codexV2Off = {
      ownerId: 'codex',
      schemaVersion: 2,
      values: { codexFastMode: 'off' },
    };
    const parentChat = {
      chatId: 'parent-chat',
      relation: 'fork',
      transcriptViewId: 'parent-view',
      ordinal: 7,
    };
    const chat = (agentSettingsById, overrides = {}) => ({
      agentId: 'codex',
      agentSessionId: null,
      nativeSession: null,
      projectPath: '/workspace/project',
      model: 'gpt-5.4',
      agentOwnershipEpoch: crypto.randomUUID(),
      agentSettingsById,
      ...overrides,
    });
    const originalChats = {
      version: 3,
      sessions: {
        'chat-v1': chat({ codex: codexV1 }, { parentChat }),
        'chat-v2-missing-default': chat({ codex: codexV2MissingDefault }),
        'chat-missing': chat({ custom: envelope('custom', { retained: true }) }),
      },
    };
    const originalSettings = {
      executionDefaults: {
        global: { agentSettingsById: { codex: codexV1 } },
        byAgent: {
          codex: { agentSettingsById: { codex: codexV2MissingDefault } },
        },
      },
    };
    const originalScheduled = {
      version: 1,
      prompts: [{
        id: 'scheduled-1',
        target: {
          type: 'new-chat',
          agentId: 'codex',
          agentSettingsById: { codex: codexV1 },
        },
      }],
    };
    const paths = [
      ['chats.json', originalChats],
      ['project-settings.json', originalSettings],
      ['scheduled-prompts.json', originalScheduled],
    ];
    await Promise.all(paths.map(([relativePath, value]) => (
      fs.writeFile(path.join(workspaceDir, relativePath), `${JSON.stringify(value)}\n`)
    )));
    const registry = integrations(codexIntegration());

    await migrateAgentIntegrationCoreRecords({ workspaceDir, integrations: registry });

    const chats = JSON.parse(await fs.readFile(path.join(workspaceDir, 'chats.json'), 'utf8'));
    expect(chats.sessions['chat-v1'].agentSettingsById.codex).toEqual(codexV2Off);
    expect(chats.sessions['chat-v1'].parentChat).toEqual(parentChat);
    expect(chats.sessions['chat-v2-missing-default'].agentSettingsById.codex)
      .toEqual(codexV2Off);
    expect(chats.sessions['chat-missing'].agentSettingsById).toEqual({
      codex: codexV2Off,
      custom: envelope('custom', { retained: true }),
    });
    const settings = JSON.parse(await fs.readFile(
      path.join(workspaceDir, 'project-settings.json'),
      'utf8',
    ));
    expect(settings.executionDefaults.global.agentSettingsById.codex).toEqual(codexV2Off);
    expect(settings.executionDefaults.byAgent.codex.agentSettingsById.codex).toEqual(codexV2Off);
    const scheduled = JSON.parse(await fs.readFile(
      path.join(workspaceDir, 'scheduled-prompts.json'),
      'utf8',
    ));
    expect(scheduled.prompts[0].target.agentSettingsById.codex).toEqual(codexV2Off);

    const firstPass = await Promise.all(paths.map(([relativePath]) => (
      fs.readFile(path.join(workspaceDir, relativePath))
    )));
    await migrateAgentIntegrationCoreRecords({ workspaceDir, integrations: registry });
    const secondPass = await Promise.all(paths.map(([relativePath]) => (
      fs.readFile(path.join(workspaceDir, relativePath))
    )));
    expect(secondPass).toEqual(firstPass);
  });

  it('rejects future integration schemas before replacing any core record', async () => {
    const records = [
      ['chats.json', {
        version: 3,
        sessions: {
          'chat-future': {
            agentId: 'codex',
            agentSessionId: null,
            nativeSession: null,
            projectPath: '/workspace/project',
            model: 'gpt-5.4',
            agentOwnershipEpoch: crypto.randomUUID(),
            agentSettingsById: {
              codex: { ownerId: 'codex', schemaVersion: 3, values: {} },
            },
          },
        },
      }],
      ['project-settings.json', { executionDefaults: { global: {}, byAgent: {} } }],
      ['scheduled-prompts.json', { version: 1, prompts: [] }],
    ];
    const originals = records.map(([relativePath, value]) => ({
      relativePath,
      contents: Buffer.from(`${JSON.stringify(value)}\n`),
    }));
    await Promise.all(originals.map(({ relativePath, contents }) => (
      fs.writeFile(path.join(workspaceDir, relativePath), contents)
    )));

    await expect(migrateAgentIntegrationCoreRecords({
      workspaceDir,
      integrations: integrations(codexIntegration()),
    })).rejects.toThrow('invalid codex settings');

    for (const { relativePath, contents } of originals) {
      expect(await fs.readFile(path.join(workspaceDir, relativePath))).toEqual(contents);
    }
  });

  it('discards a prepared journal before loading core records', async () => {
    const chats = Buffer.from('{"version":3,"sessions":{}}\n');
    await fs.writeFile(path.join(workspaceDir, 'chats.json'), chats);
    const journalDir = path.join(workspaceDir, MIGRATION_DIR);
    await fs.mkdir(journalDir, { recursive: true });
    await fs.writeFile(path.join(journalDir, 'manifest.json'), JSON.stringify({
      id: 'agent-integration-v1',
      state: 'prepared',
      files: [{
        relativePath: 'chats.json',
        existed: true,
        backupSha256: digest(chats),
        targetSha256: digest(chats),
      }],
    }));

    await migrateAgentIntegrationCoreRecords({ workspaceDir, integrations: integrations() });

    expect(await fs.readFile(path.join(workspaceDir, 'chats.json'))).toEqual(chats);
    await expect(fs.access(journalDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('completes an interrupted committing journal idempotently', async () => {
    const original = Buffer.from('{"version":2,"sessions":{}}\n');
    const target = Buffer.from('{"version":3,"sessions":{}}\n');
    await fs.writeFile(path.join(workspaceDir, 'chats.json'), original);
    const journalDir = path.join(workspaceDir, MIGRATION_DIR);
    await fs.mkdir(path.join(journalDir, 'backup'), { recursive: true });
    await fs.mkdir(path.join(journalDir, 'target'), { recursive: true });
    await fs.writeFile(path.join(journalDir, 'backup', 'chats.json'), original);
    await fs.writeFile(path.join(journalDir, 'target', 'chats.json'), target);
    await fs.writeFile(path.join(journalDir, 'manifest.json'), JSON.stringify({
      id: 'agent-integration-v1',
      state: 'committing',
      files: [{
        relativePath: 'chats.json',
        existed: true,
        backupSha256: digest(original),
        targetSha256: digest(target),
      }],
    }));

    await migrateAgentIntegrationCoreRecords({ workspaceDir, integrations: integrations() });

    expect(await fs.readFile(path.join(workspaceDir, 'chats.json'))).toEqual(target);
    const manifest = JSON.parse(await fs.readFile(path.join(journalDir, 'manifest.json'), 'utf8'));
    expect(manifest.state).toBe('committed');
  });

  it('rejects journal paths outside the scoped core record allowlist', async () => {
    const journalDir = path.join(workspaceDir, MIGRATION_DIR);
    await fs.mkdir(journalDir, { recursive: true });
    await fs.writeFile(path.join(journalDir, 'manifest.json'), JSON.stringify({
      id: 'agent-integration-v1',
      state: 'committing',
      files: [{
        relativePath: '../outside.json',
        existed: false,
        backupSha256: null,
        targetSha256: 'a'.repeat(64),
      }],
    }));

    await expect(migrateAgentIntegrationCoreRecords({
      workspaceDir,
      integrations: integrations(),
    })).rejects.toThrow('Invalid core migration path');
  });
});
