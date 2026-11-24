import { chromium } from 'playwright';

export interface PaneBenchmarkDriver {
  version: string;
  navigate(url: string): Promise<void>;
  evaluate<T>(body: string, ...args: unknown[]): Promise<T>;
  click(x: number, y: number): Promise<void>;
  key(value: string): Promise<void>;
  clickThenKey(x: number, y: number, value: string): Promise<void>;
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  shortcut(): Promise<void>;
  close(): Promise<void>;
}

export const paneViewport = { width: 1840, height: 960 };
export const compactPaneViewport = { width: 480, height: 844 };

export async function openPaneBenchmarkDriver(
  engine: 'chromium' | 'gtk', endpoint?: string, viewport = paneViewport,
): Promise<PaneBenchmarkDriver> {
  if (engine === 'chromium') {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport, serviceWorkers: 'block' });
      return {
        version: browser.version(),
        navigate: async url => { await page.goto(url, { waitUntil: 'load' }); },
        evaluate: (body, ...args) => page.evaluate(`(function(){${body}}).apply(null,${JSON.stringify(args)})`),
        click: (x, y) => page.mouse.click(x, y),
        key: value => page.keyboard.press(value),
        clickThenKey: async (x, y, value) => {
          await page.mouse.click(x, y);
          await page.keyboard.press(value);
        },
        wheel: async (x, y, deltaY) => {
          await page.mouse.move(x, y);
          await page.mouse.wheel(0, deltaY);
        },
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
  const pointer = (x: number, y: number) => ({
    type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerMove', x, y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }],
  });
  const key = (name: string, pointerTicks = 0) => {
    const value = name === 'Backspace' ? '\uE003' : name;
    if ([...value].length !== 1) throw Error('Expected a single native key or Backspace');
    return { type: 'key', id: 'keyboard', actions: [
      ...Array.from({ length: pointerTicks }, () => ({ type: 'pause', duration: 0 })),
      { type: 'keyDown', value }, { type: 'keyUp', value },
    ] };
  };
  let wheelSequence = 0;
  const driver: PaneBenchmarkDriver = {
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
    click: (x, y) => post('/actions', { actions: [pointer(x, y)] }),
    key: value => post('/actions', { actions: [key(value)] }),
    // Consecutive W3C ticks put the key after pointerUp without inspecting or waiting for readiness.
    clickThenKey(x, y, value) {
      const click = pointer(x, y);
      return post('/actions', { actions: [click, key(value, click.actions.length)] });
    },
    // WebKitGTK 2.50.6 delivers only the first notch when the same input source is reused.
    wheel: (x, y, deltaY) => post('/actions', { actions: [{
      type: 'wheel', id: 'wheel-' + ++wheelSequence,
      actions: [{ type: 'scroll', x, y, deltaX: 0, deltaY, duration: 0 }],
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
    await post('/window/rect', viewport);
    const outer = await request('GET', route + '/window/rect');
    const inner = await driver.evaluate<typeof paneViewport>('return { width: innerWidth, height: innerHeight };');
    if (inner.width !== viewport.width || inner.height !== viewport.height) {
      await post('/window/rect', {
        width: outer.width + viewport.width - inner.width,
        height: outer.height + viewport.height - inner.height,
      });
    }
    return driver;
  } catch (error) {
    await driver.close();
    throw error;
  }
}
