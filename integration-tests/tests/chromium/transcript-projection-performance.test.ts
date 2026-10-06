import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import type { TranscriptProjectionMeasurement } from '../../fixtures/transcript-projection/benchmark.js';

test('bounds production Chromium append projection at 5,000 loaded rows without losing context', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const temporaryRoot = join(homedir(), 'tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const output = await mkdtemp(join(temporaryRoot, 'transcript-projection-'));
  try {
    await build({
      configFile: false, root: join(repo, 'web'), mode: 'production', logLevel: 'warn',
      plugins: [svelte({ configFile: false, compilerOptions: { dev: false } })],
      resolve: {
        dedupe: ['svelte'],
        alias: { $lib: join(repo, 'web/src/lib'), $shared: join(repo, 'common') },
      },
      build: {
        outDir: output, emptyOutDir: true,
        lib: {
          entry: join(repo, 'integration-tests/fixtures/transcript-projection/benchmark.ts'),
          formats: ['es'], fileName: () => 'benchmark.js',
        },
      },
    });
    const script = await readFile(join(output, 'benchmark.js'));
    const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: (request) =>
      new URL(request.url).pathname === '/benchmark.js'
        ? new Response(script, { headers: { 'content-type': 'text/javascript' } })
        : new Response('<!doctype html><script type="module" src="/benchmark.js"></script>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.waitForFunction(() => 'measureTranscriptProjection' in globalThis);
      const measurements: TranscriptProjectionMeasurement[] = [];
      for (const combined of [false, true]) {
        measurements.push(await page.evaluate(async (combine) => {
          const measure = Reflect.get(globalThis, 'measureTranscriptProjection') as
            (combined: boolean) => Promise<TranscriptProjectionMeasurement>;
          return measure(combine);
        }, combined));
      }
      const artifactRoot = join(repo, 'integration-tests/artifacts/chromium');
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(join(artifactRoot, 'transcript-projection-performance.json'), JSON.stringify(measurements, null, 2));
      for (const measurement of measurements) {
        expect(measurement.finalRows).toBe(5_200);
        expect(measurement.firstRowRetained).toBe(true);
        expect(measurement.lastRowRetained).toBe(true);
        expect(measurement.p95Ms).toBeLessThan(50);
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.stop(true);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 120_000);
