import { describe, expect, it } from 'bun:test';
import {
  normalizeAgentSwitchCompactionUiSettings,
  normalizeChatTitleUiSettings,
  normalizeCommitMessageUiSettings,
  normalizePromptRefinementUiSettings,
  normalizeRemoteFeatureSettings,
  normalizeRemoteSettingsSnapshot,
} from '../settings.js';
import { GENERATION_PROMPT_TEMPLATE_MAX_LENGTH } from '../generation-prompts.js';

describe('generation settings contracts', () => {
  it('defaults agent commands to enabled and normalizes partial command settings', () => {
    expect(normalizeRemoteFeatureSettings(undefined)).toEqual({
      transcriptSearch: { enabled: false },
      agentCommands: {
        enabled: true,
        chatIdDiscovery: true,
        sendMessage: true,
      },
    });
    expect(normalizeRemoteFeatureSettings({
      agentCommands: { enabled: false, sendMessage: false },
    }).agentCommands).toEqual({
      enabled: false,
      chatIdDiscovery: true,
      sendMessage: false,
    });
  });

  it('migrates legacy discovery only when the agent command object is absent or invalid', () => {
    expect(normalizeRemoteFeatureSettings({
      chatIdDiscovery: { enabled: false },
    }).agentCommands).toEqual({
      enabled: true,
      chatIdDiscovery: false,
      sendMessage: true,
    });
    expect(normalizeRemoteFeatureSettings({
      agentCommands: { enabled: true },
      chatIdDiscovery: { enabled: false },
    }).agentCommands.chatIdDiscovery).toBe(true);
    expect(normalizeRemoteFeatureSettings({
      agentCommands: 'invalid',
      chatIdDiscovery: { enabled: false },
    }).agentCommands.chatIdDiscovery).toBe(false);
  });

  it('accepts only supported compaction context-window presets', () => {
    for (const contextWindowTokens of [200_000, 500_000, 1_000_000]) {
      expect(normalizeAgentSwitchCompactionUiSettings({ contextWindowTokens }))
        .toEqual({ contextWindowTokens });
    }

    for (const contextWindowTokens of ['500000', 500_000.5, 250_000, null]) {
      expect(normalizeAgentSwitchCompactionUiSettings({
        enabled: true,
        contextWindowTokens,
      })).toEqual({ enabled: true });
    }
  });

  it('keeps title settings limited to title generation fields', () => {
    expect(normalizeChatTitleUiSettings({
      enabled: true,
      agentId: 'codex',
      model: 'gpt-5.5',
      thinkingMode: 'medium',
      customPrompt: 'Unsupported title prompt',
      useCommonDirPrefix: true,
    })).toEqual({
      enabled: true,
      agentId: 'codex',
      model: 'gpt-5.5',
      thinkingMode: 'medium',
    });
  });

  it('keeps commit-only prompt fields while dropping title-only enabled state', () => {
    expect(normalizeCommitMessageUiSettings({
      enabled: false,
      agentId: 'codex',
      model: 'gpt-5.5',
      customPrompt: 'Summarize the diff',
      useCommonDirPrefix: true,
    })).toEqual({
      agentId: 'codex',
      model: 'gpt-5.5',
      customPrompt: 'Summarize the diff',
      useCommonDirPrefix: true,
    });
  });

  it('keeps refinement prompt fields while dropping unrelated target fields', () => {
    expect(normalizePromptRefinementUiSettings({
      enabled: false,
      agentId: 'codex',
      model: 'gpt-5.5',
      customPrompt: 'Refine {{USER_PROMPT}}',
      useCommonDirPrefix: true,
    })).toEqual({
      agentId: 'codex',
      model: 'gpt-5.5',
      customPrompt: 'Refine {{USER_PROMPT}}',
    });
  });

  it('drops oversized prompt templates without losing valid selection fields', () => {
    const oversized = 'x'.repeat(GENERATION_PROMPT_TEMPLATE_MAX_LENGTH + 1);
    expect(normalizeCommitMessageUiSettings({ agentId: 'codex', customPrompt: oversized }))
      .toEqual({ agentId: 'codex' });
    expect(normalizePromptRefinementUiSettings({ agentId: 'codex', customPrompt: oversized }))
      .toEqual({ agentId: 'codex' });
  });

  it('strips commit-only fields from persisted and effective title snapshots', () => {
    const snapshot = normalizeRemoteSettingsSnapshot({
      version: 1,
      features: { transcriptSearch: { enabled: false } },
      ui: {
        chatTitle: {
          enabled: true,
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'medium',
          customPrompt: 'Unsupported title prompt',
          useCommonDirPrefix: true,
        },
        commitMessage: {
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'medium',
          customPrompt: 'Summarize the diff',
          useCommonDirPrefix: true,
        },
        promptRefinement: {
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'medium',
          customPrompt: 'Refine {{USER_PROMPT}}',
          enabled: false,
          useCommonDirPrefix: true,
        },
      },
      uiEffective: {
        chatTitle: {
          enabled: true,
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'medium',
          customPrompt: 'Unsupported title prompt',
          useCommonDirPrefix: true,
        },
        commitMessage: {
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'medium',
          customPrompt: 'Summarize the diff',
          useCommonDirPrefix: true,
        },
        promptRefinement: {
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'medium',
          customPrompt: 'Refine {{USER_PROMPT}}',
          enabled: false,
          useCommonDirPrefix: true,
        },
      },
      paths: {
        pinnedProjectPaths: [],
        browseStartPath: '',
        recentProjectPaths: [],
      },
      pinnedChatIds: [],
      recentAgentSettings: [],
      executionDefaults: {
        global: {
          permissionMode: 'default',
          thinkingMode: 'none',
          agentSettingsById: {},
        },
        byAgent: {},
      },
      projectBasePath: '',
      telegram: {
        botTokenAvailable: false,
        botUsername: null,
        botFirstName: null,
        recipientUsername: null,
        recipientDisplayName: null,
        recipientLinked: false,
        pendingLink: false,
        linkUrl: null,
      },
    });

    expect(snapshot?.ui.chatTitle).not.toHaveProperty('customPrompt');
    expect(snapshot?.ui.chatTitle).not.toHaveProperty('useCommonDirPrefix');
    expect(snapshot?.uiEffective.chatTitle).not.toHaveProperty('customPrompt');
    expect(snapshot?.uiEffective.chatTitle).not.toHaveProperty('useCommonDirPrefix');
    expect(snapshot?.ui.commitMessage).toMatchObject({
      customPrompt: 'Summarize the diff',
      useCommonDirPrefix: true,
    });
    expect(snapshot?.uiEffective.commitMessage).toMatchObject({
      customPrompt: 'Summarize the diff',
      useCommonDirPrefix: true,
    });
    expect(snapshot?.ui.promptRefinement).toEqual({
      agentId: 'codex',
      model: 'gpt-5.5',
      thinkingMode: 'medium',
      customPrompt: 'Refine {{USER_PROMPT}}',
    });
    expect(snapshot?.uiEffective.promptRefinement).toEqual({
      agentId: 'codex',
      model: 'gpt-5.5',
      thinkingMode: 'medium',
      customPrompt: 'Refine {{USER_PROMPT}}',
    });
  });

  it('requires a supported context window in effective compaction settings', () => {
    const base = {
      version: 1,
      features: { transcriptSearch: { enabled: false } },
      ui: {},
      paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
      pinnedChatIds: [],
      recentAgentSettings: [],
      executionDefaults: {
        global: {
          permissionMode: 'default',
          thinkingMode: 'none',
          agentSettingsById: {},
        },
        byAgent: {},
      },
      projectBasePath: '',
      telegram: {
        botTokenAvailable: false,
        botUsername: null,
        botFirstName: null,
        recipientUsername: null,
        recipientDisplayName: null,
        recipientLinked: false,
        pendingLink: false,
        linkUrl: null,
      },
    };
    const compaction = {
      enabled: true,
      agentId: 'codex',
      model: 'gpt-5.5',
      thinkingMode: 'medium',
    };

    for (const contextWindowTokens of [200_000, 500_000, 1_000_000]) {
      expect(normalizeRemoteSettingsSnapshot({
        ...base,
        uiEffective: {
          agentSwitchCompaction: { ...compaction, contextWindowTokens },
        },
      })?.uiEffective.agentSwitchCompaction?.contextWindowTokens)
        .toBe(contextWindowTokens);
    }

    for (const contextWindowTokens of [undefined, '500000', 500_000.5, 250_000, null]) {
      expect(normalizeRemoteSettingsSnapshot({
        ...base,
        uiEffective: {
          agentSwitchCompaction: { ...compaction, contextWindowTokens },
        },
      })?.uiEffective.agentSwitchCompaction).toBeUndefined();
    }
  });
});

