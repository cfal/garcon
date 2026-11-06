import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workflow = name => Bun.YAML.parse(readFileSync(resolve(import.meta.dir, `../../.github/workflows/${name}.yml`), 'utf8'));

test('release assembly depends on same-run server and native gates, with distinct concurrency', () => {
  const build = workflow('build-exe');
  const native = workflow('native-app');
  expect(build.jobs['build-exe'].needs).toBe('version');
  expect(build.jobs.native.uses).toBe('./.github/workflows/native-app.yml');
  expect(build.jobs.native.secrets).toBeUndefined();
  expect(build.jobs.assemble.needs).toEqual(['version', 'build-exe', 'native']);
  expect(build.jobs.release.needs).toBe('assemble');
  expect(build.jobs.release.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')");
  expect(Object.hasOwn(native.on, 'workflow_call')).toBe(true);
  expect(native.on.push.tags).toBeUndefined();
  expect(build.concurrency.group).toBe('build-exe-${{ github.ref }}');
  expect(native.concurrency.group).toBe('native-app-${{ github.ref }}');
  for (const value of [build, native]) {
    expect(value.permissions).toEqual({ contents: 'read' });
    expect(value.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  }
  const download = build.jobs.assemble.steps.find(step => step.name === 'Download same-run payloads');
  expect(download.with.pattern).toBe('garcon-*');
  expect(download.with['merge-multiple']).toBe(false);
  expect(download.with['run-id']).toBeUndefined();
});

test('only the final publisher can mutate releases and attestations', () => {
  const build = workflow('build-exe');
  expect(build.jobs.release.permissions).toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' });
  for (const [name, job] of Object.entries(build.jobs)) {
    if (name !== 'release') expect(job.permissions ?? build.permissions).toEqual({ contents: 'read' });
  }
  const steps = build.jobs.release.steps;
  expect(steps.at(-2).run).toBe('bun scripts/release-github.js draft-guard');
  expect(steps.at(-1).run).toContain('--draft');
  expect(steps.at(-1).run).toContain('--verify-tag');
  expect(steps.some(step => step.run === 'bun scripts/release-assets.js verify release')).toBe(true);
  expect(steps.some(step => step.uses?.startsWith('actions/attest-build-provenance@'))).toBe(true);
  const attestation = steps.findIndex(step => step.uses?.startsWith('actions/attest-build-provenance@'));
  expect(steps[attestation - 1].run).toBe('bun scripts/release-github.js draft-guard');
  for (const step of steps.filter(step => step.uses?.startsWith('actions/checkout@'))) {
    expect(step.with['persist-credentials']).toBe(false);
  }
});

test('both workflow version boundaries propagate validator failure before publishing outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-version-shell-'));
  try {
    const executable = join(directory, 'bun');
    await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$VALIDATOR_ARGS"\nif [ "$VALIDATOR_EXIT" != 0 ]; then exit "$VALIDATOR_EXIT"; fi\nprintf "0.4.0\\n"\n');
    await chmod(executable, 0o755);
    for (const job of [workflow('build-exe').jobs.version, workflow('docker-publish').jobs.source]) {
      for (const [code, event] of [[0, 'release'], [37, 'release'], [0, 'push'], [37, 'push']]) {
        const output = join(directory, 'output');
        const args = join(directory, 'args');
        await writeFile(output, '');
        const result = Bun.spawnSync(['bash', '-c', job.steps.find(step => step.id === 'version').run], {
          env: { PATH: `${directory}:/usr/bin:/bin`, GITHUB_OUTPUT: output, VALIDATOR_EXIT: String(code),
            VALIDATOR_ARGS: args, GITHUB_REF_TYPE: event === 'release' ? 'tag' : 'branch',
            GITHUB_REF_NAME: event === 'release' ? 'v0.4.0' : 'main', GITHUB_EVENT_NAME: event, RELEASE_TAG: 'v0.4.0' },
          stdout: 'pipe', stderr: 'pipe',
        });
        expect(result.exitCode).toBe(code);
        expect(await readFile(output, 'utf8')).toBe(code ? '' : 'version=0.4.0\n');
        expect(await readFile(args, 'utf8')).toBe(`scripts/release-version.js\n${event === 'release' ? 'v0.4.0\n' : ''}`);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('publication workflows pin actions, including source and artifact producers', () => {
  for (const job of [...Object.values(workflow('build-exe').jobs), ...Object.values(workflow('docker-publish').jobs)]) {
    for (const step of (job.steps ?? []).filter(step => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  }
});

test('untrusted event values are passed through environment variables, not shell interpolation', () => {
  for (const name of ['build-exe', 'native-app', 'docker-publish']) {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? '').not.toMatch(/\$\{\{\s*github\.(?:event\.|ref_name|head_ref)/);
      }
    }
  }
});
