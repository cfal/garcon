import { promises as fs } from 'node:fs';
import os from 'node:os';

const MIGRATION_MEMORY_FACTOR = 8;

export async function assertMigrationCapacity(
  workspaceDir: string,
  sourceBytes: number,
): Promise<void> {
  if (sourceBytes === 0) return;
  const [disk, availableMemory] = await Promise.all([
    fs.statfs(workspaceDir),
    availableMemoryBytes(),
  ]);
  assertMigrationBudget({
    sourceBytes,
    availableDisk: Number(disk.bavail) * Number(disk.bsize),
    availableMemory,
  });
}

// Budgets against system memory rather than `v8.getHeapStatistics()`: Bun grows
// its heap on demand, so the reported limit tracks current usage instead of a
// ceiling and starts near 350MB, which rejected every workspace whose legacy file
// exceeded ~120MB. The factor covers the one unavoidable whole-file parse plus the
// chat being converted beside it; a 208MiB legacy file completes under a hard
// 1200MiB cgroup cap and is killed at 1000MiB, so 8x leaves working headroom.
// That measurement is only meaningful because `availableMemoryBytes` now honours
// the cgroup limit: while it read host MemAvailable alone, the guard approved the
// 1000MiB run it should have refused, and the kill looked like workload rather
// than a broken preflight.
export function assertMigrationBudget(input: {
  readonly sourceBytes: number;
  readonly availableDisk: number;
  readonly availableMemory: number;
}): void {
  if (input.sourceBytes === 0) return;
  const requiredDisk = Math.ceil(input.sourceBytes * 2.5) + 64 * 1024 * 1024;
  if (input.availableDisk < requiredDisk) {
    throw new Error(`Carryover migration requires at least ${requiredDisk} free bytes`);
  }
  const requiredMemory = input.sourceBytes * MIGRATION_MEMORY_FACTOR;
  if (input.availableMemory < requiredMemory) {
    throw new Error(`Carryover migration requires at least ${requiredMemory} bytes of free memory`);
  }
}

// Linux parks reclaimable pages in the page cache, so MemFree understates what a
// migration can use; MemAvailable is the kernel's own estimate of that headroom.
// A cgroup limit caps that further and is what actually kills the process, so the
// smaller of the two governs. Reading only MemAvailable approved migrations a
// container could never complete and turned the guard into an OOM restart loop.
async function availableMemoryBytes(): Promise<number> {
  const host = await hostAvailableBytes();
  const cgroup = await cgroupAvailableBytes();
  return cgroup === null ? host : Math.min(host, cgroup);
}

async function hostAvailableBytes(): Promise<number> {
  try {
    const available = /^MemAvailable:\s+(\d+) kB$/m.exec(
      await fs.readFile('/proc/meminfo', 'utf8'),
    );
    if (available) return Number(available[1]) * 1024;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return os.freemem();
}

// Returns the process's remaining cgroup v2 allowance, or null when there is no
// finite readable limit. An unreadable or absent limit is not treated as zero:
// that would refuse every migration on hosts without cgroups.
export async function cgroupAvailableBytes(
  roots: { readonly selfCgroup: string; readonly mount: string } = {
    selfCgroup: '/proc/self/cgroup',
    mount: '/sys/fs/cgroup',
  },
): Promise<number | null> {
  try {
    const self = await fs.readFile(roots.selfCgroup, 'utf8');
    const path = /^0::(.*)$/m.exec(self)?.[1];
    if (path === undefined) return null;
    const dir = `${roots.mount}${path}`;
    const [max, current] = await Promise.all([
      fs.readFile(`${dir}/memory.max`, 'utf8'),
      fs.readFile(`${dir}/memory.current`, 'utf8'),
    ]);
    if (max.trim() === 'max') return null;
    const limit = Number(max.trim());
    const used = Number(current.trim());
    if (!Number.isFinite(limit) || !Number.isFinite(used)) return null;
    return Math.max(0, limit - used);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return null;
    throw error;
  }
}
