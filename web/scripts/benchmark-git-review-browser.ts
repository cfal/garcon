import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from '@playwright/test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CODEMIRROR_PACKAGES } from '../codemirror-packages.js';
import assert from 'node:assert/strict';

interface BenchmarkMeasurement {
	highlighted: number;
	plainReasons: string[];
	renderedRows: number;
	rowHeightBefore: number;
	rowHeightAfter: number;
}

declare global {
	interface Window {
		reviewBenchmark: {
			run(
				count: number,
				lines: number,
				split?: boolean,
				lineLength?: number,
			): Promise<BenchmarkMeasurement>;
			openReview(count: number, lines: number, split?: boolean): Promise<string>;
			refreshReview(): Promise<boolean>;
			inspect(): { documentId: string; loaded: string[]; highlighted: string[]; pending: string[] };
			navigate(path: string): void;
			clearColors(): Promise<void>;
			color(): Promise<string>;
			cancelProbe(): Promise<{ status: string; cancellationMs: number }>;
			openPullRequest(): Promise<void>;
			refreshPullRequest(): Promise<void>;
			unicodeProbe(): Promise<{ expected: string; indexed: string; highlighted: string | null }>;
		};
	}
}

const output = process.argv[2];
if (!output)
	throw new Error('Usage: bun web/scripts/benchmark-git-review-browser.ts <output-directory>');
await mkdir(output, { recursive: true });
const baseline = process.argv.includes('--baseline');
const verifyOnly = process.argv.includes('--verify-only');
const computeRoot = baseline
	? resolve(output, 'baseline')
	: resolve(import.meta.dirname, '../src/lib/git/review');
