import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DisplayCoverage, type CoverageMeasurement } from '../display-coverage.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('[TLV5-DISPLAY.03-WEB-UNIT-01] has no lifetime request cap and retains a wakeup received during a held layout', async () => {
	const held = Promise.withResolvers<CoverageMeasurement>();
	let measures = 0, loads = 0;
	const coverage = new DisplayCoverage({ isVisible: () => true,
		measure: () => ++measures === 1 ? held.promise : Promise.resolve({ kind: 'settled', covered: loads >= 60 }),
		load: async () => { loads++; return 'loaded'; } });
	coverage.wake(); await vi.advanceTimersByTimeAsync(1);
	coverage.wake(); held.resolve({ kind: 'superseded' });
	await vi.advanceTimersByTimeAsync(100);
	expect(loads).toBe(60);
	expect(coverage.status).toBe('covered');
	coverage.dispose();
});

it('blocks without polling and resumes after readiness or visibility changes', async () => {
	let visible = false, ready = false, loads = 0;
	const coverage = new DisplayCoverage({ isVisible: () => visible,
		measure: async () => ({ kind: 'settled', covered: false }),
		load: async () => { loads++; return ready ? 'exhausted' : 'blocked'; } });
	coverage.wake(); await vi.advanceTimersByTimeAsync(10); expect(loads).toBe(0);
	visible = true; coverage.wake(); await vi.advanceTimersByTimeAsync(10000);
	expect(loads).toBe(1); expect(coverage.status).toBe('waiting');
	ready = true; coverage.wake(); await vi.advanceTimersByTimeAsync(10);
	expect(loads).toBe(2); expect(coverage.status).toBe('exhausted');
	coverage.dispose(); coverage.wake(); await vi.advanceTimersByTimeAsync(10); expect(loads).toBe(2);
});

it('rechecks demand received while a page is in flight without overlapping requests', async () => {
	const held = Promise.withResolvers<'loaded'>();
	let covered = false;
	const load = vi.fn(() => held.promise);
	const coverage = new DisplayCoverage({ isVisible: () => true,
		measure: async () => ({ kind: 'settled', covered }), load });
	coverage.wake(); await vi.advanceTimersByTimeAsync(1);
	for (let wake = 0; wake < 20; wake++) coverage.wake();
	await vi.advanceTimersByTimeAsync(1000);
	expect(load).toHaveBeenCalledOnce();
	covered = true; held.resolve('loaded'); await vi.advanceTimersByTimeAsync(10);
	expect(coverage.status).toBe('covered');
	expect(load).toHaveBeenCalledOnce();
	coverage.dispose();
});

it.each(['failed', 'exhausted'] as const)('stops on %s until an explicit wakeup', async outcome => {
	const load = vi.fn(async () => outcome);
	const coverage = new DisplayCoverage({ isVisible: () => true,
		measure: async () => ({ kind: 'settled', covered: false }), load });
	coverage.wake(); await vi.advanceTimersByTimeAsync(10000);
	expect(load).toHaveBeenCalledOnce();
	expect(coverage.status).toBe(outcome);
	coverage.wake(); await vi.advanceTimersByTimeAsync(10);
	expect(load).toHaveBeenCalledTimes(2);
	coverage.dispose();
});

it('waits for native layout settlement and rearms after collapse or resize', async () => {
	let settled = false, covered = true;
	const load = vi.fn(async () => { covered = true; return 'loaded' as const; });
	const coverage = new DisplayCoverage({ isVisible: () => true,
		measure: async () => settled ? { kind: 'settled', covered } : { kind: 'waiting' }, load });
	coverage.wake(); await vi.advanceTimersByTimeAsync(1000);
	expect(load).not.toHaveBeenCalled();
	expect(coverage.status).toBe('waiting');
	settled = true; coverage.wake(); await vi.advanceTimersByTimeAsync(10);
	expect(coverage.status).toBe('covered');
	covered = false; coverage.wake(); await vi.advanceTimersByTimeAsync(10);
	expect(load).toHaveBeenCalledOnce();
	expect(coverage.status).toBe('covered');
	coverage.dispose();
});

it('does not apply a late measurement after disposal', async () => {
	const held = Promise.withResolvers<CoverageMeasurement>();
	const load = vi.fn(async () => 'loaded' as const);
	const coverage = new DisplayCoverage({ isVisible: () => true, measure: () => held.promise, load });
	coverage.wake(); await vi.advanceTimersByTimeAsync(1);
	coverage.dispose(); held.resolve({ kind: 'settled', covered: false });
	await vi.advanceTimersByTimeAsync(1000);
	expect(load).not.toHaveBeenCalled();
});
