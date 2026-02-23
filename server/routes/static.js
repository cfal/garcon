import path from 'path';
import { fileURLToPath } from 'url';
import { markRouteNoAuth } from '../lib/route-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../..');

function cacheHeaders(filePath) {
  if (filePath.endsWith('.html')) {
    return { 'Cache-Control': 'no-cache, no-store, must-revalidate' };
  }
  if (/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|map|json|webmanifest)$/.test(filePath)) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  return {};
}

// Serves from web/build/ (SvelteKit adapter-static output).
const distDir = path.join(serverRoot, 'web', 'build') + path.sep;

const indexPath = path.join(distDir, 'index.html');
console.log('Index at:', indexPath);

function noauthServeFile(req, url) {
  const fsPath = path.resolve(path.join(distDir, url.pathname));
  if (!fsPath.startsWith(distDir)) {
    return Response.json({ success: false, error: 'Not found' }, { status: 404 });
  }
  return new Response(Bun.file(fsPath), { headers: cacheHeaders(fsPath) });
}

function noauthServeStatic(filename) {
  const fsPath = path.join(distDir, filename);
  return markRouteNoAuth(function noauthServeStaticWrapper() {
    return new Response(Bun.file(fsPath), { headers: cacheHeaders(fsPath) });
  });
}

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
routes['/_app/*'] = { GET: markRouteNoAuth(noauthServeFile) };
routes['/chat/:id'] = { GET: noauthServeStatic('index.html') };
//routes['/*'] = { GET: noauthServeFile };

export default routes;
