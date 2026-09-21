import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import {
  piNativeSession,
  scriptedPiRunRequest,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';

describe.skipIf(process.platform === 'win32')('scripted Pi deletion', () => {
  for (const status of ['idle', 'active'] as const) {
    test(`deleting an ${status} chat exits its Pi process and preserves the sibling`, async () => {
      const environment = startScriptedPiTestEnvironment();
      const binary = environment.serverEnvironment.GARCON_PI_BINARY!;
      let pidLog = '';
      try {
        environment.model.scriptTurn([chatCompletionsText('target reply')]);
        environment.model.scriptTurn([chatCompletionsText('sibling reply')]);
        const held = status === 'active'
          ? environment.model.scriptHeldTurn([chatCompletionsText('deleted reply')])
          : null;
        environment.model.scriptTurn([chatCompletionsText('sibling continuation')]);

        await withIntegrationFixture(`pi-delete-${status}`, async (fixture) => {
          const chatId = fixture.newChatId();
          const siblingId = fixture.newChatId();
          for (const [id, reply] of [[chatId, 'target reply'], [siblingId, 'sibling reply']] as const) {
            const cursor = fixture.client.markEvents();
            const turn = await fixture.client.startChat(scriptedPiStartRequest({
              chatId: id, projectPath: fixture.dirs.project, command: `produce ${reply}`,
            }));
            await waitForVisibleResponse({ fixture, chatId: id, turnId: turn.turnId, marker: reply, afterIndex: cursor });
          }
          const native = await piNativeSession(fixture, chatId);
          const nativeBefore = await readFile(native.path, 'utf8');
          const processes = await recordedPids(pidLog);
          expect(processes).toHaveLength(2);
          const [targetPid, siblingPid] = processes as [number, number];
          expect(processAlive(targetPid)).toBe(true);
          expect(processAlive(siblingPid)).toBe(true);
          if (held) {
            await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: 'hold until deleted' }));
            await held.requested;
          }

          expect(await fixture.client.deleteChat(chatId)).toEqual({ success: true });
          await waitForProcessExit(targetPid);
          held?.release();
          expect(processAlive(siblingPid)).toBe(true);
          expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBe(false);
          expect(await readFile(native.path, 'utf8')).toContain(nativeBefore);

          const cursor = fixture.client.markEvents();
          const continuation = await fixture.client.runChat(scriptedPiRunRequest({
            chatId: siblingId, command: 'continue the surviving chat',
          }));
          await waitForVisibleResponse({
            fixture, chatId: siblingId, turnId: continuation.turnId,
            marker: 'sibling continuation', afterIndex: cursor,
          });
          expect(await recordedPids(pidLog)).toEqual(processes);
          expect(processAlive(siblingPid)).toBe(true);
          await fixture.client.deleteChat(siblingId);
          await waitForProcessExit(siblingPid);
          environment.model.assertSettled();
        }, {
          serverEnvironment: environment.serverEnvironment,
          async prepareWorkspace(directories) {
            await environment.prepareWorkspace(directories);
            pidLog = join(directories.root, 'pi-pids');
            const shim = join(directories.root, 'pi-record-pid');
            // Exec preserves the recorded PID and leaves Pi's real RPC transport untouched.
            await writeFile(shim, '#!/bin/sh\n'
              + 'if [ "$1" = "--mode" ] && [ "$2" = "rpc" ]; then\n'
              + '  printf "%s\\n" "$$" >> "$GARCON_TEST_PI_PID_LOG"\n'
              + 'fi\nexec "$GARCON_TEST_PI_BINARY" "$@"\n');
            await chmod(shim, 0o700);
            environment.serverEnvironment.GARCON_PI_BINARY = shim;
            environment.serverEnvironment.GARCON_TEST_PI_BINARY = binary;
            environment.serverEnvironment.GARCON_TEST_PI_PID_LOG = pidLog;
          },
        });
      } finally {
        environment.dispose();
      }
    }, 120_000);
  }
});

async function recordedPids(path: string): Promise<number[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map(Number);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Deleted chat left Pi process ${pid} running`);
    await Bun.sleep(20);
  }
}
