import {
  DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS,
  parseAgentSwitchContextWindowTokens,
} from '../../../common/handoff-sizing.js';
import {
  DEFAULT_REMOTE_FEATURE_SETTINGS,
  parseExecutorProjectPreferences,
  type RemoteSettingsSnapshot,
  type RemoteUiEffectiveSettings,
} from '../../../common/settings.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { TelegramPublicStatus, TelegramSettingsStore } from '../notifications/telegram-settings-store.js';
import { resolveGenerationContextsForSelections } from './generation-config-source.ts';
import { resolveEffectiveGenerationUiConfig, resolveGenerationUiSnapshot } from './generation-effective.js';
import { normalizeUiSettings } from './settings-shared.js';
import { sortedPinnedProjectPaths } from './startup-recents.js';
import type { SettingsStore } from './store.js';

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const emptyTelegramStatus: TelegramPublicStatus = {
  botTokenAvailable: false,
  botUsername: null,
  botFirstName: null,
  recipientUsername: null,
  recipientDisplayName: null,
  recipientLinked: false,
  pendingLink: false,
  linkUrl: null,
};

function resolveUntoggledGenerationUiConfig<
  T extends 'commitMessage' | 'promptRefinement',
>(
  input: Parameters<typeof resolveEffectiveGenerationUiConfig>[0],
): RemoteUiEffectiveSettings[T] {
  const effective = resolveGenerationUiSnapshot(input);
  if (!effective) return undefined;
  const config = { ...effective };
  delete (config as { enabled?: boolean }).enabled;
  return config as NonNullable<RemoteUiEffectiveSettings[T]>;
}

export async function buildRemoteSettingsSnapshot({
  settings,
  agents,
  telegramSettings,
  projectBasePath,
}: {
  settings: SettingsStore;
  agents: Pick<AgentRegistryServiceContract, 'getAgentAuthStatusMap' | 'getAgentReadinessMap' | 'getAgentCatalogEntries'>;
  telegramSettings?: TelegramSettingsStore | null;
  projectBasePath: string;
}): Promise<RemoteSettingsSnapshot> {
  const settingsSource = settings.getRemoteSettingsSnapshotSource();
  const version = settingsSource.version;
  const features = settingsSource.features ?? structuredClone(DEFAULT_REMOTE_FEATURE_SETTINGS);
  const ui = normalizeUiSettings(settingsSource.ui);
  const paths = settingsSource.paths;
  const pinnedChatIds = settingsSource.pinnedChatIds;
  const recentAgentSettings = settingsSource.recentAgentSettings;
  const executionDefaults = settingsSource.executionDefaults;
  const [chatTitleContext, compactionContext, commitMessageContext, promptRefinementContext] =
    await resolveGenerationContextsForSelections(
      agents,
      [ui?.chatTitle, ui?.agentSwitchCompaction, ui?.commitMessage, ui?.promptRefinement],
    );

  const persistedCompaction = asPlainObject(ui?.agentSwitchCompaction);
  const effectiveCompaction = resolveGenerationUiSnapshot({
    persisted: persistedCompaction,
    ...compactionContext,
  });
  const uiEffective = {
    chatTitle: resolveGenerationUiSnapshot({
      persisted: asPlainObject(ui?.chatTitle),
      ...chatTitleContext,
    }),
    agentSwitchCompaction: effectiveCompaction ? {
      ...effectiveCompaction,
      enabled: persistedCompaction.enabled === true,
      contextWindowTokens:
        parseAgentSwitchContextWindowTokens(effectiveCompaction.contextWindowTokens)
        ?? DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS,
    } : undefined,
    commitMessage: resolveUntoggledGenerationUiConfig<'commitMessage'>({
      persisted: asPlainObject(ui?.commitMessage),
      ...commitMessageContext,
    }),
    promptRefinement: resolveUntoggledGenerationUiConfig<'promptRefinement'>({
      persisted: asPlainObject(ui?.promptRefinement),
      ...promptRefinementContext,
    }),
  };

  return {
    version,
    features,
    ui: asPlainObject(ui),
    uiEffective,
    paths: {
      pinnedProjectPaths: sortedPinnedProjectPaths(paths?.pinnedProjectPaths),
      browseStartPath: typeof paths?.browseStartPath === 'string' ? paths.browseStartPath : '',
      recentProjectPaths: Array.isArray(paths?.recentProjectPaths)
        ? paths.recentProjectPaths.filter((entry): entry is string => typeof entry === 'string')
        : [],
      ...(paths?.byExecutor === undefined ? {} : { byExecutor: parseExecutorProjectPreferences(paths.byExecutor) ?? {} }),
    },
    pinnedChatIds: Array.isArray(pinnedChatIds) ? pinnedChatIds : [],
    recentAgentSettings,
    executionDefaults,
    projectBasePath,
    telegram: telegramSettings?.getPublicStatus?.() ?? emptyTelegramStatus,
  };
}
