import { readFile } from 'node:fs/promises';

export async function cpuSecondsOf(pid: number): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return (utime + stime) / 100;
}

export async function rssBytesOf(pid: number): Promise<number> {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const match = status.match(/VmRSS:\s+(\d+) kB/);
  return match ? Number(match[1]) * 1_024 : 0;
}

export interface DutySample {
  readonly wallMs: number;
  readonly cpuMs: number;
}

export async function sampleDuty(pid: number, windowMs: number): Promise<DutySample> {
  const beforeCpu = await cpuSecondsOf(pid);
  const beforeWall = performance.now();
  await Bun.sleep(windowMs);
  return {
    wallMs: performance.now() - beforeWall,
    cpuMs: (await cpuSecondsOf(pid) - beforeCpu) * 1_000,
  };
}

export function trackPeakRss(pid: number, intervalMs = 500): { stop(): Promise<number> } {
  let peak = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      peak = Math.max(peak, await rssBytesOf(pid).catch(() => 0));
      await Bun.sleep(intervalMs);
    }
    return peak;
  })();
  return {
    stop: async () => {
      running = false;
      return loop;
    },
  };
}
