import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import createFilesRoutes from '../files.js';

let projectPath;
let outsidePath;
let originalProjectBaseDir;

beforeEach(async () => {
  originalProjectBaseDir = process.env.GARCON_PROJECT_BASE_DIR;
  projectPath = path.join(os.tmpdir(), `garcon-files-route-${randomUUID()}`);
  outsidePath = path.join(os.tmpdir(), `garcon-files-route-outside-${randomUUID()}`);
  process.env.GARCON_PROJECT_BASE_DIR = projectPath;
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.mkdir(outsidePath, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'src/main.ts'), 'hello\n', 'utf8');
});

afterEach(async () => {
  if (originalProjectBaseDir === undefined) {
    delete process.env.GARCON_PROJECT_BASE_DIR;
  } else {
    process.env.GARCON_PROJECT_BASE_DIR = originalProjectBaseDir;
  }
  await fs.rm(projectPath, { recursive: true, force: true });
  await fs.rm(outsidePath, { recursive: true, force: true });
});

describe('files route', () => {
  it('lists files with project-relative paths and excludes directories', async () => {
    const routes = createFilesRoutes({ getChat: () => null });
    const url = new URL(`http://localhost/api/v1/files/list?projectPath=${encodeURIComponent(projectPath)}`);
    const response = await routes['/api/v1/files/list'].GET(new Request(url), url);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([
      {
        name: 'main.ts',
        path: path.join(projectPath, 'src/main.ts'),
        relativePath: 'src/main.ts',
        type: 'file',
      },
    ]);
  });

  it('rejects direct project paths outside the configured base', async () => {
    const routes = createFilesRoutes({ getChat: () => null });
    const url = new URL(`http://localhost/api/v1/files/list?projectPath=${encodeURIComponent(outsidePath)}`);
    const response = await routes['/api/v1/files/list'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.errorCode).toBe('outside_project_base');
  });

  it('returns 404 for missing project roots during path resolution', async () => {
    const routes = createFilesRoutes({ getChat: () => null });
    const missingPath = path.join(projectPath, 'missing-project');
    const url = new URL(`http://localhost/api/v1/files/list?projectPath=${encodeURIComponent(missingPath)}`);
    const response = await routes['/api/v1/files/list'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe(`Project path not found: ${missingPath}`);
  });

  it('rejects chat project paths outside the configured base', async () => {
    const routes = createFilesRoutes({ getChat: () => ({ projectPath: outsidePath }) });
    const url = new URL('http://localhost/api/v1/files/list?chatId=chat-1');
    const response = await routes['/api/v1/files/list'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.errorCode).toBe('outside_project_base');
  });

  it('rejects project roots that resolve outside the configured base through symlinks', async () => {
    const linkPath = path.join(projectPath, 'outside-link');
    await fs.symlink(outsidePath, linkPath, 'dir');

    const routes = createFilesRoutes({ getChat: () => null });
    const url = new URL(`http://localhost/api/v1/files/list?projectPath=${encodeURIComponent(linkPath)}`);
    const response = await routes['/api/v1/files/list'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.errorCode).toBe('outside_project_base');
  });

  it('rejects reads through project symlinks that resolve outside the project root', async () => {
    const secretPath = path.join(outsidePath, 'secret.txt');
    await fs.writeFile(secretPath, 'secret\n', 'utf8');
    await fs.symlink(secretPath, path.join(projectPath, 'secret-link.txt'));

    const routes = createFilesRoutes({ getChat: () => null });
    const url = new URL(
      `http://localhost/api/v1/files/text?projectPath=${encodeURIComponent(projectPath)}&path=secret-link.txt`,
    );
    const response = await routes['/api/v1/files/text'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe('Path must be under project root');
  });

  it('rejects writes through project symlink directories that resolve outside the project root', async () => {
    await fs.symlink(outsidePath, path.join(projectPath, 'outside-dir'), 'dir');

    const routes = createFilesRoutes({ getChat: () => null });
    const url = new URL(
      `http://localhost/api/v1/files/text?projectPath=${encodeURIComponent(projectPath)}&path=outside-dir/new.txt`,
    );
    const response = await routes['/api/v1/files/text'].PUT(
      new Request(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'escape' }),
      }),
      url,
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe('Path must be under project root');
    await expect(fs.readFile(path.join(outsidePath, 'new.txt'), 'utf8')).rejects.toThrow();
  });

  it('uploads images without requiring chat or project context', async () => {
    const routes = createFilesRoutes({
      getChat: () => {
        throw new Error('upload should not resolve chats');
      },
    });
    const formData = new FormData();
    formData.append('images', new File(['image-bytes'], 'sample.png', { type: 'image/png' }));
    const url = new URL('http://localhost/api/v1/files/upload-images');
    const response = await routes['/api/v1/files/upload-images'].POST(
      new Request(url, { method: 'POST', body: formData }),
      url,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatchObject({
      name: 'sample.png',
      mimeType: 'image/png',
      size: 'image-bytes'.length,
    });
    expect(body.images[0].data).toStartWith('data:image/png;base64,');
  });
});
