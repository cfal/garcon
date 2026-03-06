import { parseJsonBody } from '../lib/http-native.js';
import { getProjectBasePath } from '../config.js';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../common/models.js';
import { resolveEffectiveGenerationConfig } from '../settings/generation-effective.js';

export default function createWorkspaceRoutes(settings, providers) {
  function asPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  async function putSessionNameHandler(request) {
    try {
      const { chatId, title } = await parseJsonBody(request);
      if (!chatId || typeof chatId !== 'string') {
        return Response.json({ success: false, error: 'chatId is required' }, { status: 400 });
      }
      const trimmed = typeof title === 'string' ? title.trim() : '';
      if (!trimmed) {
        return Response.json({ success: false, error: 'title is required' }, { status: 400 });
      }
      // setSessionName emits 'session-name-changed' for broadcast wiring.
      await settings.setSessionName(chatId, trimmed);
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function getAppSettings() {
    try {
      const [ui, paths, pinnedChatIds, lastProvider, lastProjectPath, lastModel, lastPermissionMode, lastThinkingMode, authByProvider, opencodeModels] = await Promise.all([
        settings.getUiSettings(),
        settings.getPathSettings(),
        settings.getPinnedChatIds(),
        settings.getLastProvider(),
        settings.getLastProjectPath(),
        settings.getLastModel(),
        settings.getLastPermissionMode(),
        settings.getLastThinkingMode(),
        providers?.getAuthStatusMap?.() ?? Promise.resolve({
          claude: { authenticated: false },
          codex: { authenticated: false },
          opencode: { authenticated: false },
        }),
        providers?.getModels?.('opencode') ?? Promise.resolve([]),
      ]);
      const modelsByProvider = {
        claude: CLAUDE_MODELS.OPTIONS,
        codex: CODEX_MODELS.OPTIONS,
        opencode: Array.isArray(opencodeModels) ? opencodeModels : [],
      };
      const persistedChatTitle = asPlainObject(ui?.chatTitle);
      const persistedCommitMessage = asPlainObject(ui?.commitMessage);
      const uiEffective = {
        chatTitle: {
          ...persistedChatTitle,
          ...resolveEffectiveGenerationConfig({
            persisted: persistedChatTitle,
            authByProvider,
            modelsByProvider,
          }),
        },
        commitMessage: {
          ...persistedCommitMessage,
          ...resolveEffectiveGenerationConfig({
            persisted: persistedCommitMessage,
            authByProvider,
            modelsByProvider,
          }),
        },
      };
      const projectBasePath = getProjectBasePath();
      return Response.json({
        success: true,
        ui,
        uiEffective,
        paths,
        pinnedChatIds,
        lastProvider,
        lastProjectPath,
        lastModel,
        lastPermissionMode,
        lastThinkingMode,
        projectBasePath,
      });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function putAppSettings(request) {
    try {
      const body = await parseJsonBody(request);
      let ui, paths;

      if (body.ui && typeof body.ui === 'object') {
        ui = await settings.setUiSettings(body.ui);
      } else {
        ui = await settings.getUiSettings();
      }

      if (body.paths && typeof body.paths === 'object') {
        paths = await settings.setPathSettings(body.paths);
      } else {
        paths = await settings.getPathSettings();
      }

      const [pinnedChatIds] = await Promise.all([
        settings.getPinnedChatIds(),
      ]);

      return Response.json({ success: true, ui, paths, pinnedChatIds });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return {
    '/api/v1/app/session-name': { PUT: putSessionNameHandler },
    '/api/v1/app/settings': { GET: getAppSettings, PUT: putAppSettings },
  };
}
