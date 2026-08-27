import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  reloadFromNativeHistory,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  openCodeNativeSession,
  readOpenCodeSessionDirectory,
  readSupervisorStates,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  waitForSupervisorExit,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('OpenCode project path relocation', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('moves across worktree roots and nested paths without touching dirty files', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('WORKTREE_FIRST_PROMPT');
    const firstReply = marker('WORKTREE_FIRST_REPLY');
    const rootPrompt = marker('WORKTREE_ROOT_PROMPT');
    const rootReply = marker('WORKTREE_ROOT_REPLY');
    const nestedPrompt = marker('WORKTREE_NESTED_PROMPT');
    const nestedReply = marker('WORKTREE_NESTED_REPLY');
    const restartPrompt = marker('WORKTREE_RESTART_PROMPT');
    const restartReply = marker('WORKTREE_RESTART_REPLY');
    const rootMarker = 'relocated-root.marker';
    const nestedMarker = 'relocated-nested.marker';
    const restartMarker = 'relocated-restart.marker';
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    scriptTouchTurn(testEnvironment, 'call_root_marker', rootMarker, rootReply);
    scriptTouchTurn(testEnvironment, 'call_nested_marker', nestedMarker, nestedReply);
    scriptTouchTurn(testEnvironment, 'call_restart_marker', restartMarker, restartReply);

    await withIntegrationFixture('opencode-project-path-worktrees', async (fixture) => {
      const repository = await createWorktreeRepository(fixture);
      const sourceStatus = await gitStatus(repository.source);
      const targetStatus = await gitStatus(repository.target);
      const chatId = fixture.newChatId();

      await runStartTurn(fixture, chatId, repository.source, firstPrompt, firstReply);
      const native = await openCodeNativeSession(fixture, chatId);
      expect(readOpenCodeSessionDirectory(native)).toBe(repository.source);

      await expect(fixture.client.updateProjectPath({
        chatId,
        projectPath: repository.target,
      })).resolves.toMatchObject({
        chatId,
        projectPath: repository.target,
        previousProjectPath: repository.source,
      });
      expect(await openCodeNativeSession(fixture, chatId)).toEqual(native);
      expect(readOpenCodeSessionDirectory(native)).toBe(repository.target);
      await expectDirtyTreesUnchanged(repository, sourceStatus, targetStatus);

      await runExistingTurn(fixture, chatId, rootPrompt, rootReply);
      expect(existsSync(join(repository.target, rootMarker))).toBe(true);
      expect(existsSync(join(repository.source, rootMarker))).toBe(false);
      await expectDirtyTreesUnchanged(repository, sourceStatus, targetStatus);

      await expect(fixture.client.updateProjectPath({
        chatId,
        projectPath: repository.nested,
      })).resolves.toMatchObject({
        chatId,
        projectPath: repository.nested,
        previousProjectPath: repository.target,
      });
      expect(readOpenCodeSessionDirectory(native)).toBe(repository.nested);
      await runExistingTurn(fixture, chatId, nestedPrompt, nestedReply);
      expect(existsSync(join(repository.nested, nestedMarker))).toBe(true);
      expect(existsSync(join(repository.target, nestedMarker))).toBe(false);
      await expectDirtyTreesUnchanged(repository, sourceStatus, targetStatus);

      await reloadFromNativeHistory(fixture, chatId);
      const beforeRestart = await fixture.client.getMessages(chatId);
      expect(userContents(beforeRestart.messages)).toEqual([firstPrompt, rootPrompt, nestedPrompt]);
      expect(assistantContents(beforeRestart.messages)).toEqual([firstReply, rootReply, nestedReply]);
      const previousSupervisors = await readSupervisorStates(fixture.dirs);
      await fixture.restartGarcon({
        beforeStart: () => waitForSupervisorExit(previousSupervisors),
      });

      expect(await openCodeNativeSession(fixture, chatId)).toEqual(native);
      expect(readOpenCodeSessionDirectory(native)).toBe(repository.nested);
      await expect(fixture.client.updateProjectPath({
        chatId,
        projectPath: repository.target,
      })).resolves.toMatchObject({
        chatId,
        projectPath: repository.target,
        previousProjectPath: repository.nested,
      });
      expect(readOpenCodeSessionDirectory(native)).toBe(repository.target);
      await runExistingTurn(fixture, chatId, restartPrompt, restartReply);
      expect(existsSync(join(repository.target, restartMarker))).toBe(true);
      expect(existsSync(join(repository.nested, restartMarker))).toBe(false);
      await expectDirtyTreesUnchanged(repository, sourceStatus, targetStatus);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('rejects another project without changing paths and resumes the existing session', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('REJECT_FIRST_PROMPT');
    const firstReply = marker('REJECT_FIRST_REPLY');
    const resumePrompt = marker('REJECT_RESUME_PROMPT');
    const resumeReply = marker('REJECT_RESUME_REPLY');
    const resumeMarker = 'resume-after-rejection.marker';
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    scriptTouchTurn(testEnvironment, 'call_rejection_resume_marker', resumeMarker, resumeReply);

    await withIntegrationFixture('opencode-project-path-rejection', async (fixture) => {
      const repository = await createWorktreeRepository(fixture);
      const unrelated = await createUnrelatedRepository(fixture);
      const sourceStatus = await gitStatus(repository.source);
      const targetStatus = await gitStatus(repository.target);
      const unrelatedStatus = await gitStatus(unrelated);
      const chatId = fixture.newChatId();

      await runStartTurn(fixture, chatId, repository.source, firstPrompt, firstReply);
      const native = await openCodeNativeSession(fixture, chatId);
      const failure = await fixture.client.updateProjectPath({
        chatId,
        projectPath: unrelated,
      }).then(() => null, (error) => error);

      expect(failure).toBeInstanceOf(GarconApiError);
      expect(failure).toMatchObject({
        status: 422,
        body: expect.objectContaining({
          errorCode: 'PROJECT_PATH_DESTINATION_REJECTED',
          retryable: false,
        }),
      });
      expect(await openCodeNativeSession(fixture, chatId)).toEqual(native);
      expect(readOpenCodeSessionDirectory(native)).toBe(repository.source);
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId))
        .toMatchObject({ projectPath: repository.source });
      expect(await gitStatus(repository.source)).toBe(sourceStatus);
      expect(await gitStatus(repository.target)).toBe(targetStatus);
      expect(await gitStatus(unrelated)).toBe(unrelatedStatus);

      await reloadFromNativeHistory(fixture, chatId);
      await runExistingTurn(fixture, chatId, resumePrompt, resumeReply);
      expect(existsSync(join(repository.source, resumeMarker))).toBe(true);
      expect(existsSync(join(unrelated, resumeMarker))).toBe(false);
      expect(readOpenCodeSessionDirectory(native)).toBe(repository.source);
      expect(await gitStatus(repository.source)).toBe(sourceStatus);
      expect(await gitStatus(unrelated)).toBe(unrelatedStatus);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);
});

interface WorktreeRepository {
  source: string;
  target: string;
  nested: string;
}

async function createWorktreeRepository(fixture: IntegrationFixture): Promise<WorktreeRepository> {
  const parent = join(fixture.dirs.project, 'worktree-relocation');
  const source = join(parent, 'source');
  const target = join(parent, 'target');
  const nested = join(target, 'packages', 'nested');
  await mkdir(source, { recursive: true });
  await git(source, 'init', '--initial-branch=main');
  await writeFile(join(source, '.gitignore'), '*.marker\n');
  await writeFile(join(source, 'tracked.txt'), 'initial\n');
  await git(source, 'add', '.gitignore', 'tracked.txt');
  await git(
    source,
    '-c',
    'user.name=Garcon Integration',
    '-c',
    'user.email=garcon-integration@example.test',
    'commit',
    '-m',
    'initial',
  );
  await git(source, 'remote', 'add', 'origin', 'https://example.test/garcon-relocation.git');
  await git(source, 'worktree', 'add', '-b', 'relocation-target', target);
  await mkdir(nested, { recursive: true });

  await writeFile(join(source, 'tracked.txt'), 'dirty source\n');
  await writeFile(join(source, 'source-untracked.txt'), 'source untracked\n');
  await writeFile(join(target, 'tracked.txt'), 'dirty target\n');
  await writeFile(join(target, 'target-untracked.txt'), 'target untracked\n');
  return { source, target, nested };
}

async function createUnrelatedRepository(fixture: IntegrationFixture): Promise<string> {
  const directory = join(fixture.dirs.project, 'unrelated-project');
  await mkdir(directory, { recursive: true });
  await git(directory, 'init', '--initial-branch=main');
  await writeFile(join(directory, '.gitignore'), '*.marker\n');
  await writeFile(join(directory, 'tracked.txt'), 'initial\n');
  await git(directory, 'add', '.gitignore', 'tracked.txt');
  await git(
    directory,
    '-c',
    'user.name=Garcon Integration',
    '-c',
    'user.email=garcon-integration@example.test',
    'commit',
    '-m',
    'unrelated initial',
  );
  await git(directory, 'remote', 'add', 'origin', 'https://example.test/unrelated.git');
  await writeFile(join(directory, 'tracked.txt'), 'dirty unrelated\n');
  await writeFile(join(directory, 'unrelated-untracked.txt'), 'unrelated untracked\n');
  return directory;
}

async function runStartTurn(
  fixture: IntegrationFixture,
  chatId: string,
  projectPath: string,
  prompt: string,
  reply: string,
): Promise<void> {
  const cursor = fixture.client.markEvents();
  const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
    chatId,
    projectPath,
    command: prompt,
  }));
  await waitForVisibleResponse({
    fixture,
    chatId,
    turnId: turn.turnId,
    marker: reply,
    afterIndex: cursor,
  });
}

