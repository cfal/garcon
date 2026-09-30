import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationDirectories } from './integration-fixture.js';

// Claude runs SessionStart hooks before it starts a new session's first input. A hook that
// waits for this gate keeps a turn admitted but not yet steerable until the test opens it.
export class ClaudeSessionStartGate {
  #path: string | null = null;

  async install(directories: IntegrationDirectories): Promise<void> {
    const path = join(directories.root, 'claude-session-start-gate');
    const settingsDirectory = join(directories.home, '.claude');
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(join(settingsDirectory, 'settings.json'), JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            // Bounded, so a test that never opens the gate fails instead of hanging.
            command: `i=0; while [ ! -e ${JSON.stringify(path)} ] && [ "$i" -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`,
            timeout: 90,
          }],
        }],
      },
    }));
    this.#path = path;
  }

  async open(): Promise<void> {
    if (!this.#path) throw new Error('The Claude session start gate is not installed');
    await writeFile(this.#path, 'open');
  }
}