describe('remote hidden bash command settings', () => {
  function makeSnapshot(ui) {
    return {
      version: 1,
      features: { transcriptSearch: { enabled: false } },
      ui,
      uiEffective: {},
      paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
      pinnedChatIds: [],
      recentAgentSettings: [],
      executionDefaults: {
        global: {
          permissionMode: 'default',
          thinkingMode: 'none',
          agentSettingsById: {},
        },
        byAgent: {},
      },
      projectBasePath: '',
      telegram: {
        botTokenAvailable: false,
        botUsername: null,
        botFirstName: null,
        recipientUsername: null,
        recipientDisplayName: null,
        recipientLinked: false,
        pendingLink: false,
        linkUrl: null,
      },
    };
  }

  it('normalizes and deduplicates the canonical list', () => {
    const snapshot = normalizeRemoteSettingsSnapshot(makeSnapshot({
      hiddenBashCommandPatterns: [
        { pattern: 'git *', mode: 'glob' },
        { pattern: '^cargo', mode: 'regex' },
        { pattern: 'git *', mode: 'glob' },
      ],
    }));

    expect(snapshot?.ui.hiddenBashCommandPatterns).toEqual([
      { pattern: 'git *', mode: 'glob' },
      { pattern: '^cargo', mode: 'regex' },
    ]);
  });

  it('drops a malformed optional list without rejecting the snapshot', () => {
    const snapshot = normalizeRemoteSettingsSnapshot(makeSnapshot({
      pinnedInsertPosition: 'bottom',
      hiddenBashCommandPatterns: [{ pattern: '([unclosed', mode: 'regex' }],
    }));

    expect(snapshot?.ui).toEqual({ pinnedInsertPosition: 'bottom' });
  });
});
