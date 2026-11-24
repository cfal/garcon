import { readdirSync, readFileSync } from 'node:fs';

const OWNER = 'GARCON_TEST_BOMBADIL_OWNER';

function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch {
    return null;
  }
}

// Chromium creates a separate process group. An inherited, per-run nonce also
// identifies descendants that were reparented before the runner could observe them.
export class OwnedBrowserProcesses {
  readonly environment = { [OWNER]: crypto.randomUUID() };

  members(): Array<{ pid: number; started: string }> {
    const members: Array<{ pid: number; started: string }> = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const started = processStartTime(pid);
      if (!started) continue;
      try {
        const environment = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        if (environment.includes(`${OWNER}=${this.environment[OWNER]}`)) members.push({ pid, started });
      } catch { /* Processes may exit between the two reads. */ }
    }
    return members;
  }

  async cleanup(): Promise<number> {
    const gracefulDeadline = Date.now() + 2_000;
    while (this.members().length > 0 && Date.now() < gracefulDeadline) {
      await Bun.sleep(25);
    }
    const signaled = new Set<string>();
    const deadline = Date.now() + 3_000;
    while (this.members().length > 0 && Date.now() < deadline) {
      for (const member of this.members()) {
        if (processStartTime(member.pid) !== member.started) continue;
        try {
          process.kill(member.pid, 'SIGKILL');
          signaled.add(`${member.pid}:${member.started}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await Bun.sleep(25);
    }
    if (this.members().length) throw new Error('Owned Bombadil processes survived cleanup');
    return signaled.size;
  }
}
