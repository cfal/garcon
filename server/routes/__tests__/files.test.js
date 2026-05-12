import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import createFilesRoutes from '../files.js';

let projectPath;

beforeEach(async () => {
  projectPath = path.join(os.tmpdir(), `garcon-files-route-${randomUUID()}`);
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectPath, 'src/main.ts'), 'hello\n', 'utf8');
});

afterEach(async () => {
  await fs.rm(projectPath, { recursive: true, force: true });
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
});
