import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import createFilesRoutes from '../files.ts';

let projectBase;
let projectPath;
let outsidePath;
let originalProjectBaseDir;

beforeEach(async () => {
  originalProjectBaseDir = process.env.GARCON_PROJECT_BASE_DIR;
  projectBase = path.join(os.tmpdir(), `garcon-file-identity-${randomUUID()}`);
  projectPath = path.join(projectBase, 'project');
  outsidePath = path.join(
    os.tmpdir(),
    `garcon-file-identity-outside-${randomUUID()}`,
  );
  process.env.GARCON_PROJECT_BASE_DIR = projectBase;
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.mkdir(outsidePath, { recursive: true });
  await fs.writeFile(
    path.join(projectPath, 'src/file.ts'),
    'content\n',
    'utf8',
  );
});

afterEach(async () => {
  if (originalProjectBaseDir === undefined)
    delete process.env.GARCON_PROJECT_BASE_DIR;
  else process.env.GARCON_PROJECT_BASE_DIR = originalProjectBaseDir;
  await fs.rm(projectBase, { recursive: true, force: true });
  await fs.rm(outsidePath, { recursive: true, force: true });
});

function identityUrl(params) {
  return new URL(
    `http://localhost/api/v1/files/identity?${new URLSearchParams(params)}`,
  );
}

describe('file identity route', () => {
  it('canonicalizes project and file aliases into one identity', async () => {
    const projectAlias = path.join(projectBase, 'project-alias');
    await fs.symlink(projectPath, projectAlias, 'dir');
    await fs.symlink(
      path.join(projectPath, 'src/file.ts'),
      path.join(projectPath, 'src/file-alias.ts'),
    );
    const routes = createFilesRoutes({ getChat: () => null });

    const directUrl = identityUrl({ projectPath, path: 'src/file.ts' });
    const aliasUrl = identityUrl({
      projectPath: projectAlias,
      path: 'src/file-alias.ts',
    });
    const direct = await routes['/api/v1/files/identity'].GET(
      new Request(directUrl),
      directUrl,
    );
    const alias = await routes['/api/v1/files/identity'].GET(
      new Request(aliasUrl),
      aliasUrl,
    );

    expect(direct.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await direct.json());
    expect(
      (
        await (
          await routes['/api/v1/files/identity'].GET(
            new Request(directUrl),
            directUrl,
          )
        ).json()
      ).identity,
    ).toEqual({
      canonicalFileRootPath: projectPath,
      normalizedRelativePath: 'src/file.ts',
    });
  });

  it('resolves a sibling-project file against the configured base identity', async () => {
    const siblingFile = path.join(projectBase, 'sibling/src/other.ts');
    await fs.mkdir(path.dirname(siblingFile), { recursive: true });
    await fs.writeFile(siblingFile, 'sibling\n', 'utf8');
    const routes = createFilesRoutes({ getChat: () => null });
    const url = identityUrl({
      projectPath: projectBase,
      path: 'sibling/src/other.ts',
    });
    const response = await routes['/api/v1/files/identity'].GET(
      new Request(url),
      url,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).identity).toEqual({
      canonicalFileRootPath: projectBase,
      normalizedRelativePath: 'sibling/src/other.ts',
    });
  });

  it('gives chat identity precedence over a direct project selector', async () => {
    const routes = createFilesRoutes({ getChat: () => ({ projectPath }) });
    const url = identityUrl({
      chatId: 'chat-1',
      projectPath: outsidePath,
      path: 'src/file.ts',
    });
    const response = await routes['/api/v1/files/identity'].GET(
      new Request(url),
      url,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).identity.canonicalFileRootPath).toBe(
      projectPath,
    );
  });

  it('rejects invalid, absolute, directory, and missing file paths', async () => {
    const routes = createFilesRoutes({ getChat: () => null });
    const invalidUrl = identityUrl({ projectPath, path: '../outside.txt' });
    const absoluteUrl = identityUrl({
      projectPath,
      path: path.join(projectPath, 'src/file.ts'),
    });
    const directoryUrl = identityUrl({ projectPath, path: 'src' });
    const missingUrl = identityUrl({ projectPath, path: 'src/missing.ts' });

    expect(
      (
        await routes['/api/v1/files/identity'].GET(
          new Request(invalidUrl),
          invalidUrl,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await routes['/api/v1/files/identity'].GET(
          new Request(absoluteUrl),
          absoluteUrl,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await routes['/api/v1/files/identity'].GET(
          new Request(directoryUrl),
          directoryUrl,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await routes['/api/v1/files/identity'].GET(
          new Request(missingUrl),
          missingUrl,
        )
      ).status,
    ).toBe(404);
  });

  it('rejects a file alias that escapes the canonical project root', async () => {
    const outsideFile = path.join(outsidePath, 'secret.ts');
    await fs.writeFile(outsideFile, 'secret\n', 'utf8');
    await fs.symlink(outsideFile, path.join(projectPath, 'src/secret.ts'));
    const routes = createFilesRoutes({ getChat: () => null });
    const url = identityUrl({ projectPath, path: 'src/secret.ts' });
    const response = await routes['/api/v1/files/identity'].GET(
      new Request(url),
      url,
    );

    expect(response.status).toBe(403);
  });
});
