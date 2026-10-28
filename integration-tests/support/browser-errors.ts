import type { BrowserContext } from 'playwright';

export function captureBrowserErrors(context: BrowserContext, errors: string[]): void {
  context.on('weberror', event => errors.push(`pageerror: ${event.error().message}`));
  context.on('console', message => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
}

export function consumeExpectedBrowserErrors(errors: string[], expected: readonly string[]): void {
  const actual = [...errors].sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((message, index) => message !== wanted[index])) {
    throw new Error(`Browser errors did not match the expected batch.\nExpected:\n${wanted.join('\n')}\nActual:\n${actual.join('\n')}`);
  }
  errors.splice(0);
}

export async function withExpectedConsoleErrors<T>(
  errors: string[],
  allowedMessages: readonly (string | RegExp)[],
  run: () => Promise<T>,
): Promise<T> {
  if (errors.length > 0) throw new Error(`Unexpected browser errors before fault injection:\n${errors.join('\n')}`);
  const result = await run();
  const unexpected = errors.filter(error => {
    if (!error.startsWith('console.error: ')) return true;
    const message = error.slice('console.error: '.length);
    return !allowedMessages.some(allowed => typeof allowed === 'string'
      ? message === allowed : message.match(allowed)?.[0] === message);
  });
  if (unexpected.length > 0) throw new Error(`Unexpected browser errors:\n${unexpected.join('\n')}`);
  errors.splice(0);
  return result;
}
