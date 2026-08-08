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
async function availableMemoryBytes(): Promise<number> {
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
