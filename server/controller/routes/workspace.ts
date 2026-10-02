import { composeRoutes } from '../lib/compose-routes.js';
import { createTelegramRoutes } from './telegram.js';
import { createFolderRoutes } from './folders.js';
import { createSavedSearchRoutes } from './saved-searches.js';
import {
  parseUpdateChatTitleRequest,
  type UpdateChatTitleResponse,
} from '../../../common/chat-title-contracts.js';
import { parseExecutorId } from '../../../common/executors.js';
import {
  GENERATION_PROMPT_TEMPLATE_MAX_LENGTH,
  PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
} from '../../../common/generation-prompts.js';
import { isGenerationTestTarget } from '../../../common/generation-test-contracts.js';
import {
  HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT,
  HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH,
  parseHiddenBashCommandPatterns,
} from '../../../common/hidden-bash-command-patterns.js';
import { isRecord } from '../../../common/json.js';
import {
  AGENT_COMMAND_SETTING_KEYS,
  GENERATION_UI_SETTING_KEYS,
  generationSelectionExecutorError,
  normalizeAgentSwitchCompactionUiSettings,
  normalizeChatTitleUiSettings,
  normalizeCommitMessageUiSettings,
  normalizePromptRefinementUiSettings,
  normalizeTicketChatUiSettings,
  parseExecutorProjectPreferencesPatch,
  type AgentCommandsFeatureSettings,
  type RemoteFeatureSettings
} from '../../../common/settings.js';
import { TICKET_CHAT_TOKENS, ticketChatPromptError } from '../../../common/ticket-chat.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { AppTitleValidationError, sanitizeAppIdentityPatch } from '../app-title-settings.js';
import { TranscriptSearchSettingsError } from '../chats/search/settings-coordinator.js';
import type { IChatRegistry } from '../chats/store.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { disableRequestIdleTimeout } from '../lib/http-route.js';
import { withJsonBody } from '../lib/json-route.js';
import type { TelegramSettingsStore } from '../notifications/telegram-settings-store.js';
import type { TelegramNotifier } from '../notifications/telegram.js';
import { resolveGenerationContextsForSelections } from '../settings/generation-config-source.ts';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';
import { testGenerationModel } from '../settings/generation-model-test.js';
import { buildRemoteSettingsSnapshot } from '../settings/remote-snapshot.js';
import type { SettingsStore } from '../settings/store.js';
import {
  asJsonBody,
  type JsonBody,
} from './route-helpers.js';

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

