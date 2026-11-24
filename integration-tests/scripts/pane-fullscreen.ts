// Opt-in QA, not a CI latency gate. Run from the repo root against a current production build:
// bun integration-tests/scripts/pane-fullscreen.ts --engine=chromium [--smoke] [--panes=1,4,12] [--rounds=4]
// For WebKitGTK use --engine=gtk --webdriver=http://127.0.0.1:PORT (a dedicated MiniBrowser driver).
// Stdout is sanitized JSONL; only runs ending with "complete" include all checks and cleanup.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import type { PersistedWorkspaceLayoutNode, PersistedWorkspaceLayoutV2 } from '../../common/workspace-layout.js';
import { withTimeout } from '../support/deferred.js';
import { createIntegrationFixture } from '../support/integration-fixture.js';
import { requireCurrentWebBuild } from '../support/web-build-gate.js';
import { openPaneBenchmarkDriver, paneViewport } from './pane-benchmark-driver.js';
import { installFullscreenProbe } from './pane-fullscreen-probe.js';

const { values } = parseArgs({ options: {
  engine: { type: 'string' }, webdriver: { type: 'string' }, panes: { type: 'string' },
  rounds: { type: 'string', default: '4' }, smoke: { type: 'boolean', default: false },
} });
const engine = values.engine;
if (engine !== 'gtk' && engine !== 'chromium') throw new Error('Choose --engine=gtk or --engine=chromium.');
const counts = (values.panes ?? (values.smoke ? '4' : '1,4,12,12,4,1')).split(',').map(Number);
assert.ok(counts.length <= 12 && counts.every(n => [1, 4, 12].includes(n)), 'Supported pane counts: 1,4,12');
const rounds = Number(values.rounds);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 30, '--rounds must be 1..30');
const emit = (record: Record<string, unknown>) => console.log(JSON.stringify({ engine, ...record }));

function layout(chatIds: readonly string[]): PersistedWorkspaceLayoutV2 {
  function tree(start: number, size: number, depth: number): PersistedWorkspaceLayoutNode {
    if (size === 1) {
      const ref = { type: 'chat' as const, chatId: chatIds[start]! };
      return { type: 'window', id: start === 0 ? 'window-main' : 'window-fs-' + start,
        order: [ref], active: ref, mru: [ref] };
    }
    const left = Math.ceil(size / 2);
    return { type: 'partition', id: `partition-fs-${depth}-${start}`,
      direction: depth % 2 === 0 ? 'horizontal' : 'vertical', ratio: 0.5,
      children: [tree(start, left, depth + 1), tree(start + left, size - left, depth + 1)] };
  }
  return { version: 2, root: tree(0, chatIds.length, 0), unplacedTerminalIds: [] };
}

interface Snapshot {
  mounted: number; sameFeeds: number; presented: number; hiddenInert: number; hiddenOwners: number;
  fillsHost: boolean; originalTiles: boolean; ownership: boolean; draft: boolean; sameEditor: boolean;
  focus: string; browserFullscreen: boolean;
}
interface ReaderCheck { sameRow: boolean; deltaPx: number }
function assertReader(reader: ReaderCheck | null) {
  assert.ok(reader?.sameRow && Math.abs(reader.deltaPx) <= 1, 'Restored reader moved from its original row/offset');
}
function assertSnapshot(s: Snapshot, panes: number, enter: boolean) {
  assert.equal(s.mounted, panes);
  assert.equal(s.sameFeeds, panes, 'An original panel or feed was replaced');
  assert.equal(s.presented, enter ? 1 : panes);
  assert.equal(s.fillsHost, enter || panes === 1, 'Unexpected fullscreen target geometry');
  if (!enter) assert.ok(s.originalTiles, 'Tile geometry changed on restoration');
  assert.equal(s.hiddenInert, panes - s.presented);
  assert.equal(s.hiddenOwners, 0);
  assert.ok(s.ownership && s.draft && s.sameEditor && s.focus !== 'inert');
  assert.equal(s.browserFullscreen, false, 'Expected workspace fullscreen, not browser fullscreen');
}

