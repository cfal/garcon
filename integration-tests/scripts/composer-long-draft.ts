import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createIntegrationFixture } from '../support/integration-fixture.js';
import { requireCurrentWebBuild } from '../support/web-build-gate.js';
import { composerInputProbe } from './composer-input-probe.js';
import { openPaneBenchmarkDriver } from './pane-benchmark-driver.js';

const { values } = parseArgs({ options: { webdriver: { type: 'string' }, block: { type: 'string' } } });
assert.ok(values.webdriver && /^[0-3]$/.test(values.block ?? ''), 'Supply --webdriver=<loopback URL> and --block=0..3');
const block = Number(values.block);
const viewport = { width: 480, height: 844 };
const shapes = [
  ['short', 250, 'Check the work_queue & path [0] here. '],
  ['plain', 24_000, 'Check the work_queue & path [0] here. '],
  ['unfinished', 24_000, 'begin [field [value [lookup '],
] as const;

await requireCurrentWebBuild();
const fixture = await createIntegrationFixture({ executionBackend: 'in-process', redactSensitiveDiagnostics: true });
try {
  const id = fixture.newChatId();
  const turn = await fixture.client.startDirectChat({
    chatId: id, agent: fixture.directAgents.openAi, projectPath: fixture.dirs.project, content: 'Synthetic prompt',
  });
  assert.ok(turn.turnId);
  const end = await fixture.client.waitForTurnTerminal(id, turn.turnId);
  assert.ok(end.type === 'agent-run-finished' && end.outcome === 'finished');
  const driver = await openPaneBenchmarkDriver('gtk', values.webdriver, viewport);
  try {
    type Probe = ReturnType<typeof composerInputProbe>;
    const call = <K extends keyof Probe>(method: K, ...args: Parameters<Probe[K]>) =>
      driver.evaluate<Awaited<ReturnType<Probe[K]>>>(`return window.inputQA.${method}(...arguments)`, ...args);
    for (const [shape, length, unit] of block % 2 === 0 ? shapes : [...shapes].reverse()) {
      const draft = unit.repeat(Math.ceil(length / unit.length)).slice(0, length - 1) + '.';
      await driver.navigate(fixture.garcon.baseUrl + '/robots.txt');
      await driver.evaluate(`
        if (document.scripts.length) throw Error('Expected neutral document');
        const [token,id,draft] = arguments;
        localStorage.setItem('bearer-token', JSON.stringify({token,epoch:null}));
        localStorage.setItem('pref_local_settings', JSON.stringify({allowDirectChats:true,composerInputMode:'formatted'}));
        localStorage.setItem('chat_draft_'+id, draft);
      `, fixture.garcon.authToken, id, draft);
      await driver.navigate(fixture.garcon.baseUrl + '/chat/' + id);
      await driver.evaluate(`window.inputQA=(${composerInputProbe})(...arguments)`, [id], [draft], true);
      assert.deepEqual(await call('start', 0), { ...viewport, visible: 1 });
      await driver.evaluate(`document.querySelector('[data-composer-markdown-editor] [role=textbox]').focus()`);
      await call('focusReady', 0);
      for (let key = 0; key < 4; key++) {
        await call('position', 0, 6);
        await call('arm', 0, 6, false);
        await driver.key('x');
        const result = await call('result');
        console.log(JSON.stringify({ block, shape, length, key, ...result }));
        assert.equal(result.ok, true);
        await driver.key('Backspace');
        await call('restored', 0, 6);
      }
      await call('close');
    }
  } finally { await driver.close(); }
} finally { await fixture.dispose(); }