async function runExistingTurn(
  fixture: IntegrationFixture,
  chatId: string,
  prompt: string,
  reply: string,
): Promise<void> {
  const cursor = fixture.client.markEvents();
  const turn = await fixture.client.runChat(scriptedOpenCodeRunRequest({
    chatId,
    command: prompt,
  }));
  await waitForVisibleResponse({
    fixture,
    chatId,
    turnId: turn.turnId,
    marker: reply,
    afterIndex: cursor,
  });
}

function scriptTouchTurn(
  testEnvironment: ScriptedOpenCodeTestEnvironment,
  callId: string,
  path: string,
  reply: string,
): void {
  testEnvironment.model.scriptTurn([
    chatCompletionsToolUse(callId, 'bash', { command: `touch ${path}` }),
  ]);
  testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);
}

async function expectDirtyTreesUnchanged(
  repository: WorktreeRepository,
  sourceStatus: string,
  targetStatus: string,
): Promise<void> {
  expect(await gitStatus(repository.source)).toBe(sourceStatus);
  expect(await gitStatus(repository.target)).toBe(targetStatus);
}

async function gitStatus(directory: string): Promise<string> {
  return git(directory, 'status', '--porcelain=v1');
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(['git', ...args], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withScriptedOpenCode(): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

function marker(label: string): string {
  return `SCRIPTED_OPENCODE_RELOCATION_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
