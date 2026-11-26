import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RUNTIME_BASE_PATH_TOKEN } from '../common/runtime-shell.js';
import { collectEagerAssets, linkedAssets, type ManifestEntry } from '../web/scripts/eager-assets.js';
import { isDefaultThemeId, THEME_PROFILES } from '../web/src/lib/theme/themes.js';

interface RuntimeShellAssets {
  readonly eagerStyles: ReadonlySet<string>;
  readonly themeStylesheets: Readonly<Record<string, string>>;
}

const SW_PRECACHE_BINDING = '__GARCON_PRECACHE__';

// Validates SvelteKit's generated bootstrap at build time, never rewrites hashed bundles.
export async function prepareRuntimeShell(html: string, assets?: RuntimeShellAssets): Promise<string> {
  if (html.includes(RUNTIME_BASE_PATH_TOKEN)) {
    throw new Error('Web shell already contains the runtime base token');
  }
  let bootstrapCount = 0;
  let entryImportCount = 0;
  let serviceWorkerCount = 0;
  let themeStylesheetCount = 0;

  const rewriteInlineScript = (source: string): string => {
    const sourceFile = ts.createSourceFile('shell.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const edits: { start: number; end: number; replacement: string }[] = [];
    const replaceStringLiteral = (node: ts.StringLiteral, value: string): void => {
      edits.push({
        start: node.getStart(sourceFile),
        end: node.end,
        replacement: JSON.stringify(value),
      });
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)
        && /^__sveltekit_\w+$/.test(node.left.text)
        && ts.isObjectLiteralExpression(node.right)
      ) {
        const baseProperty = node.right.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'base',
        );
        if (!baseProperty || !ts.isStringLiteral(baseProperty.initializer) || baseProperty.initializer.text !== '') {
          throw new Error('Unsupported SvelteKit bootstrap base');
        }
        replaceStringLiteral(baseProperty.initializer, RUNTIME_BASE_PATH_TOKEN);
        bootstrapCount++;
      }
      if (ts.isStringLiteral(node)) {
        if (node.text.startsWith('/_app/')) {
          replaceStringLiteral(node, RUNTIME_BASE_PATH_TOKEN + node.text);
          if (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword) {
            entryImportCount++;
          }
        } else if (node.text === '/service-worker.js') {
          replaceStringLiteral(node, RUNTIME_BASE_PATH_TOKEN + node.text);
          serviceWorkerCount++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    let result = source;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    }
    return result;
  };

  let inlineScript = '';
  const transformed = await new HTMLRewriter()
    .on('[href], [src]', {
      element(element) {
        const href = element.getAttribute('href');
        // Kit includes dynamic-import CSS in the fallback's root node even with SSR disabled.
        // Vite's import preloader still loads those sheets with their respective chunks.
        if (assets && href?.startsWith('/_app/') && element.getAttribute('rel') === 'stylesheet'
            && !assets.eagerStyles.has(href.slice(1))) {
          element.remove();
          return;
        }
        for (const attribute of ['href', 'src']) {
          const value = element.getAttribute(attribute);
          if (value?.startsWith('/') && !value.startsWith('//')) {
            element.setAttribute(attribute, RUNTIME_BASE_PATH_TOKEN + value);
          }
        }
      },
    })
    .on('script#garcon-theme-stylesheets', {
      element(element) {
        if (!assets) return;
        const stylesheets = Object.fromEntries(
          Object.entries(assets.themeStylesheets).map(([id, href]) => [id, RUNTIME_BASE_PATH_TOKEN + href]),
        );
        element.setInnerContent(JSON.stringify(stylesheets), { html: true });
        themeStylesheetCount++;
      },
    })
    .on('script:not([src]):not(#garcon-theme-stylesheets)', {
      element(element) {
        inlineScript = '';
        element.onEndTag(tag => {
          tag.before(rewriteInlineScript(inlineScript), { html: true });
        });
      },
      text(chunk) {
        inlineScript += chunk.text;
        chunk.remove();
      },
    })
    .transform(new Response(html)).text();
  if (bootstrapCount !== 1 || entryImportCount !== 2 || serviceWorkerCount !== 1) {
    throw new Error(`Unsupported SvelteKit shell: ${bootstrapCount} bootstraps, ${entryImportCount} entry imports, ${serviceWorkerCount} service workers`);
  }
  if (assets && themeStylesheetCount !== 1) throw new Error('Expected one theme stylesheet map');
  return transformed;
}

