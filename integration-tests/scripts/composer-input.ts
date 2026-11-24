// Opt-in, isolated production workload; see docs/qa/webkit-spa-responsiveness/composer-input.md.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import type { PersistedWorkspaceLayoutNode, PersistedWorkspaceLayoutV2 } from '../../common/workspace-layout.js';
import { createIntegrationFixture } from '../support/integration-fixture.js';
import { requireCurrentWebBuild } from '../support/web-build-gate.js';
import { compactPaneViewport, openPaneBenchmarkDriver, paneViewport } from './pane-benchmark-driver.js';
import { composerInputClient, composerInputProbe } from './composer-input-probe.js';
import { drawerFocusProbe } from './composer-input-focus-probe.js';
import { receiverPositionProbe } from './receiver-position-probe.js';

const { values } = parseArgs({ options: {
  webdriver: { type: 'string' }, viewport: { type: 'string', default: 'desktop' }, smoke: { type: 'boolean' },
  'focus-diagnostic': { type: 'boolean' },
  'receiver-position': { type: 'string' }, 'receiver-counters': { type: 'boolean' },
} });
assert.ok(values.webdriver && ['desktop', 'compact'].includes(values.viewport!),
  'Use --webdriver=http://127.0.0.1:PORT --viewport=desktop|compact [--smoke]');
const compact = values.viewport === 'compact';
const viewport = compact ? compactPaneViewport : paneViewport;
const diagnostic = values['focus-diagnostic'] ?? false;
const position = values['receiver-position'], counters = !!values['receiver-counters'];
assert.ok(!position || (!compact && !diagnostic && ['pinned', 'detached'].includes(position)));
assert.ok(!counters || position);
assert.ok(!diagnostic || (compact && !values.smoke), 'The focus diagnostic runs only on compact, separately from smoke');
const emit = (kind: string, data: Record<string, unknown>) => console.log(JSON.stringify({ kind, viewport: values.viewport, ...data }));
const drafts = ['First synthetic draft.', 'Other synthetic draft.', '', ''];
const layout = (ids: readonly string[]): PersistedWorkspaceLayoutV2 => {
  const tiles: PersistedWorkspaceLayoutNode[] = ids.map((id, n) => {
    const ref = { type: 'chat' as const, chatId: id };
    return { type: 'window', id: n === 0 ? 'window-main' : 'window-qa-' + n, active: ref, order: [ref], mru: [ref] };
  });
  const split = (n: number, dir: 'horizontal' | 'vertical', a: PersistedWorkspaceLayoutNode, b: PersistedWorkspaceLayoutNode): PersistedWorkspaceLayoutNode =>
    ({ type: 'partition', id: 'partition-qa-' + n, direction: dir, ratio: 0.5, children: [a, b] });
  return { version: 2, root: split(0, 'horizontal', split(1, 'vertical', tiles[0]!, tiles[1]!), split(2, 'vertical', tiles[2]!, tiles[3]!)), unplacedTerminalIds: [] };
};

