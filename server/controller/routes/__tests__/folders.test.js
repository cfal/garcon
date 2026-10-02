import { describe, it, expect, beforeEach, mock } from "bun:test";
import { makeRequest } from "./workspace-route-fixture.js";
import { createFolderRoutes } from "../folders.js";
import { FolderAlreadyExistsError, FolderNotFoundError } from "../../settings/errors.js";

let ctx;
let appRoutes;
beforeEach(() => {
  ctx = {
    settings: {
      getFolders: mock(() => []),
      addFolder: mock(() => Promise.resolve(undefined)),
      updateFolder: mock(() => Promise.resolve(undefined)),
      removeFolder: mock(() => Promise.resolve(false)),
    },
  };
  appRoutes = createFolderRoutes(ctx.settings);
});

describe('folders API', () => {
  let getHandler;
  beforeEach(() => { getHandler = appRoutes['/api/v1/app/folders'].GET; });
  let postHandler;
  beforeEach(() => { postHandler = appRoutes['/api/v1/app/folders'].POST; });
  let putHandler;
  beforeEach(() => { putHandler = appRoutes['/api/v1/app/folders'].PUT; });
  let deleteHandler;
  beforeEach(() => { deleteHandler = appRoutes['/api/v1/app/folders'].DELETE; });

  it('returns saved folders', async () => {
    const folders = [{ id: 'folder-1', name: 'Review', filter: { textTokens: ['bug'], tags: [], agents: [], models: [] }, createdAt: '2026-03-27T00:00:00.000Z' }];
    ctx.settings.getFolders.mockImplementation(() => Promise.resolve(folders));

    const response = await getHandler();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.folders).toEqual(folders);
  });

  it('sanitizes folder filters when creating a folder', async () => {
    ctx.settings.addFolder.mockImplementation(async (folder) => folder);
    const requestBody = {
      name: ' Important review ',
      filter: {
        textTokens: [' bug ', '', 7],
        tags: [' triage ', null],
        agents: [' codex '],
        models: [' gpt-5.4 ', false],
        status: ' unread ',
				ignored: ['value'],
			},
		};

    const response = await postHandler(makeRequest('http://localhost/api/app/folders', 'POST', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.addFolder).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.any(String),
      name: 'Important review',
      filter: {
        textTokens: ['bug'],
        tags: ['triage'],
        agents: ['codex'],
        models: ['gpt-5.4'],
					status: 'unread',
      },
				createdAt: expect.any(String),
			}));
		});

  it('returns 409 when creating a duplicate folder', async () => {
    ctx.settings.addFolder.mockImplementation(() => Promise.reject(new FolderAlreadyExistsError('duplicate')));
    const requestBody = { name: 'Duplicate' };

    const response = await postHandler(makeRequest('http://localhost/api/app/folders', 'POST', requestBody));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('FOLDER_ALREADY_EXISTS');
  });

  it('sanitizes folder filters when updating a folder', async () => {
    ctx.settings.updateFolder.mockImplementation(async (_id, patch) => ({ id: 'folder-1', name: 'Saved', createdAt: '2026-03-27T00:00:00.000Z', ...patch }));
    const requestBody = {
      id: 'folder-1',
      filter: {
        textTokens: [' one '],
        tags: [' alpha ', ''],
        agents: [' codex '],
        models: [' gpt-5 '],
				status: 'invalid',
			},
		};

    const response = await putHandler(makeRequest('http://localhost/api/app/folders', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.updateFolder).toHaveBeenCalledWith('folder-1', {
      filter: {
        textTokens: ['one'],
        tags: ['alpha'],
        agents: ['codex'],
        models: ['gpt-5'],
      },
    });
  });

  it('rejects whitespace-only folder names when updating a folder', async () => {
    const requestBody = {
      id: 'folder-1',
      name: '   ',
    };

    const response = await putHandler(makeRequest('http://localhost/api/app/folders', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('name is required');
    expect(ctx.settings.updateFolder).not.toHaveBeenCalled();
  });

  it('returns 404 when updating a missing folder', async () => {
    ctx.settings.updateFolder.mockImplementation(() => Promise.reject(new FolderNotFoundError('folder-404')));
    const requestBody = {
      id: 'folder-404',
      name: 'Missing',
    };

    const response = await putHandler(makeRequest('http://localhost/api/app/folders', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.errorCode).toBe('FOLDER_NOT_FOUND');
  });

  it('deletes a folder by id', async () => {
    ctx.settings.removeFolder.mockImplementation(() => Promise.resolve(true));

    const response = await deleteHandler(undefined, new URL('http://localhost/api/app/folders?id=folder-1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.removeFolder).toHaveBeenCalledWith('folder-1');
  });

  it('returns 404 when deleting a missing folder', async () => {
    ctx.settings.removeFolder.mockImplementation(() => Promise.resolve(false));

    const response = await deleteHandler(undefined, new URL('http://localhost/api/app/folders?id=missing'));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.errorCode).toBe('FOLDER_NOT_FOUND');
  });
});
