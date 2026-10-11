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

test('fails closed when the framework bootstrap contract changes or the shell is not prepared', async () => {
  await expect(prepareRuntimeShell(fixture.replace('base: ""', 'base: "/compiled"'))).rejects.toThrow('Unsupported SvelteKit bootstrap');
  await expect(prepareRuntimeShell(fixture.replace('__sveltekit_example', 'unknown_bootstrap'))).rejects.toThrow('Unsupported SvelteKit shell');
  await expect(prepareRuntimeShell(fixture.replace("import('/_app/app.js')", "import('/unknown/app.js')"))).rejects.toThrow('entry imports');
  await expect(prepareRuntimeShell(await prepareRuntimeShell(fixture))).rejects.toThrow('already contains');
  expect(() => renderRuntimeShell(fixture, '/garcon')).toThrow('not runtime-mountable');
  expect(() => renderRuntimeShell(RUNTIME_BASE_PATH_TOKEN, '/<script>')).toThrow('Invalid base path');
});
