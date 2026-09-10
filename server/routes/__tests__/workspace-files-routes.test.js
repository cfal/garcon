import { describe, expect, it, mock, spyOn } from 'bun:test';
import createFilesRoutes from '../files.js';

const projectPath = '/synthetic-owner-only/project';
const filePath = 'synthetic.txt';
const revision = 'v1:synthetic';

function services() {
  /** @satisfies {import('../../execution-nodes/workspace-files.js').WorkspaceFileService} */
  const files = {
    inspectProject: mock(async () => ({ kind: 'available', effectiveProjectKey: projectPath })),
    identity: mock(async () => ({ success: true, identity: {
      canonicalFileRootPath: projectPath, normalizedRelativePath: filePath,
    } })),
    readText: mock(async () => ({ content: 'synthetic content', path: `${projectPath}/${filePath}`, revision })),
    revision: mock(async () => ({ status: 'ready', revision })),
    saveText: mock(async () => ({ success: true, path: `${projectPath}/${filePath}`, message: 'File saved successfully', revision })),
    content: mock(async () => ({ bytes: new TextEncoder().encode('synthetic bytes'), mimeType: 'text/plain', revision })),
    list: mock(async () => ({ files: [], truncated: true })),
    tree: mock(async () => ({
      fileRootPath: projectPath, homeDirectory: null, entries: [],
      directory: { path: projectPath, relativePath: '', parentPath: null, breadcrumbs: [{ name: 'project', path: projectPath }] },
    })),
    browse: mock(async () => [{ name: 'synthetic', path: projectPath, type: 'directory' }]),
  };
  return files;
}

describe('workspace files HTTP service boundary', () => {
  it.each([
    ['identity', 'identity'], ['text', 'readText'], ['revision', 'revision'],
    ['content', 'content'], ['list', 'list'],
  ])('routes %s to the owner without inspecting its path on the controller', async (route, operation) => {
    const files = services();
    const routes = createFilesRoutes({ getChat: () => ({ projectPath }) }, files);
    const url = new URL(`http://localhost/api/v1/files/${route}?chatId=1000000000000001&projectPath=/not/the/chat&path=${filePath}`);
    const request = new Request(url);
    const response = await routes[url.pathname].GET(request, url);
    expect(response.status).toBe(200);
    expect(files[operation]).toHaveBeenCalledWith(
      operation === 'list' ? projectPath : { projectPath, filePath }, request.signal,
    );
    if (route === 'content') {
      expect(await response.text()).toBe('synthetic bytes');
      expect(response.headers.get('X-Garcon-File-Revision')).toBe(revision);
    } else if (route === 'list') {
      expect(response.headers.get('X-Garcon-File-List-Truncated')).toBe('true');
    }
  });

  it.each(['tree', 'browse'])('leaves %s root selection on its owner', async (route) => {
    const files = services();
    const routes = createFilesRoutes({ getChat: () => null }, files);
    const url = new URL(`http://localhost/api/v1/files/${route}`);
    const request = new Request(url);
    expect((await routes[url.pathname].GET(request, url)).status).toBe(200);
    expect(files[route]).toHaveBeenCalledWith(null, request.signal);
  });

  it('forwards a parsed save and cancellation to the selected workspace service', async () => {
    const files = services();
    const routes = createFilesRoutes({ getChat: () => null }, files);
    const body = { content: 'synthetic submitted content', expectedRevision: revision, conflictResolution: 'reject' };
    const url = new URL(`http://localhost/api/v1/files/text?projectPath=${projectPath}&path=${filePath}`);
    const request = new Request(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await routes[url.pathname].PUT(request, url)).status).toBe(200);
    expect(files.saveText).toHaveBeenCalledWith({ projectPath, filePath }, body, request.signal);
  });

  for (const reasonKind of ['default', 'custom', 'reconstructed']) {
    it.each([
      ['tree', 'tree', 'GET'], ['browse', 'browse', 'GET'], ['list', 'list', 'GET'],
      ['identity', 'identity', 'GET'], ['text', 'readText', 'GET'],
      ['revision', 'revision', 'GET'], ['content', 'content', 'GET'], ['text', 'saveText', 'PUT'],
    ])(`returns client-closed without error logs for cancelled %s %s (${reasonKind} reason)`, async (route, operation, method) => {
      const files = services();
      const cancellation = new AbortController();
      files[operation] = mock(async (...args) => {
        cancellation.abort(reasonKind === 'custom' ? new Error('synthetic cancellation') : undefined);
        if (reasonKind === 'reconstructed') {
          const error = new DOMException('Synthetic remote cancellation', 'AbortError');
          expect(error).not.toBe(cancellation.signal.reason);
          throw error;
        }
        args.at(-1).throwIfAborted();
      });
      const routes = createFilesRoutes({ getChat: () => ({ projectPath }) }, files);
      const url = new URL(`http://localhost/api/v1/files/${route}?projectPath=${projectPath}&path=${filePath}`);
      const request = new Request(url, {
        method, signal: cancellation.signal,
        ...(method === 'PUT' ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'synthetic save', expectedRevision: revision, conflictResolution: 'reject' }),
        } : {}),
      });
      const errors = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const response = await routes[url.pathname][method](request, url);
        expect(response.status).toBe(499);
        expect(await response.text()).toBe('');
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
  }

  it('does not hide an unrelated failure when the request also aborts', async () => {
    const files = services();
    const cancellation = new AbortController();
    files.readText = mock(async () => {
      cancellation.abort();
      throw new Error('synthetic owner failure');
    });
    const routes = createFilesRoutes({ getChat: () => ({ projectPath }) }, files);
    const url = new URL(`http://localhost/api/v1/files/text?projectPath=${projectPath}&path=${filePath}`);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await routes[url.pathname].GET(new Request(url, { signal: cancellation.signal }), url);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ errorCode: 'INTERNAL_ERROR' });
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
