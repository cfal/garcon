import { parseJsonBody } from '../lib/http-native.js';
import { getProjectBasePath } from '../config.js';

export default function createWorkspaceRoutes(settings) {

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
      const [ui, paths, pinnedChatIds, lastPermissionMode, lastThinkingMode] = await Promise.all([
        settings.getUiSettings(),
        settings.getPathSettings(),
        settings.getPinnedChatIds(),
        settings.getLastPermissionMode(),
        settings.getLastThinkingMode(),
      ]);
      const projectBasePath = getProjectBasePath();
      return Response.json({ success: true, ui, paths, pinnedChatIds, lastPermissionMode, lastThinkingMode, projectBasePath });
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

      if (typeof body.lastPermissionMode === 'string') {
        await settings.setLastPermissionMode(body.lastPermissionMode);
      }
      if (typeof body.lastThinkingMode === 'string') {
        await settings.setLastThinkingMode(body.lastThinkingMode);
      }

      const [pinnedChatIds, lastPermissionMode, lastThinkingMode] = await Promise.all([
        settings.getPinnedChatIds(),
        settings.getLastPermissionMode(),
        settings.getLastThinkingMode(),
      ]);

      return Response.json({ success: true, ui, paths, pinnedChatIds, lastPermissionMode, lastThinkingMode });
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
