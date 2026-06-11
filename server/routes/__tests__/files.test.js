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

  it('rejects chat project paths outside the configured base', async () => {
    const routes = createFilesRoutes({ getChat: () => ({ projectPath: outsidePath }) });
    const url = new URL('http://localhost/api/v1/files/list?chatId=chat-1');
    const response = await routes['/api/v1/files/list'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.errorCode).toBe('outside_project_base');
  });
});