await requireCurrentWebBuild();
const fixture = await createIntegrationFixture({ executionBackend: 'in-process', redactSensitiveDiagnostics: true });
try {
  async function finished(chatId: string, turnId: string | undefined) {
    assert.ok(turnId, 'Expected a turn identity, not an arbitrary terminal event');
    const terminal = await fixture.client.waitForTurnTerminal(chatId, turnId);
    assert.ok(terminal.type === 'agent-run-finished' && terminal.outcome === 'finished', 'Synthetic turn failed');
  }
  const ids: string[] = [];
  const catalog = values.smoke ? Math.max(...counts) : 12;
  const turnsPerChat = 8;
  for (let i = 0; i < catalog; i++) {
    const chatId = fixture.newChatId();
    ids.push(chatId);
    for (let turn = 0; turn < turnsPerChat; turn++) {
      const input = { chatId, agent: fixture.directAgents.openAi,
        content: `Synthetic turn ${turn + 1}.\n\nA short paragraph of plain text for the pane fullscreen check.\n\nAnother paragraph with **emphasis** for narrow panes.` };
      const started = turn === 0
        ? await fixture.client.startDirectChat({ ...input, projectPath: fixture.dirs.project })
        : await fixture.client.runDirectChat(input);
      await finished(chatId, started.turnId);
    }
  }
  const d = await openPaneBenchmarkDriver(engine, values.webdriver);
  try {
    const probe = <T>(method: string, ...args: unknown[]) =>
      d.evaluate<T>(`return window.fullscreenQA.${method}(...arguments);`, ...args);
    async function open(panes: number) {
      // Unload the previous app before seeding so pagehide persistence cannot overwrite the new layout.
      await d.navigate(fixture.garcon.baseUrl + '/robots.txt');
      await d.evaluate(`
        if (document.scripts.length) throw Error('Expected a neutral document');
        const [token, layout, ids] = arguments;
        localStorage.setItem('bearer-token', JSON.stringify({ token, epoch: null }));
        localStorage.setItem('workspace_layout_v2', JSON.stringify(layout));
        localStorage.setItem('pref_local_settings', JSON.stringify({ allowDirectChats: true, composerInputMode: 'source', combineToolUseMessages: true }));
        ids.forEach((id, i) => localStorage.setItem('chat_draft_' + id, 'Synthetic draft ' + i));
      `, fixture.garcon.authToken, layout(ids.slice(0, panes)), ids);
      await d.navigate(fixture.garcon.baseUrl + '/chat/' + ids[0]);
      const inner = await d.evaluate<typeof paneViewport>(`return (${installFullscreenProbe})(arguments[0]);`, panes);
      emit({ kind: 'layout', version: d.version, panes, catalog, turnsPerChat, ...inner });
      assert.deepEqual(inner, paneViewport, 'Viewport mismatch; do not mix these conditions');
      assertSnapshot(await probe<Snapshot>('snapshot'), panes, false);
      if (panes > 1) await probe('detachReader');
      assert.ok(Math.abs(await probe<number>('endGap')) <= 1, 'Expected an end-pinned active chat');
    }
    async function clickToggle(enter: boolean) {
      const point = await probe<{ x: number; y: number }>('arm', enter);
      await d.click(point.x, point.y);
      return probe<{ stateMs: number; twoFramesMs: number }>('finish');
    }
    async function shortcut(enter: boolean, panes: number) {
      await d.shortcut();
      await probe('waitLabel', enter);
      assertSnapshot(await probe<Snapshot>('snapshot'), panes, enter);
      assert.ok(await probe('selectedDraft'), 'Shortcut lost composer focus or text selection');
    }
    for (const [block, panes] of counts.entries()) {
      await open(panes);
      for (let trial = 0; trial <= (values.smoke ? 0 : rounds); trial++) {
        for (const enter of [true, false]) {
          const timing = await clickToggle(enter);
          const s = await probe<Snapshot>('snapshot');
          const reader = !enter && panes > 1 ? await probe<ReaderCheck>('restoredReader') : null;
          const endGapPx = !enter ? await probe<number>('endGap') : null;
          emit({ kind: values.smoke ? 'smoke' : 'gesture', block, panes, trial, direction: enter ? 'enter' : 'exit',
            warmup: trial === 0, ...(values.smoke ? {} : timing), ...s, reader, endGapPx });
          assertSnapshot(s, panes, enter);
          if (!enter && panes > 1) assertReader(reader);
          if (endGapPx !== null) assert.ok(Math.abs(endGapPx) <= 1, 'Active chat lost its end pin');
          assert.ok(timing.stateMs >= 0 && timing.twoFramesMs >= timing.stateMs, 'Invalid timestamps');
        }
      }
    }
    // Separate from timing: one hidden reader receives a held real turn before the original tile is revealed.
    const panes = Math.max(...counts);
    if (counts.at(-1) !== panes) await open(panes);
    await probe('prepareShortcut');
    await shortcut(true, panes);
    if (panes > 1) {
      const marker = 'Synthetic hidden delivery check';
      const before = await probe<number>('modelCount');
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: marker });
      try {
        const turn = await fixture.client.runDirectChat({ chatId: ids[1]!, agent: fixture.directAgents.openAi, content: marker });
        await withTimeout(held.received, 20_000, () => 'Synthetic hidden turn never reached the provider');
        await probe('waitProcessing', true);
        held.releaseEcho();
        await finished(ids[1]!, turn.turnId);
        // The terminal processing broadcast follows the same chat's committed messages on this socket.
        await probe('waitProcessing', false);
      } finally { held.releaseEcho(); }
      assert.equal(await probe('modelCount'), before, 'Hidden presentation changed');
      assert.equal(await probe('readerShows', marker), false);
      await shortcut(false, panes);
      const reader = await probe<ReaderCheck>('restoredReader');
      assertReader(reader);
      assert.ok(await probe<number>('modelCount') > before, 'New rows not projected on reveal');
      await probe('revealAppend', 'echo:' + marker);
      for (const n of [1, 0]) {
        const p = await probe<{x: number; y: number}>('pointToTab', n);
        await d.click(p.x, p.y);
        await probe('waitOwner', n);
      }
      emit({ kind: 'behavior', panes, shortcutFocusAndSelection: true, hiddenProcessingCycle: true,
        hiddenModelUnchanged: true, restoredResponse: true, switchedToCorrectDraftAndBack: true, reader });
    } else {
      await shortcut(false, panes);
      emit({ kind: 'behavior', panes, shortcutFocusAndSelection: true });
    }
  } finally { await d.close(); }
} finally { await fixture.dispose(); }
emit({ kind: 'complete' });
