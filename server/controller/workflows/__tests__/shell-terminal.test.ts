import { expect, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkflowDefinition } from '../../../../common/workflow-definition.js';
import { NativeLog } from '../../../../server-agents/shell/src/native-store.js';
import { managedController, managedRuntime, managedWorkspace } from '../../automation/__tests__/fixture.js';
import { createWorkflowRunner } from '../automation-runner.js';
import { WorkflowEngine } from '../engine.js';
import { WorkflowStore } from '../store.js';

const actor = { id: 'synthetic-operator', name: 'Example operator' };

test.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'requires Shell exit evidence before allowing a workflow retry', async () => {
    const workspace = await managedWorkspace();
    const runtime = managedRuntime(workspace, 'local', 'shell');
    const controller = await managedController(workspace, runtime, 'local', 'shell');
    const engine = new WorkflowEngine({ store: new WorkflowStore(workspace.root),
      runner: createWorkflowRunner(controller.automation, async () => { throw new Error('Shell takes no attachments'); }) });
    const append = NativeLog.prototype.append;
    let lostResult = false;
    const fault = spyOn(NativeLog.prototype, 'append').mockImplementation(function (this: NativeLog, ...args) {
      const [, message] = args;
      if (!lostResult && message.type === 'command-result' && message.result.exitCode === 0) {
        lostResult = true;
        throw new Error('Synthetic native history I/O failure after Shell exited');
      }
      return append.apply(this, args);
    });
    const sideEffect = join(workspace.project, 'executions.txt');
    function launch(command: string, shell = 'sh') {
      const source = `version: 1\nname: Shell evidence\nsteps:\n  - { id: command, kind: command, shell: ${shell}, command: ${JSON.stringify(command)} }\n`;
      const parsed = parseWorkflowDefinition(source);
      if (!parsed.definition) throw new Error(JSON.stringify(parsed.diagnostics));
      return engine.testWorkflowDraft({ source, inputs: {},
        executionContext: { defaultTarget: { executorId: 'local', projectPath: workspace.project } } }, parsed.definition).id;
    }
    async function settled(runId: string, count = 1) {
      for (let n = 0; n < 500; n++) {
        const instance = engine.getRun(runId).steps[0]?.instances[0];
        if (instance?.attempts.length === count && instance.attempts.at(-1)?.finishedAt) return instance;
        await Bun.sleep(5);
      }
      throw new Error('Shell attempt did not settle');
    }
    try {
      await engine.start();
      const missingEvidence = launch(`printf '%s\\n' ran >> executions.txt`);
      const unknown = await settled(missingEvidence);
      expect(lostResult).toBe(true);
      expect(await readFile(sideEffect, 'utf8')).toBe('ran\n');
      expect(unknown.status).toBe('unknown');
      expect(engine.getRun(missingEvidence).signals).toEqual([]);
      expect(() => engine.retry({ runId: missingEvidence, instanceId: unknown.id, operationId: 'unknown-retry' }, actor))
        .toThrow('Only a definitively failed attempt can be retried.');

      const nonzero = launch('exit 7');
      const failed = await settled(nonzero);
      expect(failed).toMatchObject({ status: 'failed', attempts: [{ status: 'failed', reason: expect.stringContaining('Exit 7') }] });
      engine.retry({ runId: nonzero, instanceId: failed.id, operationId: 'known-retry' }, actor);
      expect((await settled(nonzero, 2)).attempts.map(({ status }) => status)).toEqual(['failed', 'failed']);

      const notStarted = launch(`printf '%s\\n' not-started >> executions.txt`, 'synthetic-missing-shell');
      const rejected = await settled(notStarted);
      expect(rejected).toMatchObject({ status: 'failed', attempts: [{ chatId: null, reason: expect.stringContaining('synthetic-missing-shell') }] });
      expect(await readFile(sideEffect, 'utf8')).toBe('ran\n');
    } finally {
      fault.mockRestore();
      engine.close();
      await controller.dispose();
      await runtime.dispose();
      await workspace.dispose();
    }
  },
);
