import { afterEach, describe, it, expect } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  cacheHeaders,
  resolveStaticFilePath,
  staticHeaders,
} from '../static.js';
import createStaticRoutes from '../static.js';
import {
  applyManifestTitle,
  injectAppTitleIntoShell,
} from '../../app-title.js';

const settings = {
  getUiSettings: () => ({}),
  getRemoteSettingsVersion: () => 0,
};

const routes = createStaticRoutes(settings);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    ),
  );
});

describe('cacheHeaders', () => {
  it('returns no-cache headers for html', () => {
    expect(cacheHeaders('/index.html')).toEqual({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
  });

  it('returns immutable cache headers for static assets', () => {
    expect(cacheHeaders('/_app/immutable/chunk.js')).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  it('does not mark root-level icons immutable', () => {
    expect(cacheHeaders('/favicon.ico')).toEqual({
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    });
  });

  it('returns empty headers for unknown extension', () => {
    expect(cacheHeaders('/api/health')).toEqual({});
  });
});

describe('staticHeaders', () => {
  it('adds Content-Length to html no-cache headers', () => {
    const headers = staticHeaders('/index.html', 2048);
    expect(headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(headers.get('Content-Length')).toBe('2048');
  });

  it('adds Content-Length to immutable asset headers', () => {
    const headers = staticHeaders('/_app/immutable/chunk.js', 4096);
    expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(headers.get('Content-Length')).toBe('4096');
  });

  it('adds Content-Length to dynamic manifest headers', () => {
    const headers = staticHeaders('/site.webmanifest', 256);
    expect(headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(headers.get('Content-Length')).toBe('256');
  });

  it('adds Content-Length to service worker no-cache headers', () => {
    const headers = staticHeaders('/service-worker.js', 512);
    expect(headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(headers.get('Content-Length')).toBe('512');
  });
});

describe('static app routes', () => {
  it('serves the SPA shell for the bare chat route', () => {
    expect(routes['/chat']).toBeDefined();
    expect(routes['/chat']?.GET).toBeFunction();
    expect(routes['/chat/']).toBeDefined();
    expect(routes['/chat/']?.GET).toBeFunction();
  });
});

describe('filesystem static paths', () => {
  it('rejects symlinks whose targets escape the build directory', async () => {
    const root = path.join(os.tmpdir(), `garcon-static-${randomUUID()}`);
    const buildPath = path.join(root, 'build');
    const outsidePath = path.join(root, 'secret.txt');
    temporaryDirectories.push(root);
    await fs.mkdir(buildPath, { recursive: true });
    await fs.writeFile(outsidePath, 'secret\n', 'utf8');
    await fs.symlink(outsidePath, path.join(buildPath, 'asset.txt'));

    await expect(resolveStaticFilePath('/asset.txt', buildPath)).resolves.toBeNull();
  });

  it('resolves regular files inside the build directory', async () => {
    const root = path.join(os.tmpdir(), `garcon-static-${randomUUID()}`);
    const buildPath = path.join(root, 'build');
    const assetPath = path.join(buildPath, 'asset.txt');
    temporaryDirectories.push(root);
    await fs.mkdir(buildPath, { recursive: true });
    await fs.writeFile(assetPath, 'asset\n', 'utf8');

    await expect(resolveStaticFilePath('/asset.txt', buildPath)).resolves.toBe(assetPath);
  });
});

describe('app title transforms', () => {
  it('injects app title into the SPA shell', () => {
    const html = injectAppTitleIntoShell('<head><title>Garcon</title></head>', {
      title: 'Garcon - Work',
      version: 3,
    });

    expect(html).toContain('<title>Garcon - Work</title>');
    expect(html).toContain('__GARCON_APP_TITLE__');
  });

  it('escapes app title while injecting shell metadata', () => {
    const html = injectAppTitleIntoShell(
      '<head><meta name="apple-mobile-web-app-title" content="Garcon" /><title>Garcon</title></head>',
      {
        title: 'Team <script>',
        version: 3,
      },
    );

    expect(html).toContain('<title>Team &lt;script&gt;</title>');
    expect(html).toContain('content="Team &lt;script&gt;"');
    expect(html).not.toContain('<title>Team <script></title>');
  });

  it('applies app title to manifest name and short_name', () => {
    const body = applyManifestTitle('{"name":"Garcon","short_name":"Garcon"}', {
      title: 'Garcon - Work',
      version: 3,
    });

    expect(JSON.parse(body)).toEqual({
      name: 'Garcon - Work',
      short_name: 'Garcon - Work',
    });
  });
});
