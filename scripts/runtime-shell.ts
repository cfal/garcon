import ts from 'typescript';
import { RUNTIME_BASE_PATH_TOKEN } from '../common/runtime-shell.js';

// Validates SvelteKit's generated bootstrap at build time, never rewrites hashed bundles.
export async function prepareRuntimeShell(html: string): Promise<string> {
  if (html.includes(RUNTIME_BASE_PATH_TOKEN)) {
    throw new Error('Web shell already contains the runtime base token');
  }
  let bootstrapCount = 0;
  let entryImportCount = 0;
  let serviceWorkerCount = 0;

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
  return transformed;
}

if (import.meta.main) {
  const filename = new URL('../web/build/index.html', import.meta.url);
  await Bun.write(filename, await prepareRuntimeShell(await Bun.file(filename).text()));
}