if (baseline) {
	await mkdir(computeRoot, { recursive: true });
	for (const file of [
		'git-review-body-index.ts',
		'git-patch-index.ts',
		'git-diff-syntax.ts',
		'git-diff-syntax-highlighter.ts',
		'git-review-performance.ts',
	]) {
		await writeFile(
			resolve(computeRoot, file),
			execFileSync(
				'git',
				['show', `0577582e1fea26e9baf81f98e5e37e8cf621ae51:web/src/lib/git/review/${file}`],
				{ cwd: resolve(import.meta.dirname, '../..') },
			),
		);
	}
}
const server = await createServer({
	configFile: false,
	root: resolve(import.meta.dirname, 'git-review-browser'),
	plugins: [svelte({ configFile: false, compilerOptions: { runes: true } }), tailwindcss()],
	optimizeDeps: {
		include: [
			...CODEMIRROR_PACKAGES.filter((name) => {
				if (name === '@codemirror/legacy-modes') return false;
				try {
					import.meta.resolve(name);
					return true;
				} catch {
					return false;
				}
			}),
			'@lezer/highlight',
		],
	},
	resolve: {
		dedupe: [...CODEMIRROR_PACKAGES, '@lezer/highlight'],
		alias: {
			$lib: resolve(import.meta.dirname, '../src/lib'),
			$shared: resolve(import.meta.dirname, '../../common'),
			$app: resolve(import.meta.dirname, '../src/lib/mocks/app'),
			'$review-compute': computeRoot,
			'$review-highlight': resolve(
				computeRoot,
				baseline ? 'git-diff-syntax-highlighter.ts' : 'git-review-worker-operations.ts',
			),
		},
	},
	server: {
		host: '0.0.0.0',
		port: 0,
		fs: { allow: [resolve(import.meta.dirname, '../..'), computeRoot] },
	},
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const measurements = [];
const verification = [];
try {
	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 390, height: 844 },
	]) {
		const page = await browser.newPage({ viewport });
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Performance.enable');
		const pageErrors: string[] = [];
		page.on('pageerror', (error) => pageErrors.push(error.message));
		await page.goto(server.resolvedUrls!.local[0]);
		await page.waitForFunction(() => 'reviewBenchmark' in window);
		await page.evaluate(() => document.fonts.ready.then(() => undefined));
		const workloads = [
			[1, 1800, false, 0],
			[1, 12000, false, 0],
			[120, 120, true, 0],
			[1, 2, false, 24000],
		] as const;
		for (const [count, lines, split, lineLength] of verifyOnly ? [] : workloads) {
			await page.reload();
			await page.waitForFunction(() => 'reviewBenchmark' in window);
			await page.evaluate(() => document.fonts.ready.then(() => undefined));
			for (let run = 0; run < 2; run += 1) {
				const metricsBefore = await cdp.send('Performance.getMetrics');
				const result = await page.evaluate(
					({ count, lines, split, lineLength }) =>
						window.reviewBenchmark.run(count, lines, split, lineLength),
					{ count, lines, split, lineLength },
				);
				assert.ok(
					result.renderedRows > 0 && result.renderedRows < 200,
					'Rows must be rendered and virtualized',
				);
				assert.equal(
					result.rowHeightAfter,
					result.rowHeightBefore,
					'Colors must not change row geometry',
				);
				if (!baseline) {
					assert.equal(
						result.highlighted,
						lineLength ? 0 : count,
						'Supported bounded files must highlight, including cold and warm large files',
					);
					if (lineLength) assert.deepEqual(result.plainReasons, ['character-limit']);
				}
				const metricsAfter = await cdp.send('Performance.getMetrics');
				const metric = (metrics: typeof metricsAfter, name: string) =>
					metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
				measurements.push({
					viewport,
					run,
					result,
					mainThreadCpuMs:
						(metric(metricsAfter, 'TaskDuration') - metric(metricsBefore, 'TaskDuration')) * 1000,
					mainThreadHeapBytesAtCompletion: metric(metricsAfter, 'JSHeapUsedSize'),
				});
				console.log(JSON.stringify(measurements.at(-1)));
				await writeFile(
					resolve(output, 'measurements.json'),
					JSON.stringify(measurements, null, 2),
				);
			}
			await page.screenshot({ path: resolve(output, `${viewport.width}-${count}-${lines}.png`) });
		}
		if (!baseline) {
			const workerDirectory = resolve(import.meta.dirname, '../build/_app/immutable/workers');
			const workerAsset = (await readdir(workerDirectory)).find((name) =>
				/^git-review-worker-.*\.js$/.test(name),
			);
			assert.ok(workerAsset, 'Run bun run build before validating the production Worker asset');
			const builtWorker = await page.evaluate(async (url) => {
				const worker = new Worker(url, { type: 'module' });
				try {
					return await new Promise<{ rows: number; syntax: string }>((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error('Built Worker timeout')), 10000);
						worker.onerror = (event) => {
							clearTimeout(timer);
							reject(new Error(event.message));
						};
						const patch = '@@ -0,0 +1 @@\n+const synthetic = true;\n';
						let rows = 0;
						worker.onmessage = ({ data }) => {
							if (data.status !== 'ready') {
								clearTimeout(timer);
								reject(new Error(data.message));
								return;
							}
							if (data.id === 1) {
								rows = data.output.index.rowKinds.length;
								worker.postMessage({
									id: 2,
									input: {
										kind: 'highlight',
										documentId: 'synthetic:built',
										file: {
											path: 'synthetic.ts',
											bodyFingerprint: 'synthetic',
											category: 'normal',
											isGenerated: false,
											isBinary: false,
											isTooLarge: false,
										},
										body: {
											path: 'synthetic.ts',
											bodyFingerprint: 'synthetic',
											category: 'normal',
											bodyState: 'loaded',
											isBinary: false,
											isTooLarge: false,
											patch,
											patchBytes: patch.length,
											renderedRowCount: 2,
										},
										index: data.output.index,
									},
								});
							} else {
								clearTimeout(timer);
								resolve({ rows, syntax: data.output.attempt.status });
							}
						};
						worker.postMessage({ id: 1, input: { kind: 'index', patch, renderedRowCount: 2 } });
					});
				} finally {
					worker.terminate();
				}
			}, `/@fs${workerDirectory}/${workerAsset}`);
			assert.equal(
				builtWorker.syntax,
				'highlighted',
				'Built Worker must resolve its lazy syntax and language chunks',
			);
			assert.equal(builtWorker.rows, 2);
			await page.evaluate(() => window.reviewBenchmark.run(1, 3000));
			await page.evaluate(() => window.reviewBenchmark.clearColors());
			const before = await page.evaluate(async () => {
				const scroller = document.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
				scroller.scrollTop = 300;
				await new Promise(requestAnimationFrame);
				await new Promise(requestAnimationFrame);
				const text = document.querySelector('.code-highlight')!;
				const range = document.createRange();
				range.selectNodeContents(text);
				window.getSelection()!.removeAllRanges();
				window.getSelection()!.addRange(range);
				await new Promise((resolve) => setTimeout(resolve, 0));
				return {
					selected: window.getSelection()!.toString(),
					scrollTop: scroller.scrollTop,
					height: text.getBoundingClientRect().height,
				};
			});
			assert.equal(await page.evaluate(() => window.reviewBenchmark.color()), 'highlighted');
			const after = await page.evaluate(() => ({
				selected: window.getSelection()!.toString(),
				scrollTop: document.querySelector('[data-git-virtual-diff-root]')!.scrollTop,
				height: document.querySelector('.code-highlight')!.getBoundingClientRect().height,
			}));
			assert.ok(before.selected.length > 0, 'Selection check must include text');
			assert.deepEqual(
				after,
				before,
				'Color publication must preserve selection, scroll and row geometry',
			);
			await page.evaluate(() => {
				window.getSelection()?.removeAllRanges();
				return window.reviewBenchmark.clearColors();
			});
			const coloring = page.evaluate(() => window.reviewBenchmark.color());
			const inputStarted = performance.now();
			await page.getByLabel('Typing probe').pressSequentially('synthetic typed text');
			const typingMs = performance.now() - inputStarted;
			await coloring;
			assert.equal(await page.getByLabel('Typing probe').inputValue(), 'synthetic typed text');
			await page.evaluate(() => window.reviewBenchmark.openReview(120, 120));
			await page.waitForFunction(() => window.reviewBenchmark.inspect().highlighted.length > 0);
			const demand = await page.evaluate(() => window.reviewBenchmark.inspect());
			assert.ok(demand.loaded.length < 10, 'Only visible PR files should be indexed');
			await page.evaluate(() => window.reviewBenchmark.navigate('synthetic/file-119.ts'));
			await page.waitForFunction(() =>
				window.reviewBenchmark.inspect().highlighted.includes('synthetic/file-119.ts'),
			);
			await page.evaluate(() => window.reviewBenchmark.openReview(1, 12000, true));
			await page.waitForFunction(() => window.reviewBenchmark.inspect().highlighted.length > 0);
			const refresh = await page.evaluate(async () => {
				const scroller = document.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
				scroller.scrollTop = 100000;
				let stableFrames = 0;
				let previous = '';
				const deadline = performance.now() + 2000;
				while (stableFrames < 3) {
					await new Promise(requestAnimationFrame);
					const geometry = `${scroller.scrollTop}:${scroller.scrollHeight}:${document.querySelector('[data-git-virtual-row]')?.getAttribute('data-git-virtual-row-id')}`;
					stableFrames = geometry === previous ? stableFrames + 1 : 0;
					previous = geometry;
					if (performance.now() > deadline) throw new Error('Scroll measurements did not settle');
				}
				const row = document.querySelector('[data-git-diff-review-row]')!;
				const text = row.textContent;
				const before = { scrollTop: scroller.scrollTop, rowTop: row.getBoundingClientRect().top };
				const retained = await window.reviewBenchmark.refreshReview();
				await new Promise(requestAnimationFrame);
				await new Promise(requestAnimationFrame);
				return {
					retained,
					rowRetained: row === document.querySelector('[data-git-diff-review-row]'),
					textRetained: text === row.textContent,
					before,
					after: { scrollTop: scroller.scrollTop, rowTop: row.getBoundingClientRect().top },
				};
			});
			assert.ok(refresh.retained && refresh.rowRetained && refresh.textRetained);
			assert.ok(refresh.before.scrollTop >= 100000, 'Refresh must exercise deep rows');
			assert.deepEqual(
				refresh.after,
				refresh.before,
				'Refresh must preserve settled viewport geometry',
			);
			await page.screenshot({ path: resolve(output, `${viewport.width}-refresh.png`) });
			await page.evaluate(() => window.reviewBenchmark.openReview(1, 12000, true));
			const current = await page.evaluate(() => window.reviewBenchmark.openReview(1, 42));
			await page.waitForFunction(() => window.reviewBenchmark.inspect().highlighted.length > 0);
			assert.equal(
				(await page.evaluate(() => window.reviewBenchmark.inspect())).documentId,
				current,
			);
			const cancellation = await page.evaluate(() => window.reviewBenchmark.cancelProbe());
			assert.equal(cancellation.status, 'cancelled');
			assert.ok(
				cancellation.cancellationMs < 100,
				'Cancellation should not await synchronous Worker completion',
			);
			const unicode = await page.evaluate(() => window.reviewBenchmark.unicodeProbe());
			assert.equal(unicode.indexed, unicode.expected);
			assert.equal(unicode.highlighted, unicode.expected);
			await page.evaluate(() => window.reviewBenchmark.openPullRequest());
			await page.waitForFunction(() => document.querySelector('.cm-code-keyword'));
			const metadataRefresh = await page.evaluate(async () => {
				const scroller = document.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
				scroller.scrollTop = 100000;
				let previous = '';
				let stableFrames = 0;
				const deadline = performance.now() + 2000;
				while (stableFrames < 3) {
					await new Promise(requestAnimationFrame);
					const geometry = `${scroller.scrollTop}:${scroller.scrollHeight}`;
					stableFrames = geometry === previous ? stableFrames + 1 : 0;
					previous = geometry;
					if (performance.now() > deadline) throw new Error('PR scroll did not settle');
				}
				const row = document.querySelector('[data-git-diff-review-row]')!;
				const code = row.querySelector('.code-highlight')!;
				const range = document.createRange();
				range.selectNodeContents(code);
				window.getSelection()!.removeAllRanges();
				window.getSelection()!.addRange(range);
				const snapshot = () => ({
					selected: window.getSelection()!.toString(),
					text: row.textContent,
					scrollTop: scroller.scrollTop,
					rowTop: row.getBoundingClientRect().top,
				});
				const before = snapshot();
				await window.reviewBenchmark.refreshPullRequest();
				await new Promise(requestAnimationFrame);
				await new Promise(requestAnimationFrame);
				return {
					before,
					after: snapshot(),
					rowRetained: row === document.querySelector('[data-git-diff-review-row]'),
				};
			});
			assert.ok(metadataRefresh.before.selected.length > 0);
			assert.ok(metadataRefresh.before.scrollTop >= 100000);
			assert.ok(metadataRefresh.rowRetained, 'Metadata refresh must not remount PR rows');
			assert.deepEqual(metadataRefresh.after, metadataRefresh.before);
			await page.screenshot({ path: resolve(output, `${viewport.width}-pr-refresh.png`) });
			await page.evaluate(() => {
				window.getSelection()?.removeAllRanges();
				document.querySelector('[data-git-virtual-diff-root]')!.scrollTop = 0;
			});
			await page.getByRole('button', { name: 'Viewed', exact: true }).click();
			await page.evaluate(() => window.reviewBenchmark.refreshPullRequest());
			assert.equal(
				await page
					.getByRole('button', { name: 'Viewed', exact: true })
					.getAttribute('aria-pressed'),
				'true',
			);
			assert.equal(
				await page
					.getByRole('button', { name: /synthetic\/file-0.ts/ })
					.getAttribute('aria-expanded'),
				'false',
			);
			verification.push({
				viewport,
				builtWorker,
				typingMs,
				initialDemand: demand,
				selectionAndScroll: after,
				refresh,
				rapidSwitch: 'passed',
				cancellation,
				unicode,
				metadataRefresh,
				viewedAndCollapsed: 'preserved',
			});
			await page.screenshot({ path: resolve(output, `${viewport.width}-demand.png`) });
		}
		assert.deepEqual(pageErrors, [], 'Browser errors must fail verification');
		await page.close();
	}
	if (!verifyOnly)
		await writeFile(resolve(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
	await writeFile(resolve(output, 'verification.json'), JSON.stringify(verification, null, 2));
} finally {
	await browser.close();
	await server.close();
}
