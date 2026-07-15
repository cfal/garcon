import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  computeWebBuildHash,
  isWebBuildCurrent,
  recordWebBuild,
} from '../../../scripts/web-build-cache.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-web-build-cache-'));
  temporaryDirectories.push(root);
  const input = path.join(root, 'input');
  const buildDir = path.join(root, 'build');
  const markerPath = path.join(buildDir, '.marker');
  await fs.mkdir(input);
  await fs.mkdir(path.join(buildDir, '_app'), { recursive: true });
  await fs.writeFile(path.join(input, 'app.ts'), 'first');
  await fs.writeFile(path.join(buildDir, 'index.html'), '<main></main>');
  await fs.writeFile(path.join(buildDir, '_app', 'app.js'), 'compiled');
  return { input, buildDir, markerPath };
}

describe('web build cache', () => {
  it('hashes file content and paths deterministically', async () => {
    const fixture = await createFixture();
    const first = await computeWebBuildHash([fixture.input]);
    const second = await computeWebBuildHash([fixture.input]);
    await fs.writeFile(path.join(fixture.input, 'app.ts'), 'second');

    expect(second).toBe(first);
    expect(await computeWebBuildHash([fixture.input])).not.toBe(first);
  });

  it('invalidates the marker when an input changes or output is missing', async () => {
    const fixture = await createFixture();
    const options = { ...fixture, inputs: [fixture.input], sourcePath: fixture.input };
    await recordWebBuild(options);
    expect(await isWebBuildCurrent(options)).toBe(true);

    await fs.writeFile(path.join(fixture.input, 'app.ts'), 'changed');
    expect(await isWebBuildCurrent(options)).toBe(false);

    await recordWebBuild(options);
    await fs.rm(path.join(fixture.buildDir, 'index.html'));
    expect(await isWebBuildCurrent(options)).toBe(false);
  });

  it('invalidates the marker when a recorded emitted asset is missing', async () => {
    const fixture = await createFixture();
    const options = { ...fixture, inputs: [fixture.input], sourcePath: fixture.input };
    await recordWebBuild(options);

    await fs.rm(path.join(fixture.buildDir, '_app', 'app.js'));

    expect(await isWebBuildCurrent(options)).toBe(false);
  });

  it('invalidates the marker when a recorded emitted asset is truncated', async () => {
    const fixture = await createFixture();
    const options = { ...fixture, inputs: [fixture.input], sourcePath: fixture.input };
    await recordWebBuild(options);

    await fs.writeFile(path.join(fixture.buildDir, '_app', 'app.js'), 'x');

    expect(await isWebBuildCurrent(options)).toBe(false);
  });

  it('uses the compiled client when a published package omits web sources', async () => {
    const fixture = await createFixture();
    await recordWebBuild({ ...fixture, inputs: [fixture.input] });
    expect(await isWebBuildCurrent({
      ...fixture,
      sourcePath: path.join(fixture.input, 'missing'),
    })).toBe(true);
  });

  it('records the pre-build hash so concurrent source changes stay invalidated', async () => {
    const fixture = await createFixture();
    const options = { ...fixture, inputs: [fixture.input], sourcePath: fixture.input };
    const preBuildHash = await computeWebBuildHash(options.inputs);
    await fs.writeFile(path.join(fixture.input, 'app.ts'), 'changed during build');
    await recordWebBuild({ ...options, hash: preBuildHash });

    expect(await isWebBuildCurrent(options)).toBe(false);
  });
});
