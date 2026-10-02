import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import type { SettingsStore } from '../settings/store.js';
import { sanitizeFolderFilter } from '../settings/settings-shared.js';
import type { ChatFolder } from '../settings/types.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';

export function createFolderRoutes(settings: Pick<SettingsStore,
  'getFolders' | 'addFolder' | 'updateFolder' | 'removeFolder'
>): RouteMap {
  async function getFolders(): Promise<Response> {
    try {
      const folders = await settings.getFolders();
      return Response.json({ folders });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postFolder(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const name = String(input.name || '').trim();
      if (!name) {
        return jsonError('name is required', 400);
      }
      const folder = {
        id: crypto.randomUUID(),
        name,
        filter: sanitizeFolderFilter(input.filter),
        createdAt: new Date().toISOString(),
      };
      const result = await settings.addFolder(folder);
      return Response.json({ success: true, folder: result });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function putFolder(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const folderId = String(input.id || '').trim();
      if (!folderId) {
        return jsonError('id is required', 400);
      }
      const patch: Partial<ChatFolder> = {};
      if (typeof input.name === 'string') {
        const name = input.name.trim();
        if (!name) {
          return jsonError('name is required', 400);
        }
        patch.name = name;
      }
      if (input.filter && typeof input.filter === 'object') patch.filter = sanitizeFolderFilter(input.filter);
      const result = await settings.updateFolder(folderId, patch);
      return Response.json({ success: true, folder: result });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function deleteFolder(_request: Request, url: URL): Promise<Response> {
    const folderId = url.searchParams.get('id');
    if (!folderId) {
      return jsonError('id query parameter is required', 400);
    }
    try {
      const removed = await settings.removeFolder(folderId);
      if (!removed) {
        return jsonError('Folder not found', 404, 'FOLDER_NOT_FOUND');
      }
      return Response.json({ success: true });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  return {
    '/api/v1/app/folders': { GET: getFolders, POST: withJsonBody(postFolder), PUT: withJsonBody(putFolder), DELETE: deleteFolder },
  };
}
