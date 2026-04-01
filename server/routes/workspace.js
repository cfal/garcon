import { parseJsonBody } from '../lib/http-request.js';
import { getProjectBasePath, getTelegramBotToken } from '../config.js';
import { AMP_MODELS, CLAUDE_MODELS, CODEX_MODELS, FACTORY_MODELS } from '../../common/models.js';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';

export default function createWorkspaceRoutes(settings, providers, telegramNotifier) {
  function asPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  const FILTER_KEYS = ['textTokens', 'tags', 'providers', 'models'];
  const VALID_FILTER_STATUS = new Set(['active', 'unread']);
	function sanitizeFilter(raw) {
    const empty = { textTokens: [], tags: [], providers: [], models: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const out = {};
		for (const key of FILTER_KEYS) {
			out[key] = Array.isArray(raw[key])
        ? raw[key].filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
				: [];
    }
		if (typeof raw.status === 'string') {
			const status = raw.status.trim();
			if (VALID_FILTER_STATUS.has(status)) out.status = status;
		}
		return out;
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
      const [ui, paths, pinnedChatIds, lastProvider, lastProjectPath, lastModel, lastPermissionMode, lastThinkingMode, lastClaudeThinkingMode, lastAmpAgentMode, authByProvider, opencodeModels, factoryModels] = await Promise.all([
        settings.getUiSettings(),
        settings.getPathSettings(),
        settings.getPinnedChatIds(),
        settings.getLastProvider(),
        settings.getLastProjectPath(),
        settings.getLastModel(),
        settings.getLastPermissionMode(),
        settings.getLastThinkingMode(),
        settings.getLastClaudeThinkingMode(),
        settings.getLastAmpAgentMode(),
        providers?.getAuthStatusMap?.() ?? Promise.resolve({
          claude: { authenticated: false },
          codex: { authenticated: false },
          opencode: { authenticated: false },
          amp: { authenticated: false },
          factory: { authenticated: false },
        }),
        providers?.getModels?.('opencode') ?? Promise.resolve([]),
        providers?.getModels?.('factory') ?? Promise.resolve([]),
      ]);
      const modelsByProvider = {
        claude: CLAUDE_MODELS.OPTIONS,
        codex: CODEX_MODELS.OPTIONS,
        opencode: Array.isArray(opencodeModels) ? opencodeModels : [],
        amp: AMP_MODELS.OPTIONS,
        factory: Array.isArray(factoryModels) ? factoryModels : FACTORY_MODELS.OPTIONS,
      };
      const uiEffective = {
        chatTitle: resolveEffectiveGenerationUiConfig({
          persisted: asPlainObject(ui?.chatTitle),
          authByProvider,
          modelsByProvider,
        }),
        commitMessage: resolveEffectiveGenerationUiConfig({
          persisted: asPlainObject(ui?.commitMessage),
          authByProvider,
          modelsByProvider,
        }),
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
        lastClaudeThinkingMode,
        lastAmpAgentMode,
        projectBasePath,
        telegramBotTokenAvailable: Boolean(getTelegramBotToken()),
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

  async function postTelegramTest(request) {
    try {
      if (!telegramNotifier?.isConfigured) {
        return Response.json({ success: false, error: 'GARCON_TELEGRAM_BOT_TOKEN is not set' }, { status: 400 });
      }
      const body = await parseJsonBody(request);
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' }, { status: 400 });
      }
      const ok = await telegramNotifier.send(chatId, 'Garcon: test notification. Your Telegram integration is working.');
      if (!ok) {
        return Response.json({ success: false, error: 'Telegram delivery failed. Check your bot token and chat ID.' }, { status: 502 });
      }
      return Response.json({ success: true });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function getFolders() {
    try {
      const folders = await settings.getFolders();
      return Response.json({ folders });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function postFolder(request) {
    try {
      const body = await parseJsonBody(request);
      const name = String(body.name || '').trim();
      if (!name) {
        return Response.json({ success: false, error: 'name is required' }, { status: 400 });
      }
      const folder = {
        id: crypto.randomUUID(),
        name,
        filter: sanitizeFilter(body.filter),
        createdAt: new Date().toISOString(),
      };
      const result = await settings.addFolder(folder);
      return Response.json({ success: true, folder: result });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function putFolder(request) {
    try {
      const body = await parseJsonBody(request);
      const folderId = String(body.id || '').trim();
      if (!folderId) {
        return Response.json({ success: false, error: 'id is required' }, { status: 400 });
      }
      const patch = {};
      if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (!name) {
          return Response.json({ success: false, error: 'name is required' }, { status: 400 });
        }
        patch.name = name;
      }
      if (body.filter && typeof body.filter === 'object') patch.filter = sanitizeFilter(body.filter);
      const result = await settings.updateFolder(folderId, patch);
      return Response.json({ success: true, folder: result });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  async function deleteFolder(_request, url) {
    const folderId = url.searchParams.get('id');
    if (!folderId) {
      return Response.json({ success: false, error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      const removed = await settings.removeFolder(folderId);
      if (!removed) {
        return Response.json({ success: false, error: 'Folder not found' }, { status: 404 });
      }
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return {
    '/api/v1/app/session-name': { PUT: putSessionNameHandler },
    '/api/v1/app/settings': { GET: getAppSettings, PUT: putAppSettings },
    '/api/v1/app/telegram/test': { POST: postTelegramTest },
    '/api/v1/app/folders': { GET: getFolders, POST: postFolder, PUT: putFolder, DELETE: deleteFolder },
  };
}
