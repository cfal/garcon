import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { openPaneBenchmarkDriver } from './pane-benchmark-driver.js';

function markColumns() {
  const view = document.querySelector<HTMLElement>('[data-chat-scroll-viewport]')!;
  const sizer = view.querySelector<HTMLElement>('[data-chat-virtual-sizer]')!;
  const root = '[data-chat-virtual-sizer]', row = root + ' > [data-chat-virtual-item]:has([data-chat-row-id])';
  const css = document.createElement('style');
  css.textContent = root + '{background-image:linear-gradient(#ff00ff,#ff00ff),linear-gradient(#ff7900,#ff7900);' +
    'background-repeat:no-repeat;background-size:6px 100%;background-position:2px 0,1006px 0}' +
    row + '{--ink:#00ff00}' + row + ':nth-child(odd){--ink:#00ffff}' +
    row + '::after{content:"";position:absolute;inset:0;z-index:9;pointer-events:none;' +
    'background-image:linear-gradient(var(--left,var(--ink)),var(--left,var(--ink))),linear-gradient(var(--right,var(--ink)),var(--right,var(--ink)));' +
    'background-repeat:no-repeat;background-size:6px 100%;background-position:2px 0,1006px 0}';
  document.head.append(css);
  const marks: HTMLElement[] = [];
  let writes = 0;
  const prop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
  Object.defineProperty(view, 'scrollTop', { configurable: true, get() { return prop.get!.call(view); },
    set(v) { writes++; prop.set!.call(view, v); } });
  for (const name of ['scroll', 'scrollTo', 'scrollBy'] as const) {
    const original = view[name];
    Object.defineProperty(view, name, { configurable: true, value(...args: unknown[]) { writes++; return Reflect.apply(original, view, args); } });
  }
  view.scrollTop = view.scrollTop; view.scrollBy(0, 0);
  if (writes !== 2 || devicePixelRatio !== 1) throw Error('Bad writer or device-scale control');
  Object.assign(window, { stripes: {
    locate() {
      const x = sizer.getBoundingClientRect().left, y = view.getBoundingClientRect().top;
      for (const [pos, color] of [[4, '#d123f7'], [1008, '#e84712']] as const) {
        const e = document.createElement('div');
        e.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:2px;height:2px;' +
          'left:' + (x + pos) + 'px;top:' + y + 'px;background:' + color;
        document.body.append(e); marks.push(e);
      }
    },
    control(side: string) {
      for (const e of marks.splice(0)) e.remove();
      const r = sizer.querySelector<HTMLElement>('[data-index="52"]')!;
      r.style.removeProperty('--left'); r.style.removeProperty('--right');
      if (side !== 'none') r.style.setProperty('--' + side, 'transparent');
      const rect = r.getBoundingClientRect();
      return [rect.top - view.getBoundingClientRect().top, rect.height];
    },
    reset() { writes = 0; },
    result() {
      const v = view.getBoundingClientRect();
      const visible = Array.from(sizer.querySelectorAll<HTMLElement>(':scope > [data-chat-virtual-item]')).flatMap(el => {
        const r = el.getBoundingClientRect();
        return r.bottom > v.top && r.top < v.bottom ? [[Number(el.dataset.index), r.top - v.top, r.height]] : [];
      });
      return { writes, visible };
    },
  } });
}

export async function stripeSampler(d: Awaited<ReturnType<typeof openPaneBenchmarkDriver>>, container: string, display: string) {
  const source = await readFile(new URL('../../docs/qa/webkit-spa-responsiveness/sample-x11-columns.py', import.meta.url), 'utf8');
  const libc = dlopen('libc.so.6', { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
  const timespec = new BigInt64Array(2);
  const now = () => {
    assert.equal(libc.symbols.clock_gettime(1, ptr(timespec)), 0);
    return Number(timespec[0]! * 1000000n + timespec[1]! / 1000n);
  };
  const run = (args: string[]) => spawn('docker', ['exec', '-e', 'DISPLAY=' + display, container, 'python3', '-u', '-c', source, ...args]);
  const invoke = <T>(method: string, ...args: unknown[]) => d.evaluate<T>(`return window.stripes.${method}(...arguments)`, ...args);
  await d.evaluate(`return (${markColumns})()`);
  await invoke('locate'); await Bun.sleep(250);
  const fid = run(['locate']);
  const lines: number[][] = [];
  for await (const line of createInterface({ input: fid.stdout })) lines.push(line.split(' ').map(Number));
  assert.equal(lines.length, 2, 'Both independent fiducials required');
  const [[x, y], [x2, y2]] = lines as [[number, number], [number, number]];
  assert.equal(y, y2); assert.equal(x2 - x, 1004);
  async function acquire(count: number) {
    const before = now();
    const proc = run([x, x2, y, 806, count].map(String));
    const done = new Promise<number | null>((resolve, reject) => { proc.once('close', resolve); proc.once('error', reject); });
    const data = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
    const first = await data.next(), ready = String(first.value).split(' ');
    assert.equal(ready[0], 'ready'); assert.ok(+ready[1]! >= before && +ready[1]! <= now(), 'Host/X11 clocks differ');
    return async () => {
      const samples: number[][] = [];
      for await (const line of data) samples.push(line.split(' ').map(Number));
      assert.equal(await done, 0); assert.equal(samples.length, count); return samples;
    };
  }
  for (const side of ['none', 'left', 'right', 'none']) {
    const [top, height] = await invoke<[number, number]>('control', side);
    await Bun.sleep(220);
    const samples = await (await acquire(3))();
    for (const [, , l, r, common, ol, oright, first, last] of samples) {
      assert.deepEqual([l! + ol!, r! + oright!, common, first, last],
        [side === 'left' ? height : 0, side === 'right' ? height : 0, 0, side === 'none' ? 806 : top, side === 'none' ? -1 : top + height - 1],
        'Static or one-sided marker control: ' + side);
      if (side !== 'none') assert.ok((side === 'left' ? l! : r!) > 0, 'No underlying sizer ink');
    }
  }
  return {
    now,
    async start() {
      await invoke('reset');
      const pre = await invoke<{ writes: number; visible: number[][] }>('result');
      const samples = await acquire(256);
      const start = now();
      return async (end: number) => {
        const data = await samples();
        const post = await invoke<typeof pre>('result');
        assert.equal(post.writes, 0, 'JS changed the viewport');
        assert.ok(data.at(-1)![1]! > end + 1000000, 'Incomplete post-dispatch window');
        const phases = [data.filter(s => s[0]! > start && s[1]! < end), data.filter(s => s[0]! > end && s[1]! < end + 1000000)];
        return { pre: pre.visible, post: post.visible, writes: post.writes, phases: phases.map(rows => ({
          pairs: rows.length, common: rows.filter(s => s[4]! > 0).length, maxBand: Math.max(0, ...rows.map(s => s[4]!)),
        })), samples: data.map(([a,b,...pixels]) => [a!-start,b!-start,...pixels]), armToAckUs: end-start };
      };
    },
  };
}
