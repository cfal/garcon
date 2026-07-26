const CLAUDE_PROCESS_EXIT_GRACE_MS = 5_000;
const CLAUDE_PROCESS_EXIT_FORCE_MS = 5_000;

type ClaudeSubprocess = ReturnType<typeof Bun.spawn>;

interface ExitingProcessGroup {
  readonly chatId: string;
  readonly processes: Set<ClaudeSubprocess>;
}

async function waitForClaudeProcessExit(
  subprocess: ClaudeSubprocess,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      subprocess.exited.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ClaudeProjectPathProcessTracker {
  readonly #exitingProcesses = new Map<string, ExitingProcessGroup>();

  trackDetached(
    agentSessionId: string,
    chatId: string,
    subprocess: ClaudeSubprocess,
  ): void {
    let exiting = this.#exitingProcesses.get(agentSessionId);
    if (!exiting) {
      exiting = { chatId, processes: new Set() };
      this.#exitingProcesses.set(agentSessionId, exiting);
    }
    exiting.processes.add(subprocess);
    void subprocess.exited.then(
      () => this.#forget(agentSessionId, subprocess),
      () => this.#forget(agentSessionId, subprocess),
    );
  }

  async stopForUpdate(input: {
    readonly agentSessionId: string;
    readonly chatId: string;
    readonly activeProcess: ClaudeSubprocess | null;
  }): Promise<void> {
    const exiting = this.#exitingProcesses.get(input.agentSessionId);
    if (exiting && exiting.chatId !== input.chatId) {
      throw new Error('Chat ID mismatch');
    }

    const subprocesses = [...(exiting?.processes ?? [])];
    if (input.activeProcess) subprocesses.push(input.activeProcess);
    if (subprocesses.length === 0) return;

    for (const subprocess of subprocesses) {
      if (!subprocess.killed) subprocess.kill();
    }
    const gracefulExits = await Promise.all(subprocesses.map((subprocess) =>
      waitForClaudeProcessExit(subprocess, CLAUDE_PROCESS_EXIT_GRACE_MS)
    ));
    const remaining = subprocesses.filter((_, index) => !gracefulExits[index]);
    for (const subprocess of remaining) subprocess.kill('SIGKILL');
    const forcedExits = await Promise.all(remaining.map((subprocess) =>
      waitForClaudeProcessExit(subprocess, CLAUDE_PROCESS_EXIT_FORCE_MS)
    ));
    if (forcedExits.some((exited) => !exited)) {
      throw new Error('Claude process did not exit for project-path update');
    }
  }

  #forget(agentSessionId: string, subprocess: ClaudeSubprocess): void {
    const exiting = this.#exitingProcesses.get(agentSessionId);
    if (!exiting) return;
    exiting.processes.delete(subprocess);
    if (exiting.processes.size === 0) {
      this.#exitingProcesses.delete(agentSessionId);
    }
  }
}
