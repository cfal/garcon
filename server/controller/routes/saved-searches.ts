import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import type { SettingsStore } from '../settings/store.js';
import type { SavedChatSearch } from '../settings/types.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';

interface SavedSearchInput {
  title: string | null;
  query: string;
  showAsSidebarPill: boolean;
  showInSidebarMenu: boolean;
  showInSearchDialog: boolean;
}

export function createSavedSearchRoutes(settings: Pick<SettingsStore,
  'getSavedSearches' | 'addSavedSearch' | 'updateSavedSearch' | 'removeSavedSearch' | 'reorderSavedSearches'
>): RouteMap {
  function sanitizeSavedSearchInput(raw: unknown): SavedSearchInput | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const source = asJsonBody(raw);
    const titleRaw = typeof source.title === 'string' ? source.title.trim() : '';
    const query = typeof source.query === 'string' ? source.query.trim() : '';
    const showAsSidebarPill = source.showAsSidebarPill === true;
    const showInSidebarMenu = source.showInSidebarMenu === true;
    const showInSearchDialog = source.showInSearchDialog === true;
    return { title: titleRaw || null, query, showAsSidebarPill, showInSidebarMenu, showInSearchDialog };
  }

  function hasAnySavedSearchVisibility(input: Pick<SavedSearchInput, 'showAsSidebarPill' | 'showInSidebarMenu' | 'showInSearchDialog'>): boolean {
    return input.showAsSidebarPill || input.showInSidebarMenu || input.showInSearchDialog;
  }

  async function getSavedSearches(): Promise<Response> {
    try {
      const savedSearches = await settings.getSavedSearches();
      return Response.json({ savedSearches });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postSavedSearch(body: JsonBody): Promise<Response> {
    try {
      const input = sanitizeSavedSearchInput(body);
      if (!input || !input.query) {
        return Response.json({ success: false, error: 'query is required' }, { status: 400 });
      }
      if (!hasAnySavedSearchVisibility(input)) {
        return Response.json({ success: false, error: 'at least one visibility option is required' }, { status: 400 });
      }
      const now = new Date().toISOString();
      const savedSearch = {
        id: crypto.randomUUID(),
        title: input.title,
        query: input.query,
        showAsSidebarPill: input.showAsSidebarPill,
        showInSidebarMenu: input.showInSidebarMenu,
        showInSearchDialog: input.showInSearchDialog,
        createdAt: now,
        updatedAt: now,
      };
      const result = await settings.addSavedSearch(savedSearch);
      return Response.json({ success: true, savedSearch: result });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function putSavedSearch(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const id = String(input.id || '').trim();
      if (!id) {
        return jsonError('id is required', 400);
      }
      const patch: Partial<SavedChatSearch> = {};
      if (typeof input.title === 'string') {
        const title = input.title.trim();
        patch.title = title || null;
      }
      if (typeof input.query === 'string') {
        const query = input.query.trim();
        if (!query) {
          return jsonError('query must not be empty', 400);
        }
        patch.query = query;
      }
      if (typeof input.showAsSidebarPill === 'boolean') {
        patch.showAsSidebarPill = input.showAsSidebarPill;
      }
      if (typeof input.showInSidebarMenu === 'boolean') {
        patch.showInSidebarMenu = input.showInSidebarMenu;
      }
      if (typeof input.showInSearchDialog === 'boolean') {
        patch.showInSearchDialog = input.showInSearchDialog;
      }
      const existing = (await settings.getSavedSearches()).find((s) => s.id === id);
      if (!existing) {
        return jsonError('Saved search not found', 404, 'SAVED_SEARCH_NOT_FOUND');
      }
      const mergedVisibility = {
        showAsSidebarPill: patch.showAsSidebarPill !== undefined ? patch.showAsSidebarPill : existing.showAsSidebarPill,
        showInSidebarMenu: patch.showInSidebarMenu !== undefined ? patch.showInSidebarMenu : existing.showInSidebarMenu,
        showInSearchDialog: patch.showInSearchDialog !== undefined ? patch.showInSearchDialog : existing.showInSearchDialog,
      };
      if (!hasAnySavedSearchVisibility(mergedVisibility)) {
        return jsonError('at least one visibility option is required', 400);
      }
      patch.updatedAt = new Date().toISOString();
      const result = await settings.updateSavedSearch(id, patch);
      return Response.json({ success: true, savedSearch: result });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function deleteSavedSearch(_request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get('id');
    if (!id) {
      return jsonError('id query parameter is required', 400);
    }
    try {
      const removed = await settings.removeSavedSearch(id);
      if (!removed) {
        return jsonError('Saved search not found', 404, 'SAVED_SEARCH_NOT_FOUND');
      }
      return Response.json({ success: true });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function putSavedSearchReorder(body: JsonBody): Promise<Response> {
    try {
      const oldOrder = Array.isArray(body.oldOrder) ? body.oldOrder : [];
      const newOrder = Array.isArray(body.newOrder) ? body.newOrder : [];
      const result = await settings.reorderSavedSearches(oldOrder, newOrder);
      if (!result.success) {
        return jsonError(result.error, result.status, result.errorCode);
      }
      return Response.json({ success: true });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  return {
    '/api/v1/app/saved-searches': { GET: getSavedSearches, POST: withJsonBody(postSavedSearch), PUT: withJsonBody(putSavedSearch), DELETE: deleteSavedSearch },
    '/api/v1/app/saved-searches/reorder': { PUT: withJsonBody(putSavedSearchReorder) },
  };
}
