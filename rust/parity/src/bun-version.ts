// The Bun the original is recorded and replayed on is the one the repository
// pins for CI and the release build (ADR-026): the original itself behaves
// differently on another version, so a recording made elsewhere does not
// describe the behavior to mirror.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Where the repository pins the Bun that CI installs.
export const PIN = '.github/workflows/rust-parity.yml';

// The Bun version the repository pins, read each time: the pin can move.
export async function pinnedBunVersion(repoRoot: string): Promise<string> {
  const workflow = await readFile(join(repoRoot, PIN), 'utf8');
  const pinned = /^\s*bun-version:\s*["']?([^"'\s]+)/m.exec(workflow)?.[1];
  if (!pinned) throw new Error(`${PIN} pins no Bun version: it needs a \`bun-version\` line.`);
  return pinned;
}

export interface BunCheck {
  // Whether the command must stop before it records anything.
  refuse: boolean;
  // What to print when the run goes ahead on another Bun than the pinned one.
  warning: string | null;
}

// What a command does on another Bun than the pinned one. `record` refuses,
// since its recording would describe another runtime, unless `anyBun` says to
// go ahead; `replay` goes ahead and warns, since it compares two runs made on
// the same Bun and so still says whether the build matches the original.
export function bunCheck(command: 'record' | 'replay', running: string, pinned: string, anyBun: boolean): BunCheck {
  if (running === pinned) return { refuse: false, warning: null };
  const message = `Bun ${running} runs this command, and the repository pins ${pinned} for recordings (${PIN}): the original behaves differently on other versions.`;
  if (command === 'record' && !anyBun) {
    return { refuse: true, warning: `${message} Start it with Bun ${pinned}, or pass --any-bun to record anyway.` };
  }
  const advice = command === 'record' ? 'A recording made now describes Bun ' : 'A replay made now compares builds on Bun ';
  return { refuse: false, warning: `${message} ${advice}${running}.` };
}
