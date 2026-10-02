import { describe, it, expect, beforeEach, mock } from "bun:test";
import { makeRequest } from "./workspace-route-fixture.js";
import { createSavedSearchRoutes } from "../saved-searches.js";
import { SavedSearchAlreadyExistsError, SavedSearchNotFoundError } from "../../settings/errors.js";
import { CorruptStateFileError } from "../../../common/json-file-store.ts";

let ctx;
let appRoutes;
beforeEach(() => {
  ctx = {
    settings: {
      getSavedSearches: mock(() => []),
      addSavedSearch: mock(() => Promise.resolve(undefined)),
      updateSavedSearch: mock(() => Promise.resolve(undefined)),
      removeSavedSearch: mock(() => Promise.resolve(false)),
      reorderSavedSearches: mock(() => Promise.resolve({ success: true })),
    },
  };
  appRoutes = createSavedSearchRoutes(ctx.settings);
});

describe('saved searches API', () => {
  let getHandler;
  beforeEach(() => { getHandler = appRoutes['/api/v1/app/saved-searches'].GET; });
  let postHandler;
  beforeEach(() => { postHandler = appRoutes['/api/v1/app/saved-searches'].POST; });
  let putHandler;
  beforeEach(() => { putHandler = appRoutes['/api/v1/app/saved-searches'].PUT; });
  let deleteHandler;
  beforeEach(() => { deleteHandler = appRoutes['/api/v1/app/saved-searches'].DELETE; });
  let reorderHandler;
  beforeEach(() => { reorderHandler = appRoutes['/api/v1/app/saved-searches/reorder'].PUT; });

  it('returns saved searches', async () => {
    const searches = [{ id: 's1', title: 'Ops', query: 'tag:ops', showAsSidebarPill: false, showInSidebarMenu: true, showInSearchDialog: true, createdAt: 't', updatedAt: 't' }];
    ctx.settings.getSavedSearches.mockImplementation(() => Promise.resolve(searches));

    const response = await getHandler();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.savedSearches).toEqual(searches);
  });

  it('reports corrupt settings state as an opaque server error', async () => {
    ctx.settings.getSavedSearches.mockRejectedValueOnce(new CorruptStateFileError(
      '/server/config/project-settings.json',
      '/server/config/project-settings.json.corrupt-test',
    ));

    const response = await getHandler();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      retryable: true,
    });
  });

  it('creates a saved search with valid payload', async () => {
    ctx.settings.addSavedSearch.mockImplementation(async (s) => s);
    const requestBody = {
      title: 'My search',
      query: 'status:unread',
      showAsSidebarPill: true,
      showInSidebarMenu: false,
      showInSearchDialog: true,
    };

    const response = await postHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'POST', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.addSavedSearch).toHaveBeenCalledWith(expect.objectContaining({
      title: 'My search',
      query: 'status:unread',
      showAsSidebarPill: true,
      showInSidebarMenu: false,
      showInSearchDialog: true,
    }));
  });

  it('returns 409 when creating a duplicate saved search', async () => {
    ctx.settings.addSavedSearch.mockImplementation(() => Promise.reject(
      new SavedSearchAlreadyExistsError('duplicate'),
    ));
    const requestBody = {
      title: 'Duplicate',
      query: 'status:unread',
      showAsSidebarPill: true,
      showInSidebarMenu: false,
      showInSearchDialog: false,
    };

    const response = await postHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'POST', requestBody));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('SAVED_SEARCH_ALREADY_EXISTS');
  });

  it('rejects create when query is empty', async () => {
    const requestBody = { query: '' };

    const response = await postHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'POST', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('query is required');
  });

  it('rejects create when no visibility options are enabled', async () => {
    const requestBody = {
      query: 'status:active',
      showAsSidebarPill: false,
      showInSidebarMenu: false,
      showInSearchDialog: false,
    };

    const response = await postHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'POST', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('at least one visibility option is required');
  });

  it('deletes a saved search by id', async () => {
    ctx.settings.removeSavedSearch.mockImplementation(() => Promise.resolve(true));

    const response = await deleteHandler(undefined, new URL('http://localhost/api/v1/app/saved-searches?id=s1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.removeSavedSearch).toHaveBeenCalledWith('s1');
  });

  it('rejects update that disables all visibility options', async () => {
    ctx.settings.getSavedSearches.mockImplementation(() => Promise.resolve([
      { id: 's1', title: null, query: 'status:active', showAsSidebarPill: true, showInSidebarMenu: false, showInSearchDialog: false, createdAt: 't', updatedAt: 't' },
    ]));
    const requestBody = {
      id: 's1',
      showAsSidebarPill: false,
      showInSidebarMenu: false,
      showInSearchDialog: false,
    };

    const response = await putHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('at least one visibility option is required');
  });

  it('allows update that changes visibility targets', async () => {
    ctx.settings.getSavedSearches.mockImplementation(() => Promise.resolve([
      { id: 's1', title: null, query: 'status:active', showAsSidebarPill: true, showInSidebarMenu: false, showInSearchDialog: false, createdAt: 't', updatedAt: 't' },
    ]));
    ctx.settings.updateSavedSearch.mockImplementation(async (_id, patch) => ({
      id: 's1', title: null, query: 'status:active', showAsSidebarPill: false, showInSidebarMenu: true, showInSearchDialog: true, createdAt: 't', updatedAt: patch.updatedAt,
    }));
    const requestBody = {
      id: 's1',
      showAsSidebarPill: false,
      showInSidebarMenu: true,
      showInSearchDialog: true,
    };

    const response = await putHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 404 when updating non-existent saved search', async () => {
    ctx.settings.getSavedSearches.mockImplementation(() => Promise.resolve([]));
    const requestBody = { id: 'missing', query: 'test' };

    const response = await putHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Saved search not found');
    expect(body.errorCode).toBe('SAVED_SEARCH_NOT_FOUND');
  });

  it('returns 404 when saved search disappears during update', async () => {
    ctx.settings.getSavedSearches.mockImplementation(() => [{
      id: 'gone',
      title: null,
      query: 'old',
      showAsSidebarPill: true,
      showInSidebarMenu: false,
      showInSearchDialog: false,
      createdAt: 't',
      updatedAt: 't',
    }]);
    ctx.settings.updateSavedSearch.mockImplementation(() => Promise.reject(new SavedSearchNotFoundError('gone')));
    const requestBody = { id: 'gone', query: 'new' };

    const response = await putHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.errorCode).toBe('SAVED_SEARCH_NOT_FOUND');
  });

  it('reorders saved searches', async () => {
    ctx.settings.reorderSavedSearches.mockImplementation(() => Promise.resolve({ success: true }));
    const requestBody = {
      oldOrder: ['a', 'b'],
      newOrder: ['b', 'a'],
    };

    const response = await reorderHandler(makeRequest('http://localhost/api/v1/app/saved-searches/reorder', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