export function configureServiceWorkerPrecache(
  worker: string,
  eager: readonly string[],
  immutable: readonly string[],
): string {
  if (worker.split(SW_PRECACHE_BINDING).length !== 2) {
    throw new Error('Expected one service worker precache binding');
  }
  return `const ${SW_PRECACHE_BINDING} = ${JSON.stringify({ eager, immutable })};\n${worker}`;
}

if (import.meta.main) {
  const build = new URL('../web/build/', import.meta.url);
  const filename = new URL('index.html', build);
  const workerFilename = new URL('service-worker.js', build);
  const manifest = await Bun.file(
    new URL('../web/.svelte-kit/output/client/.vite/manifest.json', import.meta.url),
  ).json() as Record<string, ManifestEntry>;
  const html = await readFile(filename, 'utf8');
  const preloads = linkedAssets(html, 'modulepreload');
  const shell = collectEagerAssets(preloads, [], manifest);
  const { manifest: kit } = await import(new URL('../web/.svelte-kit/output/server/manifest-full.js', import.meta.url).href);
  type Route = { id: string; page?: { layouts: (number | undefined)[]; errors: (number | undefined)[]; leaf: number } };
  const routes = new Map((kit.routes as Route[]).map(route => [route.id, route.page]));
  const nodes = new Set<number>();
  for (const id of ['/', '/chat', '/chat/[id]', '/login', '/setup', '/shared/[token]']) {
    const page = routes.get(id);
    if (!page) throw new Error(`Missing offline route: ${id}`);
    for (const node of [...page.layouts, ...page.errors, page.leaf]) if (node !== undefined) nodes.add(node);
  }
  const routeFiles = [...nodes].map(node => {
    const name = `nodes/${node}`;
    const entry = Object.values(manifest).find(candidate => candidate.name === name);
    if (!entry) throw new Error(`Missing SvelteKit startup entry: ${name}`);
    return entry.file;
  });
  const offline = collectEagerAssets([...preloads, ...routeFiles], [], manifest);
  const workspaceEntry = manifest['src/routes/WorkspaceBoot.svelte'];
  const settingsEntry = manifest['src/lib/components/settings/Settings.svelte'];
  if (!workspaceEntry || !settingsEntry) throw new Error('Missing offline Settings entry points');
  const workspace = collectEagerAssets([workspaceEntry.file], [], manifest);
  const settings = collectEagerAssets([settingsEntry.file], [], manifest);
  // Settings opens from an already loaded workspace. Only its additional assets need precaching.
  const eager = [...new Set([
    ...offline.files, ...offline.cssFiles,
    ...[...settings.files].filter(file => !workspace.files.has(file)),
    ...[...settings.cssFiles].filter(file => !workspace.cssFiles.has(file)),
  ])].sort();

  const themeStylesheets: Record<string, string> = {};
  for (const { id } of THEME_PROFILES) {
    if (isDefaultThemeId(id)) continue;
    const source = await readFile(new URL(`../web/src/lib/theme/profiles/${id}.css`, import.meta.url));
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
    const file = `_app/immutable/assets/theme-${id}.${hash}.css`;
    await writeFile(new URL(file, build), source);
    themeStylesheets[id] = '/' + file;
  }

  const worker = await readFile(workerFilename, 'utf8');
  const prepared = await prepareRuntimeShell(html, { eagerStyles: shell.cssFiles, themeStylesheets });
  await writeFile(filename, prepared);
  const immutable = [...new Bun.Glob('_app/immutable/**/*').scanSync({ cwd: fileURLToPath(build), onlyFiles: true })]
    .filter(path => !path.endsWith('.map')).sort();
  await writeFile(workerFilename, configureServiceWorkerPrecache(worker, eager, immutable));
}
