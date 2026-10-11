import ts from 'typescript';
import { RUNTIME_BASE_PATH_TOKEN } from '../common/runtime-shell.js';

// Validates SvelteKit's generated bootstrap at build time, never rewrites hashed bundles.
export async function prepareRuntimeShell(html: string): Promise<string> {
  if (html.includes(RUNTIME_BASE_PATH_TOKEN)) throw new Error('Web shell already contains the runtime base token');
  let bootstraps = 0;
  let imports = 0;
  let workers = 0;
  let script = '';
  const rewriteScript = (source: string): string => {
    const parsed = ts.createSourceFile('shell.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const edits: { start: number; end: number; replacement: string }[] = [];
    const replace = (node: ts.Node, text: string) => edits.push({ start: node.getStart(parsed), end: node.end, replacement: JSON.stringify(text) });
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left) && /^__sveltekit_\w+$/.test(node.left.text) && ts.isObjectLiteralExpression(node.right)) {
        const base = node.right.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(parsed) === 'base');
        if (!base || !ts.isPropertyAssignment(base) || !ts.isStringLiteral(base.initializer) || base.initializer.text !== '') {
          throw new Error('Unsupported SvelteKit bootstrap base');
        }
        replace(base.initializer, RUNTIME_BASE_PATH_TOKEN);
        bootstraps++;
      }
      if (ts.isStringLiteral(node)) {
        if (node.text.startsWith('/_app/')) {
          replace(node, RUNTIME_BASE_PATH_TOKEN + node.text);
          if (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword) imports++;
        } else if (node.text === '/service-worker.js') {
          replace(node, RUNTIME_BASE_PATH_TOKEN + node.text);
          workers++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    let result = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    }
    return result;
  };
  const transformed = await new HTMLRewriter()
    .on('[href], [src]', {
      element(element) {
        for (const attribute of ['href', 'src']) {
          const value = element.getAttribute(attribute);
          if (value?.startsWith('/') && !value.startsWith('//')) {
            element.setAttribute(attribute, RUNTIME_BASE_PATH_TOKEN + value);
          }
        }
      },
    })
    .on('script:not([src])', {
      element(element) {
        script = '';
        element.onEndTag(tag => tag.before(rewriteScript(script), { html: true }));
      },
      text(chunk) {
        script += chunk.text;
        chunk.remove();
      },
    })
    .transform(new Response(html)).text();
  if (bootstraps !== 1 || imports !== 2 || workers !== 1) {
    throw new Error(`Unsupported SvelteKit shell: ${bootstraps} bootstraps, ${imports} entry imports, ${workers} service workers`);
  }
  return transformed;
}

if (import.meta.main) {
  const filename = new URL('../web/build/index.html', import.meta.url);
  await Bun.write(filename, await prepareRuntimeShell(await Bun.file(filename).text()));
}
