// Opt-in browser comparison on an isolated synthetic fixture, not a CI timing threshold.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createIntegrationFixture } from '../support/integration-fixture.js';
import { requireCurrentWebBuild } from '../support/web-build-gate.js';
import { openPaneBenchmarkDriver, paneViewport } from './pane-benchmark-driver.js';
import { installTranscriptScrollProbe } from './transcript-scroll-probe.js';
import { stripeSampler } from './transcript-stripes.js';

const { values } = parseArgs({ options: {
  engine: { type: 'string', default: 'gtk' }, webdriver: { type: 'string' },
  modes: { type: 'string', default: 'normal' }, pairs: { type: 'string', default: '3' },
  corpus: { type: 'string', default: 'paragraphs' },
  'expect-bubble-shadow': { type: 'string' },
  'stripe-container': { type: 'string' }, 'stripe-display': { type: 'string' },
} });
const engine = values.engine, corpus = values.corpus;
assert.ok(engine === 'gtk' || engine === 'chromium');
assert.ok(!values['stripe-container'] || (engine === 'gtk' && values['stripe-display']));
assert.ok(corpus === 'paragraphs' || corpus === 'mixed');
const expectedShadow = values['expect-bubble-shadow'];
assert.ok(expectedShadow === undefined || expectedShadow === 'present' || expectedShadow === 'absent');
const queries: Record<string, string> = { normal: '', menu: '?rowMenu=inert',
  text: '?rowText=simple', both: '?rowMenu=inert&rowText=simple', top: '?rowPosition=top',
  clone: '?rowShell=clone', unpainted: '?noRowPaint=1', 'unpainted-clone': '?rowShell=clone&noRowPaint=1', flat: '?flatRowPaint=1',
  'bubble-shadow': '?rowPaint=bubble-shadow', shadows: '?rowPaint=shadows', corners: '?rowPaint=corners', transitions: '?rowPaint=transitions' };
const modes = values.modes!.split(','), pairs = Number(values.pairs);
assert.ok(modes[0] === 'normal' && modes.length <= 12 && modes.every(m => Object.hasOwn(queries, m)));
assert.ok(Number.isSafeInteger(pairs) && pairs > 0 && pairs <= 12);
const emit = (record: Record<string, unknown>) => console.log(JSON.stringify({
  engine, corpus, ...(values['stripe-container'] ? { pairedStripes: true } : {}), ...record,
}));
const meter = await readFile(new URL('../../docs/qa/webkit-spa-responsiveness/measure-wheel-train.js', import.meta.url), 'utf8');

function prompt(i: number): string {
  const intro = 'Synthetic turn ' + i + '\n\n', text = 'Content of variable height. '.repeat(3 + i % 7);
  if (corpus !== 'mixed' || i % 4 === 0) return intro + text;
  if (i % 4 === 1) return intro + 'Text with **emphasis** and a [reference](https://example.invalid/page).';
  if (i % 4 === 2) return intro + '```js\nconst count = ' + i + ';\n```';
  return intro + '- First item\n- Second item with `inline code`';
}
interface Position {
  index: number; offset: number; x: number; y: number; mounted: number[];
  triggers: number; inert: number; markdown: number; simple: number; topPlaced: number; cloned: number; cloneMisses: number;
  hiddenMessages: number; shadowed: number; rounded: number; buttonShadows: number; buttonTransitions: number;
}
interface Timing {
  wheelCount: number; pixelMode: boolean; wheelDelta: number; moved: number; wheelSpan: number;
  firstScroll: number; lastScroll: number; scrollCount: number; intervals: { start: number; end: number }[];
}
let normalBubbleShadow: boolean | undefined;
function checkVariant(pos: Position, mode: string) {
  if (normalBubbleShadow === undefined && mode === 'normal') {
    normalBubbleShadow = pos.shadowed > 0;
    if (expectedShadow) assert.equal(normalBubbleShadow, expectedShadow === 'present', 'Wrong baseline bubble shadow');
  }
  assert.ok(pos.markdown && pos.triggers, 'Missing real message renderer or menu triggers');
  assert.equal(pos.inert, mode === 'menu' || mode === 'both' ? pos.triggers : 0, 'Menu control inactive');
  if (mode === 'text' || mode === 'both') {
    assert.ok(pos.simple > 0 && (corpus !== 'mixed' || pos.simple < pos.markdown), 'Missing eligible rows or mixed-content fallback');
  } else assert.equal(pos.simple, 0);
  assert.equal(pos.topPlaced, mode === 'top' ? pos.mounted.length : 0, 'Row placement control inactive');
  if (mode === 'clone' || mode === 'unpainted-clone') assert.ok(pos.cloned > 0, 'No real-DOM clone entered');
  else assert.equal(pos.cloned, 0);
  assert.equal(pos.cloneMisses, 0, 'Uncaptured real row entered');
  assert.equal(pos.hiddenMessages, mode.startsWith('unpainted') ? pos.triggers : 0, 'Paint control inactive');
  if (mode === 'bubble-shadow') assert.ok(normalBubbleShadow, 'This build has no bubble shadow to remove');
  assert.equal(pos.shadowed > 0, normalBubbleShadow && !['flat', 'shadows', 'bubble-shadow'].includes(mode), 'Unexpected bubble shadows');
  assert.equal(pos.buttonShadows > 0, !['flat', 'shadows'].includes(mode), 'Unexpected button shadows');
  assert.equal(pos.rounded > 0, !['flat', 'corners'].includes(mode), 'Unexpected bubble corners');
  assert.equal(pos.buttonTransitions > 0, !['flat', 'transitions'].includes(mode), 'Unexpected button transitions');
}

