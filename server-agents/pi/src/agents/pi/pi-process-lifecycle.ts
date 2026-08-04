const PROCESS_EXIT_TERM_MS = 5_000;
const PROCESS_EXIT_KILL_MS = 5_000;

export async function terminatePiProcess(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (!proc.killed) proc.kill('SIGTERM');
  if (await waitForExit(proc, PROCESS_EXIT_TERM_MS)) return;
  proc.kill('SIGKILL');
  if (!(await waitForExit(proc, PROCESS_EXIT_KILL_MS))) {
    throw new Error('Pi process did not exit after SIGKILL');
  }
}

async function waitForExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      proc.exited.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
