import { expect, test } from 'bun:test';
import { prepareRuntimeShell } from '../runtime-shell.ts';
import { renderRuntimeShell, RUNTIME_BASE_PATH_TOKEN } from '../../common/runtime-shell.ts';

const fixture = `<!doctype html><html><head>
<link rel="icon" href="/icons/icon.svg"><link rel="stylesheet" href="/_app/style.css">
<script>const theme = 'dark';</script></head><body><script>{
__sveltekit_example = { base: "" };
Promise.all([import('/_app/start.js'), import('/_app/app.js')]);
const script_url = '/service-worker.js';
}</script></body></html>`;

test('renders one generated template at root and nested mounts without modifying scripts or external URLs', async () => {
  const template = await prepareRuntimeShell(fixture.replace('</head>', '<link href="https://external.test/path"></head>'));
  expect(template).toContain(RUNTIME_BASE_PATH_TOKEN);
  for (const base of ['', '/garcon', '/tools/garcon']) {
    const html = renderRuntimeShell(template, base);
    expect(html).toContain(`base: "${base}"`);
    expect(html).toContain(`import("${base}/_app/start.js")`);
    expect(html).toContain(`href="${base}/icons/icon.svg"`);
    expect(html).toContain(`"${base}/service-worker.js"`);
    expect(html).toContain("const theme = 'dark';");
    expect(html).toContain('href="https://external.test/path"');
    expect(html).not.toContain(RUNTIME_BASE_PATH_TOKEN);
  }
});

test('rewrites local asset references while preserving relative and protocol-relative URLs', async () => {
  const html = fixture.replace('</head>', `
<script src="/assets/runtime.js"></script>
<link href="//cdn.example.test/styles.css">
<link href="./local.css">
<script>
const preload = '/_app/preload.js';
const relative = './_app/local.js';
const external = 'https://cdn.example.test/_app/external.js';
const unrelated = { base: "" };
</script></head>`);
  const rendered = renderRuntimeShell(await prepareRuntimeShell(html), '/tools/garcon');

  expect(rendered).toContain('src="/tools/garcon/assets/runtime.js"');
  expect(rendered).toContain('href="//cdn.example.test/styles.css"');
  expect(rendered).toContain('href="./local.css"');
  expect(rendered).toContain('const preload = "/tools/garcon/_app/preload.js";');
  expect(rendered).toContain("const relative = './_app/local.js';");
  expect(rendered).toContain("const external = 'https://cdn.example.test/_app/external.js';");
  expect(rendered).toContain('const unrelated = { base: "" };');
});

test.each(['', 'base: 0', 'base: ``', '"base": ""'])(
  'rejects unsupported bootstrap properties: %s',
  async properties => {
    await expect(prepareRuntimeShell(fixture.replace('base: ""', properties)))
      .rejects.toThrow('Unsupported SvelteKit bootstrap base');
  },
);

test.each([
  ['bootstrap', '__sveltekit_duplicate = { base: "" };', '2 bootstraps'],
  ['entry import', "import('/_app/extra.js');", '3 entry imports'],
  ['service worker', "const extraWorker = '/service-worker.js';", '2 service workers'],
])('rejects a duplicate %s', async (_label, script, message) => {
  await expect(prepareRuntimeShell(fixture.replace('</body>', `<script>${script}</script></body>`)))
    .rejects.toThrow(message);
});

test('rejects a missing service worker registration', async () => {
  await expect(prepareRuntimeShell(fixture.replace("'/service-worker.js'", "'/other-worker.js'")))
    .rejects.toThrow('0 service workers');
});

test('fails closed when the framework bootstrap contract changes or the shell is not prepared', async () => {
  await expect(prepareRuntimeShell(fixture.replace('base: ""', 'base: "/compiled"'))).rejects.toThrow('Unsupported SvelteKit bootstrap');
  await expect(prepareRuntimeShell(fixture.replace('__sveltekit_example', 'unknown_bootstrap'))).rejects.toThrow('Unsupported SvelteKit shell');
  await expect(prepareRuntimeShell(fixture.replace("import('/_app/app.js')", "import('/unknown/app.js')"))).rejects.toThrow('entry imports');
  await expect(prepareRuntimeShell(await prepareRuntimeShell(fixture))).rejects.toThrow('already contains');
  expect(() => renderRuntimeShell(fixture, '/garcon')).toThrow('not runtime-mountable');
  expect(() => renderRuntimeShell(RUNTIME_BASE_PATH_TOKEN, '/<script>')).toThrow('Invalid base path');
});