await requireCurrentWebBuild();
const fixture = await createIntegrationFixture({ executionBackend: 'in-process', redactSensitiveDiagnostics: true });
try {
  const ids = [];
  async function done(id: string, turnId?: string) {
    assert.ok(turnId);
    const result = await fixture.client.waitForTurnTerminal(id, turnId);
    assert.ok(result.type === 'agent-run-finished' && result.outcome === 'finished');
  }
  for (let i = 0; i < 12; i++) {
    const chatId = fixture.newChatId();
    const content = Array.from({ length: 28 }, (_, j) => 'Synthetic paragraph ' + j + ' for pane ' + i + '.').join('\n\n');
    const run = await fixture.client.startDirectChat({ chatId, content, agent: fixture.directAgents.openAi, projectPath: fixture.dirs.project });
    await done(chatId, run.turnId);
    ids.push(chatId);
  }
  const chatId = ids[0]!;
  for (let i = 0; i < 48; i++) {
    const run = await fixture.client.runDirectChat({ chatId, content: prompt(i), agent: fixture.directAgents.openAi });
    await done(chatId, run.turnId);
  }
  const d = await openPaneBenchmarkDriver(engine, values.webdriver);
  try {
    const probe = <T>(method: string, ...args: unknown[]) => d.evaluate<T>(`return window.rowEntryQA.${method}(...arguments)`, ...args);
    const origin = fixture.garcon.baseUrl;
    await d.navigate(origin + '/robots.txt');
    await d.evaluate(`if(document.scripts.length)throw Error('Expected neutral document');
      const [token,id]=arguments, ref={type:'chat',chatId:id};
      localStorage.setItem('bearer-token',JSON.stringify({token,epoch:null}));
      localStorage.setItem('pref_local_settings',JSON.stringify({allowDirectChats:true,composerInputMode:'formatted'}));
      localStorage.setItem('workspace_layout_v2',JSON.stringify({version:2,root:{type:'window',id:'window-main',order:[ref],active:ref,mru:[ref]},unplacedTerminalIds:[]}));
    `, fixture.garcon.authToken, chatId);
    const endByDirection = new Map<number, [number, number]>();
    for (const [block, mode] of modes.entries()) {
      await d.navigate(origin + '/chat/' + chatId + queries[mode]);
      await d.evaluate(meter);
      await d.evaluate(`return (${installTranscriptScrollProbe})()`);
      const { contentDigest, ...setup } = await probe<{
        rows: number; width: number; height: number; inner: number[]; contentDigest: string;
      }>('prepare');
      assert.deepEqual(setup, { rows: 100, width: 1520, height: 806, inner: [paneViewport.width, paneViewport.height] });
      assert.match(contentDigest, /^[a-f0-9]{64}$/);
      emit({ kind: 'block', version: d.version, block, mode, ...setup, contentDigest });
      let stripes;
      if (values['stripe-container']) {
        await probe('anchor', 46);
        stripes = await stripeSampler(d, values['stripe-container'], values['stripe-display']!);
      }
      for (let pair = 0; pair <= pairs; pair++) for (const sign of [1, -1]) {
        const pre = await probe<Position>('anchor', sign === 1 ? 46 : 66);
        if (pair > 0) checkVariant(pre, mode);
        await probe('begin');
        const endStripes = await stripes?.start();
        const start = performance.now();
        for (let j = 0; j < 14; j++) {
          await Bun.sleep(Math.max(0, start + j * 60 - performance.now()));
          await d.wheel(pre.x, pre.y, 120 * sign);
        }
        const lastAckUs = stripes?.now();
        const { timing: t, post } = await probe<{ timing: Timing; post: Position }>('finish');
        if (endStripes) emit({ kind: 'stripes', version: d.version, block, pair, sign, ...await endStripes(lastAckUs!) });
        checkVariant(post, mode);
        assert.equal(t.wheelCount, 14); assert.ok(t.pixelMode); assert.equal(t.wheelDelta, sign * 1680);
        assert.ok(Math.abs(t.moved - t.wheelDelta) <= 1 && t.intervals.length > 0);
        const reference = endByDirection.get(sign);
        if (reference) assert.deepEqual([post.index, post.offset], reference, 'Different end anchor');
        else endByDirection.set(sign, [post.index, post.offset]);
        emit({ kind: 'train', block, mode, pair, sign, index: pre.index, offset: pre.offset, endIndex: post.index, endOffset: post.offset,
          entered: post.mounted.filter(i => !pre.mounted.includes(i)).length, mounted: post.mounted.length,
          markdown: post.markdown, simple: post.simple, triggers: post.triggers, inert: post.inert, topPlaced: post.topPlaced,
          cloned: post.cloned, hiddenMessages: post.hiddenMessages, shadowed: post.shadowed, rounded: post.rounded,
          buttonShadows: post.buttonShadows, buttonTransitions: post.buttonTransitions,
          wheels: t.wheelCount, dy: t.wheelDelta, moved: t.moved, wheelSpan: t.wheelSpan, scrolls: t.scrollCount,
          lastScroll: t.lastScroll, before: t.intervals[0]!.start, callbacks: t.intervals.map(i => i.end) });
      }
    }
  } finally { await d.close(); }
} finally { await fixture.dispose(); }
emit({ kind: 'complete' });
