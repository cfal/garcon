import { describe, expect, it } from 'bun:test';
import {
  normalizeChatTitleUiSettings,
  normalizeCommitMessageUiSettings,
  normalizeRemoteSettingsSnapshot,
} from '../settings.js';

describe('generation settings contracts', () => {
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
  });
});