await requireCurrentWebBuild();
const f = await createIntegrationFixture({ executionBackend: 'in-process', redactSensitiveDiagnostics: true });
let failures = 0, activeOverlap = 0;
try {
  async function terminal(id: string, turnId?: string) {
    assert.ok(turnId, 'No turn identity');
    const end = await f.client.waitForTurnTerminal(id, turnId);
    assert.ok(end.type === 'agent-run-finished' && end.outcome === 'finished', 'Synthetic turn did not complete');
  }
  const ids: string[] = [];
  for (let n = 0; n < drafts.length; n++) {
    const chatId = f.newChatId(); ids.push(chatId);
    const r = await f.client.startDirectChat({ chatId, agent: f.directAgents.openAi, projectPath: f.dirs.project,
      content: 'Synthetic initial paragraph ' + n });
    await terminal(chatId, r.turnId);
  }
  if (position) for (let i = 0; i < 40; i++) {
    const id = ids[2]!;
    await terminal(id, (await f.client.runDirectChat({ chatId: id, agent: f.directAgents.openAi,
      content: 'Synthetic reader history ' + i + '. ' + 'A fixed paragraph. '.repeat(8) })).turnId);
  }
  const d = await openPaneBenchmarkDriver('gtk', values.webdriver, viewport);
  try {
    const call = composerInputClient(d);
    async function open(index: number) {
      await d.navigate(f.garcon.baseUrl + '/robots.txt');
      await d.evaluate(`
        if(document.scripts.length)throw Error('Expected a neutral document');
        const [token,layout,ids,drafts]=arguments;
        localStorage.setItem('bearer-token',JSON.stringify({token,epoch:null}));
        localStorage.setItem('workspace_layout_v2',JSON.stringify(layout));
        localStorage.setItem('pref_local_settings',JSON.stringify({allowDirectChats:true,composerInputMode:'formatted'}));
        ids.forEach((id,i)=>localStorage.setItem('chat_draft_'+id,drafts[i]));
      `, f.garcon.authToken, layout(ids), ids, drafts);
      await d.navigate(f.garcon.baseUrl + '/chat/' + ids[index]);
      await d.evaluate(`window.inputQA=(${composerInputProbe})(...arguments);return true;`, ids, drafts, compact, !compact && !position);
      const initial = await call('start', index);
      assert.deepEqual(initial, { ...viewport, visible: compact ? 1 : 4 }, 'Unexpected initial layout');
    }
    async function navPoint(index: number) {
      if (compact) { const m = await call('menu'); assert.ok(m, 'Mobile menu covered'); await d.click(m.x, m.y); }
      return call('row', index);
    }
    async function navigate(index: number, text: string) {
      const p = await navPoint(index); await d.click(p.x, p.y);
      return call('state', index, text);
    }
    const receiver = ids[2]!;
    async function steadyKeys() {
      await open(0);
      // One normal turn makes the app socket identifiable before any measured sample.
      await terminal(receiver, (await f.client.runDirectChat({ chatId: receiver, agent: f.directAgents.openAi, content: 'Synthetic calibration' })).turnId);
      await call('socketReady');
      const p = await call('editorPoint'); assert.ok(p, 'Editor covered'); await d.click(p.x, p.y); await call('focusReady', 0);
      type Reader = ReturnType<typeof receiverPositionProbe>;
      const reader = <K extends keyof Reader>(name: K, ...args: Parameters<Reader[K]>) =>
        d.evaluate<Awaited<ReturnType<Reader[K]>>>(`return window.readerQA.${name}(...arguments)`, ...args);
      if (position) {
        await d.evaluate(`window.readerQA=(${receiverPositionProbe})(...arguments);return true`, receiver, position === 'pinned', counters);
        const point = await reader('point');
        await d.wheel(point.x, point.y, position === 'pinned' ? 1920 : -1920);
        await Bun.sleep(350);
        emit('reader-start', { position, counters, ...await reader('start') });
      }
      const offset = 6;
      let sequence = 0, lastReply = '', lastRow = '';
      async function trial(active: boolean, block: number, key: number) {
        const tag = String(++sequence).padStart(3, '0'), prompt = 'Synthetic request ' + tag, reply = 'Synthetic response ' + tag;
        lastReply = reply;
        await call('beginTurn', prompt, reply);
        const held = f.fakeProviders.openAi.holdNext({ lastUserText: prompt });
        const run = () => f.client.runDirectChat({ chatId: receiver, agent: f.directAgents.openAi, content: prompt });
        let turn: Awaited<ReturnType<typeof run>> | undefined;
        try {
          if (position) await reader('beginTurn');
          if (active) {
            turn = await run(); await held.received; await call('userSeen');
            if (position) {
              const [user] = await call('wireRows'); assert.ok(user);
              await reader('after', user.view + ':' + user.ordinal, 1);
            }
          }
          await call('position', 0, offset); await call('arm', 0, offset, false);
          if (active) {
            const nativeKey = d.key('x');
            assert.ok(held.releaseText(reply), 'Provider response not released');
            await nativeKey;
          } else await d.key('x');
          const edit = await call('result');
          if (!active) { turn = await run(); await held.received; assert.ok(held.releaseText(reply)); }
          await terminal(receiver, turn!.turnId);
          const delivery = await call('delivery');
          let receiverResult;
          if (position) {
            const wire = await call('wireRows');
            const page = await f.client.getMessages(receiver, { limit: 4 });
            assert.deepEqual(wire, page.messages.slice(-2).map(m => ({ ordinal: m.ordinal, view: page.transcriptViewId })));
            assert.deepEqual(page.messages.slice(-2).map(m => m.message.type), ['user-message', 'assistant-message']);
            lastRow = wire[1]!.view + ':' + wire[1]!.ordinal;
            receiverResult = await reader('after', lastRow, 2);
          }
          emit('key', { block, key, active, ...(position ? { position, counters, receiver: receiverResult } : {}), ...edit, ...delivery });
          if (block >= 0 && active && delivery.duringKey > 0) activeOverlap++;
          assert.equal(edit.ok, true, 'Incorrect steady editor input; remaining keys cannot share its precondition');
          assert.ok(active ? delivery.userMs <= 0 : delivery.beforeKey === 0 && delivery.duringKey === 0, 'Wrong treatment window');
          await d.key('Backspace'); await call('restored', 0, offset);
        } finally { held.releaseEcho(); }
      }
      if (position) {
        await trial(true, -1, 0);
        if (!values.smoke) for (let key = 0; key < (counters ? 2 : 4); key++) await trial(true, 0, key);
        if (position === 'detached') { const at = await reader('revealPoint'); await d.click(at.x, at.y); }
        await reader('revealed', lastRow); await call('responseVisible', lastReply);
        await reader('close'); await call('close'); return;
      }
      const order = compact ? [true, false, false, true] : [false, true, true, false];
      for (const active of [false, true]) await trial(active, -1, 0);
      if (!values.smoke) for (const [block, active] of order.entries()) {
        for (let key = 0; key < 4; key++) await trial(active, block, key);
      }
      await navigate(2, ''); await call('responseVisible', lastReply);
      assert.ok((await navigate(0, drafts[0]!)).correct, 'Background reveal modified foreground draft');
      await call('close');
    }

    emit('setup', { version: d.version, ...viewport, visible: compact ? 1 : 4, mode: 'formatted', smoke: !!values.smoke, diagnostic });
    if (!diagnostic) await steadyKeys();
    else {
      // Matches the preceding calibration and eighteen short turns without running more measured keys.
      for (let i = 0; i < 19; i++) await terminal(receiver,
        (await f.client.runDirectChat({ chatId: receiver, agent: f.directAgents.openAi, content: 'Synthetic history ' + i })).turnId);
    }

    // Each direction starts clean; an earlier lost/misrouted character cannot contaminate a later trial.
    const moves = diagnostic ? [[0,1],[1,0],[1,1],[1,0],[0,1],[0,0],[1,0],[0,1]] :
      (values.smoke ? [0] : [0, 1, 1, 0]).map(start => [start, 1-start]);
    for (const [start, dest] of position ? [] : moves) {
      await open(start);
      assert.ok((await navigate(1-start, drafts[1-start]!)).correct, 'Could not warm opposite draft');
      assert.ok((await navigate(start, drafts[start]!)).correct, 'Could not warm origin');
      if (diagnostic) await d.evaluate(`window.finishFocusProbe=(${drawerFocusProbe})(...arguments);return true`, ids, drafts);
      const point = await navPoint(dest);
      await call('arm', dest, drafts[dest]!.length, true);
      await d.clickThenKey(point.x, point.y, 'x');
      const edit = await call('result');
      if (diagnostic) emit('focus-stages', { start, dest, stages: await d.evaluate('return window.finishFocusProbe()') });
      const old = await navigate(1-dest, drafts[1-dest]!);
      const back = await navigate(dest, drafts[dest]! + 'x');
      const restored = (view: typeof old, end: number) =>
        view.focus && view.caret?.[0] === end && view.caret[1] === end;
      const roundtripCarets = restored(old, drafts[1-dest]!.length) && restored(back, drafts[dest]!.length + 1);
      const pass = edit.ok && old.correct && old.pinned && back.correct && back.pinned && (!diagnostic || roundtripCarets);
      emit('first-edit', { start, dest, ...edit, oldUnchanged: old.correct, destinationRoundtrip: back.correct,
        ...(diagnostic ? { roundtripCarets, otherDraft: old, selectedDraft: back } : {}), pass });
      if (!pass) failures++;
      await call('close');
    }
  } finally { await d.close(); }
} finally { await f.dispose(); }
emit('complete', { failures, activeOverlap, smoke: !!values.smoke });
if (failures) process.exitCode = 1;