export default function createWorkspaceRoutes(
  settings: SettingsStore,
  agents: AgentRegistryServiceContract,
  telegramNotifier: TelegramNotifier,
  telegramSettings: TelegramSettingsStore,
  projectBasePath: string,
  registry?: Pick<IChatRegistry, 'getChat'>,
  transcriptSearchSettings?: {
    setEnabled(
      enabled: boolean,
      patch?: Partial<RemoteFeatureSettings>,
    ): Promise<void>;
  },
): RouteMap {

  function featureEnabledPatch(
    input: Record<string, unknown>,
    key: keyof RemoteFeatureSettings,
  ): boolean | undefined | null {
    if (!('features' in input)) return undefined;
    const features = input.features;
    if (!features || typeof features !== 'object' || Array.isArray(features)) return null;
    const featureRecord = features as Record<string, unknown>;
    if (!(key in featureRecord)) return undefined;
    const feature = featureRecord[key];
    if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
      return null;
    }
    const setting = feature as Record<string, unknown>;
    if (!('enabled' in setting) || typeof setting.enabled !== 'boolean') return null;
    return setting.enabled;
  }

  function featureEnabledPatchError(key: keyof RemoteFeatureSettings): string {
    return `features.${key}.enabled must be a boolean`;
  }

  function agentCommandsPatch(
    input: Record<string, unknown>,
  ): Partial<AgentCommandsFeatureSettings> | undefined | string {
    if (!('features' in input)) return undefined;
    const features = input.features;
    if (!features || typeof features !== 'object' || Array.isArray(features)) {
      return 'features.agentCommands must be an object';
    }
    const featureRecord = features as Record<string, unknown>;
    if (!('agentCommands' in featureRecord)) return undefined;
    const raw = featureRecord.agentCommands;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return 'features.agentCommands must be an object';
    }

    const patch: Partial<AgentCommandsFeatureSettings> = {};
    const setting = raw as Record<string, unknown>;
    for (const key of AGENT_COMMAND_SETTING_KEYS) {
      if (!(key in setting)) continue;
      if (typeof setting[key] !== 'boolean') {
        return `features.agentCommands.${key} must be a boolean`;
      }
      patch[key] = setting[key];
    }
    return patch;
  }

  function sanitizeRemoteUiPatch(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const patch = { ...asJsonBody(raw) };
    if ('appIdentity' in patch) {
      patch.appIdentity = sanitizeAppIdentityPatch(patch.appIdentity);
    }
    if ('chatTitle' in patch) {
      const chatTitle = normalizeChatTitleUiSettings(patch.chatTitle);
      if (chatTitle || isEmptyObject(patch.chatTitle)) patch.chatTitle = chatTitle ?? {};
      else delete patch.chatTitle;
    }
    if ('agentSwitchCompaction' in patch) {
      const compaction = normalizeAgentSwitchCompactionUiSettings(patch.agentSwitchCompaction);
      if (compaction || isEmptyObject(patch.agentSwitchCompaction)) patch.agentSwitchCompaction = compaction ?? {};
      else delete patch.agentSwitchCompaction;
    }
    if ('commitMessage' in patch) {
      const commitMessage = normalizeCommitMessageUiSettings(patch.commitMessage);
      if (commitMessage || isEmptyObject(patch.commitMessage)) patch.commitMessage = commitMessage ?? {};
      else delete patch.commitMessage;
    }
    if ('promptRefinement' in patch) {
      const promptRefinement = normalizePromptRefinementUiSettings(patch.promptRefinement);
      if (promptRefinement || isEmptyObject(patch.promptRefinement)) patch.promptRefinement = promptRefinement ?? {};
      else delete patch.promptRefinement;
    }
    if ('ticketChat' in patch) {
      const ticketChat = normalizeTicketChatUiSettings(patch.ticketChat);
      if (ticketChat || isEmptyObject(patch.ticketChat)) patch.ticketChat = ticketChat ?? {};
      else delete patch.ticketChat;
    }
    if ('hiddenBashCommandPatterns' in patch) {
      const patterns = parseHiddenBashCommandPatterns(patch.hiddenBashCommandPatterns);
      if (patterns !== null) patch.hiddenBashCommandPatterns = patterns;
      else delete patch.hiddenBashCommandPatterns;
    }
    const notifications = asJsonBody(patch.notifications);
    const rawTelegram = notifications.telegram;
    if (rawTelegram && typeof rawTelegram === 'object' && !Array.isArray(rawTelegram)) {
      const notificationTelegram = asJsonBody(rawTelegram);
      const telegram: Record<string, boolean> = {};
      if (typeof notificationTelegram.enabled === 'boolean') {
        telegram.enabled = notificationTelegram.enabled;
      }
      patch.notifications = Object.keys(telegram).length > 0 ? { telegram } : {};
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  function generationPromptPatchError(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const ui = raw as Record<string, unknown>;
    for (const target of ['commitMessage', 'promptRefinement'] as const) {
      const value = ui[target];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const targetPatch = value as Record<string, unknown>;
      if (!Object.hasOwn(targetPatch, 'customPrompt')) continue;
      if (typeof targetPatch.customPrompt !== 'string') {
        return `${target}.customPrompt must be a string.`;
      }
      if (targetPatch.customPrompt.length > GENERATION_PROMPT_TEMPLATE_MAX_LENGTH) {
        return `${target}.customPrompt must be at most ${GENERATION_PROMPT_TEMPLATE_MAX_LENGTH} characters.`;
      }
      if (
        target === 'promptRefinement'
        && targetPatch.customPrompt.trim()
        && !targetPatch.customPrompt.includes(PROMPT_REFINEMENT_USER_PROMPT_TOKEN)
      ) {
        return `promptRefinement.customPrompt must include ${PROMPT_REFINEMENT_USER_PROMPT_TOKEN}.`;
      }
    }
    const ticketChat = ui.ticketChat;
    if (isRecord(ticketChat) && Object.hasOwn(ticketChat, 'customPrompt')) {
      if (typeof ticketChat.customPrompt !== 'string') return 'ticketChat.customPrompt must be a string.';
      const error = ticketChatPromptError(ticketChat.customPrompt);
      if (error === 'too-long') {
        return `ticketChat.customPrompt must be at most ${GENERATION_PROMPT_TEMPLATE_MAX_LENGTH} characters.`;
      }
      if (error === 'missing-ticket-id') {
        return `ticketChat.customPrompt must include ${TICKET_CHAT_TOKENS.id}.`;
      }
      if (error === 'unknown-variable') {
        return `ticketChat.customPrompt supports only ${Object.values(TICKET_CHAT_TOKENS).join(', ')}.`;
      }
    }
    return null;
  }

  function hiddenBashCommandPatternsPatchError(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const ui = raw as Record<string, unknown>;
    if (
      'hiddenBashCommandPatterns' in ui
      && parseHiddenBashCommandPatterns(ui.hiddenBashCommandPatterns) === null
    ) {
      return `ui.hiddenBashCommandPatterns must contain at most ${HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT} valid regex or glob patterns of at most ${HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH} characters each`;
    }
    return null;
  }

  async function assertGenerationThinkingModePatchesSupported(
    uiPatch: Record<string, unknown>,
  ): Promise<void> {
    const saved = settings.getUiSettings();
    const selections = GENERATION_UI_SETTING_KEYS.flatMap((key) => {
      const selection = asJsonBody(uiPatch[key]);
      if (!Object.hasOwn(selection, 'thinkingMode')) return [];
      const previous = saved[key];
      if (
        typeof selection.agentId === 'string'
        && selection.agentId === previous?.agentId
        && parseExecutorId(selection.executorId) === parseExecutorId(previous.executorId)
        && selection.thinkingMode === (previous.thinkingMode ?? 'none')
      ) return [];
      return [selection];
    });
    if (selections.length === 0) return;

    const contexts = await resolveGenerationContextsForSelections(agents, selections);
    for (const [index, selection] of selections.entries()) {
      const resolved = resolveEffectiveGenerationUiConfig({
        persisted: selection,
        ...contexts[index],
      });
      if (!resolved.agentId) continue;
      agents.assertExecutionModeSelectionSupported(resolved.agentId, {
        executorId: resolved.executorId,
        thinkingMode: resolved.thinkingMode,
      });
    }
  }

  async function putSessionNameHandler(body: JsonBody): Promise<Response> {
    try {
      const request = parseUpdateChatTitleRequest(asJsonBody(body));
      if (!request) {
        return jsonError('Invalid chat title request', 400, 'VALIDATION_FAILED', false);
      }
      if (registry && !registry.getChat(request.chatId)) {
        return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      }
      const result = await settings.setSessionName(request.chatId, request.title);
      return Response.json({
        success: true,
        chatId: request.chatId,
        title: result.title,
        changed: result.changed,
      } satisfies UpdateChatTitleResponse);
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function getAppSettings(): Promise<Response> {
    try {
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
      return Response.json(snapshot);
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function putAppSettings(
    body: JsonBody,
    request: Request,
    _url: URL,
    server?: unknown,
  ): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const pathPatch = asJsonBody(input.paths);
      if (pathPatch.byExecutor !== undefined && !parseExecutorProjectPreferencesPatch(pathPatch.byExecutor)) {
        return jsonError('Invalid executor project preferences.', 400, 'INVALID_REMOTE_SETTINGS', false);
      }
      const generationUi = asJsonBody(input.ui);
      for (const key of GENERATION_UI_SETTING_KEYS) {
        const error = generationSelectionExecutorError(generationUi[key]);
        if (error) return jsonError(error, 400, 'INVALID_REMOTE_SETTINGS', false);
      }
      const promptPatchError = generationPromptPatchError(input.ui);
      if (promptPatchError) {
        return jsonError(promptPatchError, 400, 'INVALID_REMOTE_SETTINGS', false);
      }
      const bashPatternsError = hiddenBashCommandPatternsPatchError(input.ui);
      if (bashPatternsError) {
        return jsonError(bashPatternsError, 400, 'INVALID_REMOTE_SETTINGS', false);
      }
      const uiPatch = sanitizeRemoteUiPatch(input.ui);
      const transcriptSearchEnabled = featureEnabledPatch(input, 'transcriptSearch');
      const commandsPatch = agentCommandsPatch(input);
      if (transcriptSearchEnabled === null) {
        return jsonError(
          featureEnabledPatchError('transcriptSearch'),
          400,
          'INVALID_REMOTE_SETTINGS',
          false,
        );
      }
      if (typeof commandsPatch === 'string') {
        return jsonError(
          commandsPatch,
          400,
          'INVALID_REMOTE_SETTINGS',
          false,
        );
      }
      if (uiPatch) await assertGenerationThinkingModePatchesSupported(uiPatch);
      const featurePatch: Partial<RemoteFeatureSettings> = {};
      if (commandsPatch && Object.keys(commandsPatch).length > 0) {
        featurePatch.agentCommands = {
          ...settings.getFeatureSettings().agentCommands,
          ...commandsPatch,
        };
      }
      if (transcriptSearchEnabled !== undefined) {
        if (transcriptSearchSettings) {
          disableRequestIdleTimeout(request, server);
          await transcriptSearchSettings.setEnabled(transcriptSearchEnabled, featurePatch);
        } else {
          await settings.setFeatureSettings({
            ...featurePatch,
            transcriptSearch: { enabled: transcriptSearchEnabled },
          });
        }
      } else if (featurePatch.agentCommands) {
        await settings.setFeatureSettings(featurePatch);
      }
      if (uiPatch) {
        await settings.setUiSettings(uiPatch);
      }

      if (input.paths && typeof input.paths === 'object' && !Array.isArray(input.paths)) {
        await settings.setPathSettings(input.paths as Record<string, unknown>);
      }

      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      if (error instanceof TranscriptSearchSettingsError) {
        return jsonError(error.message, 500, error.code, false);
      }
      if (error instanceof AppTitleValidationError) {
        return Response.json({
          success: false,
          error: error.message,
          errorCode: error.errorCode,
        }, { status: error.status });
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function postGenerationModelTest(body: JsonBody, request: Request): Promise<Response> {
    const input = asJsonBody(body);
    if (!isGenerationTestTarget(input.target)) {
      return jsonError(
        'Invalid generation test target.',
        400,
        'GENERATION_TEST_INVALID_TARGET',
        false,
      );
    }
    if (typeof input.configurationKey !== 'string' || input.configurationKey.length > 2_048) {
      return jsonError(
        'Invalid generation test configuration.',
        400,
        'GENERATION_TEST_INVALID_CONFIGURATION',
        false,
      );
    }

    try {
      return Response.json(await testGenerationModel({
        target: input.target,
        configurationKey: input.configurationKey,
        settings,
        agents,
        signal: request.signal,
      }));
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  return composeRoutes(
    {
      '/api/v1/app/session-name': { PUT: withJsonBody(putSessionNameHandler) },
      '/api/v1/app/settings': { GET: getAppSettings, PUT: withJsonBody(putAppSettings) },
      '/api/v1/app/generation/test': { POST: withJsonBody(postGenerationModelTest) },
    },
    createTelegramRoutes(settings, agents, telegramNotifier, telegramSettings, projectBasePath),
    createFolderRoutes(settings),
    createSavedSearchRoutes(settings),
  );
}
