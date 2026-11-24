const EXIT_STATUS_GRACE_MS = 100;

// Bun can reject a pipe write before publishing exit; a live child closing stdin must not stall rollback.
export async function exitCodeAfterInputFailure(process: Pick<Bun.Subprocess, 'exited'>): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited.catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), EXIT_STATUS_GRACE_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
