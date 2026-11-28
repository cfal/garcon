if (Bun.version !== '1.4.3') throw new Error(`The route inventory uses Bun 1.4.3, got ${Bun.version}`);

process.env.GARCON_LOG_LEVEL = 'silent';

const { default: createAllRoutes } = await import('../../../../server/controller/routes/index.ts');
const { isNoAuthHandler } = await import('../../../../server/controller/lib/http-route.ts');

// Route construction does not call the services. Only the executor field is
// read eagerly; no handler is invoked and no workspace needs to exist.
const routes = createAllRoutes('/fixture/workspace', { executors: {} } as Parameters<typeof createAllRoutes>[1]);
const ported = new Set(Bun.argv.slice(2));
const rows = [];
for (const [path, methods] of Object.entries(routes)) {
  for (const [method, handler] of Object.entries(methods)) {
    if (ported.delete(`${method} ${path}`)) continue;
    const markers = Object.getOwnPropertySymbols(handler);
    const noStore = markers.some(symbol => symbol.description === 'no-store-route');
    const headerMarker = markers.find(symbol => symbol.description === 'response-headers-route');
    const responseHeaders = headerMarker === undefined ? undefined : Reflect.get(handler, headerMarker);
    rows.push({
      method,
      path,
      ...(isNoAuthHandler(handler) ? { noAuth: true } : {}),
      ...(noStore ? { noStore: true } : {}),
      ...(responseHeaders === undefined ? {} : { responseHeaders }),
    });
  }
}
if (ported.size > 0) throw new Error(`Unknown ported routes: ${[...ported].join(', ')}`);

process.stdout.write(`[\n${rows.map(row => `  ${JSON.stringify(row)}`).join(',\n')}\n]\n`);
