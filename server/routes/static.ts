import path from 'path';
import { fileURLToPath } from 'url';
import { markRouteNoAuth } from '../lib/http-route.js';
import { jsonError } from '../lib/http-error.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('routes:static');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../..');

type NamedBlob = Blob & { name?: unknown };
type StaticAssetMap = Record<string, Blob>;
type StaticPathHandler = (pathname: string) => Response | Promise<Response>;

export function cacheHeaders(requestPath: string): HeadersInit {
  if (requestPath.endsWith('.html')) {
    return { 'Cache-Control': 'no-cache, no-store, must-revalidate' };
  }
  // Service workers must not be aggressively cached so browsers detect updates.
  if (requestPath === '/service-worker.js') {
    return { 'Cache-Control': 'no-cache, no-store, must-revalidate' };
  }
  if (/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|map|json|webmanifest)$/.test(requestPath)) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  return {};
}

// Builds static response headers including an explicit uncompressed
// Content-Length so the compressor can skip small assets without buffering.
export function staticHeaders(requestPath: string, size: number): Headers {
  const headers = new Headers(cacheHeaders(requestPath));
  headers.set('Content-Length', String(size));
  return headers;
}

function notFoundResponse(): Response {
  return jsonError('Not found', 404);
}

const noauthServePathname: StaticPathHandler = (function() {
  const isEmbedded = Bun.embeddedFiles.length > 0;
  if (isEmbedded) {
    logger.info('Static assets source: embedded');

    const embeddedAssets = (function generateEmbeddedStaticAssets() {
      const embeddedStaticAssetPaths: StaticAssetMap = {};
      const embeddedRoot = 'web/build/';

      for (const blob of Bun.embeddedFiles) {
        const namedBlob = blob as NamedBlob;
        if (!(blob instanceof Blob) || typeof namedBlob.name !== 'string') continue;
        const normalizedName = namedBlob.name.replaceAll('\\', '/');
        if (!normalizedName.startsWith(embeddedRoot)) continue;
        const relativePath = normalizedName.slice(embeddedRoot.length);
        if (!relativePath || relativePath.endsWith('/')) continue;
        embeddedStaticAssetPaths[`/${relativePath}`] = blob;
      }
      return Object.freeze(embeddedStaticAssetPaths);
    })();

    return function noauthServePathnameEmbedded(pathname: string): Response {
      if (typeof pathname !== 'string' || pathname.length === 0) {
        return notFoundResponse();
      }
      const embeddedPath = embeddedAssets[pathname];
      if (!(embeddedPath instanceof Blob)) {
        return notFoundResponse();
      }
      return new Response(embeddedPath, { headers: staticHeaders(pathname, embeddedPath.size) });
    };
  } else {
    logger.info('Static assets source: filesystem');

    // Serves from web/build/ (SvelteKit adapter-static output).
    const filesystemDistDir = path.join(serverRoot, 'web', 'build') + path.sep;

    function getDistPathForRequest(pathname: string, distDirectory = filesystemDistDir): string | null {
      const normalizedDistDir = distDirectory.endsWith(path.sep) ? distDirectory : `${distDirectory}${path.sep}`;
      const strippedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
      const resolvedPath = path.resolve(path.join(distDirectory, strippedPath));
      if (!resolvedPath.startsWith(normalizedDistDir)) {
        return null;
      }
      return resolvedPath;
    }

    return async function noauthServePathnameFilesystem(pathname: string): Promise<Response> {
      if (typeof pathname !== 'string' || pathname.length === 0) {
        return notFoundResponse();
      }
      const fsPath = getDistPathForRequest(pathname, filesystemDistDir);
      if (!fsPath) return notFoundResponse();
      const file = Bun.file(fsPath);
      const exists = await file.exists();
      if (!exists) return notFoundResponse();
      return new Response(file, { headers: staticHeaders(pathname, file.size) });
    };
  }
})();

function noauthServeStatic(filename: string): RouteHandler {
  const pathname = `/${filename}`;
  return markRouteNoAuth(async function noauthServeStaticWrapper() {
    return noauthServePathname(pathname);
  });
}

const noauthServeFile = markRouteNoAuth(async function noauthServeFile(_req: Request, url: URL): Promise<Response> {
  return noauthServePathname(url.pathname);
});

const routes: RouteMap = {};
routes['/'] = { GET: noauthServeStatic('index.html') };
routes['/index.html'] = { GET: noauthServeStatic('index.html') };
routes['/favicon.ico'] = { GET: noauthServeStatic('favicon.ico') };
routes['/icon.svg'] = { GET: noauthServeStatic('icon.svg') };
routes['/favicon-16x16.png'] = { GET: noauthServeStatic('favicon-16x16.png') };
routes['/favicon-32x32.png'] = { GET: noauthServeStatic('favicon-32x32.png') };
routes['/apple-touch-icon.png'] = { GET: noauthServeStatic('apple-touch-icon.png') };
routes['/icon-192.png'] = { GET: noauthServeStatic('icon-192.png') };
routes['/icon-512.png'] = { GET: noauthServeStatic('icon-512.png') };
routes['/site.webmanifest'] = { GET: noauthServeStatic('site.webmanifest') };
routes['/service-worker.js'] = { GET: noauthServeStatic('service-worker.js') };
routes['/_app/*'] = { GET: noauthServeFile };
routes['/chat'] = { GET: noauthServeStatic('index.html') };
routes['/chat/'] = { GET: noauthServeStatic('index.html') };
routes['/chat/:id'] = { GET: noauthServeStatic('index.html') };
routes['/setup'] = { GET: noauthServeStatic('index.html') };
routes['/login'] = { GET: noauthServeStatic('index.html') };
routes['/shared/:token'] = { GET: noauthServeStatic('index.html') };

export default routes;
