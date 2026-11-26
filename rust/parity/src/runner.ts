import { readFile } from 'node:fs/promises';
import { captureStep } from './capture.js';
import { startServer, type ServerBuild } from './environment.js';
import { normalizeCapture } from './normalize.js';
import type { Scenario } from './scenario.js';
import { expandTraps } from './traps.js';
import type { Json } from './wildcard.js';

export interface CaseRun {
  name: string;
  capture: Json;
  // Requests the build handed to the original instead of serving natively.
  fallbacks: string[];
}

// Reads the fallback lines appended since `offset`, returning them and the
// new offset, so each step reads only what it added.
async function fallbacksSince(path: string, offset: number): Promise<{ lines: string[]; offset: number }> {
  const bytes = await readFile(path).catch(() => Buffer.alloc(0));
  const added = bytes.subarray(offset).toString('utf8');
  return { lines: added.split('\n').filter(Boolean), offset: bytes.length };
}

// Starts a fresh server for the scenario and runs its steps and traps in order.
// Steps share the server, so state built by one step is visible to the next.
export async function runScenario(repoRoot: string, build: ServerBuild, scenario: Scenario): Promise<CaseRun[]> {
  const server = await startServer(repoRoot, build, scenario.server);
  try {
    const runs: CaseRun[] = [];
    let offset = (await fallbacksSince(server.fallbackLogPath, 0)).offset;
    for (const step of expandTraps(scenario)) {
      let capture: Json;
      try {
        capture = normalizeCapture(await captureStep(server, step), server);
      } catch (error) {
        capture = { error: error instanceof Error ? error.message : String(error) };
      }
      const added = await fallbacksSince(server.fallbackLogPath, offset);
      runs.push({ name: step.name, capture, fallbacks: added.lines });
      offset = added.offset;
    }
    return runs;
  } catch (error) {
    throw new Error(`${build.label}: scenario ${scenario.name} failed\n${server.logs().slice(-4000)}`, { cause: error });
  } finally {
    await server.stop();
  }
}
