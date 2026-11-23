import { chromium } from 'playwright';

export interface FullscreenDriver {
  version: string;
  navigate(url: string): Promise<void>;
  evaluate<T>(body: string, ...args: unknown[]): Promise<T>;
  click(x: number, y: number): Promise<void>;
  shortcut(): Promise<void>;
  close(): Promise<void>;
}

export const fullscreenViewport = { width: 1840, height: 960 };

export async function openFullscreenDriver(
  engine: 'chromium' | 'gtk', endpoint?: string,
): Promise<FullscreenDriver> {
  if (engine === 'chromium') {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: fullscreenViewport, serviceWorkers: 'block' });
      return {
        version: browser.version(),
        navigate: async url => { await page.goto(url, { waitUntil: 'load' }); },
        evaluate: (body, ...args) => page.evaluate(`(function(){${body}}).apply(null,${JSON.stringify(args)})`),
        click: (x, y) => page.mouse.click(x, y),
        shortcut: () => page.keyboard.press('Control+Shift+F'),
        close: () => browser.close(),
      };
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  if (!endpoint) throw new Error('gtk requires --webdriver=<local WebKitWebDriver URL>');
  const address = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) {
    throw new Error('Use an isolated local GTK driver.');
  }
  const request = async (method: string, path: string, payload?: unknown) => {
    const response = await fetch(new URL(path, address), {
      method, headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
    const { value } = await response.json();
    if (!response.ok || value?.error) throw new Error(`WebDriver: ${value?.error ?? response.status}: ${value?.message ?? ''}`);
    return value;
  };
  const session = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'MiniBrowser' } } });
  const route = '/session/' + session.sessionId;
  const post = (path: string, payload: unknown) => request('POST', route + path, payload);
  const driver: FullscreenDriver = {
    version: session.capabilities.browserVersion,
    navigate: url => post('/url', { url }),
    async evaluate(body, ...args) {
      const result = await post('/execute/async', {
        script: `const done = arguments[arguments.length - 1]; Promise.resolve().then(() => (function(){${body}}).apply(null,arguments[0])).then(value => done({value}), error => done({failure: String(error)}));`,
        args: [args],
      });
      if (result.failure) throw new Error(result.failure);
      return result.value;
    },
    click: (x, y) => post('/actions', { actions: [{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerMove', x, y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }],
    }] }),
    shortcut: () => post('/actions', { actions: [{
      type: 'key', id: 'keyboard', actions: [
        { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: '\uE008' },
        { type: 'keyDown', value: 'f' }, { type: 'keyUp', value: 'f' },
        { type: 'keyUp', value: '\uE008' }, { type: 'keyUp', value: '\uE009' },
      ],
    }] }),
    close: () => request('DELETE', route),
  };
  try {
    await post('/timeouts', { script: 35_000, pageLoad: 35_000 });
    await post('/window/rect', fullscreenViewport);
    const outer = await request('GET', route + '/window/rect');
    const inner = await driver.evaluate<{ width: number; height: number }>('return { width: innerWidth, height: innerHeight };');
    if (inner.width !== fullscreenViewport.width || inner.height !== fullscreenViewport.height) {
      await post('/window/rect', {
        width: outer.width + fullscreenViewport.width - inner.width,
        height: outer.height + fullscreenViewport.height - inner.height,
      });
    }
    return driver;
  } catch (error) {
    await driver.close();
    throw error;
  }
}
