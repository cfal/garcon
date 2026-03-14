import path from 'path';
import { fileURLToPath } from 'url';
import { markRouteNoAuth } from '../lib/http-route.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../..');

export function cacheHeaders(requestPath) {
  if (requestPath.endsWith('.html')) {
    return { 'Cache-Control': 'no-cache, no-store, must-revalidate' };
  }
  if (/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|map|json|webmanifest)$/.test(requestPath)) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  return {};
}

function notFoundResponse() {
  return Response.json({ success: false, error: 'Not found' }, { status: 404 });
}

const noauthServePathname = (function() {
  const isEmbedded = Bun.embeddedFiles.length > 0;
  if (isEmbedded) {
    console.log('Static assets source: embedded');

    const embeddedAssets = (function generateEmbeddedStaticAssets() {
      const embeddedStaticAssetPaths = {};
      const embeddedRoot = 'web/build/';

      for (const blob of Bun.embeddedFiles) {
        if (!(blob instanceof Blob) || typeof blob.name !== 'string') continue;
        const normalizedName = blob.name.replaceAll('\\', '/');
        if (!normalizedName.startsWith(embeddedRoot)) continue;
        const relativePath = normalizedName.slice(embeddedRoot.length);
        if (!relativePath || relativePath.endsWith('/')) continue;
        embeddedStaticAssetPaths[`/${relativePath}`] = blob;
      }
      return Object.freeze(embeddedStaticAssetPaths);
    })();

    return function noauthServePathnameEmbedded(pathname) {
      if (typeof pathname !== 'string' || pathname.length === 0) {
        return notFoundResponse();
      }
      const embeddedPath = embeddedAssets[pathname];
      if (!(embeddedPath instanceof Blob)) {
        return notFoundResponse();
      }
      return new Response(embeddedPath, { headers: cacheHeaders(pathname) });
    };
  } else {
    console.log('Static assets source: filesystem');

    // Serves from web/build/ (SvelteKit adapter-static output).
    const filesystemDistDir = path.join(serverRoot, 'web', 'build') + path.sep;

    function getDistPathForRequest(pathname, distDirectory = filesystemDistDir) {
      const normalizedDistDir = distDirectory.endsWith(path.sep) ? distDirectory : `${distDirectory}${path.sep}`;
      const strippedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
      const resolvedPath = path.resolve(path.join(distDirectory, strippedPath));
      if (!resolvedPath.startsWith(normalizedDistDir)) {
        return null;
      }
      return resolvedPath;
    }

    return async function noauthServePathnameFilesystem(pathname) {
      if (typeof pathname !== 'string' || pathname.length === 0) {
        return notFoundResponse();
      }
      const fsPath = getDistPathForRequest(pathname, filesystemDistDir);
      if (!fsPath) return notFoundResponse();
      const file = Bun.file(fsPath);
      const exists = await file.exists();
      if (!exists) return notFoundResponse();
      return new Response(file, { headers: cacheHeaders(pathname) });
    };
  }
})();

function noauthServeStatic(filename) {
  const pathname = `/${filename}`;
  return markRouteNoAuth(async function noauthServeStaticWrapper() {
    return noauthServePathname(pathname);
  });
}

const noauthServeFile = markRouteNoAuth(async function noauthServeFile(req, url) {
  return noauthServePathname(url.pathname);
});

const routes = {};
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
routes['/_app/*'] = { GET: noauthServeFile };
routes['/chat/:id'] = { GET: noauthServeStatic('index.html') };
routes['/setup'] = { GET: noauthServeStatic('index.html') };
routes['/login'] = { GET: noauthServeStatic('index.html') };
//routes['/*'] = { GET: noauthServeFile };

export default routes;
