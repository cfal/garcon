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

async function fallbackLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean);
}

// Starts a fresh server for the scenario and runs its steps and traps in order.
// Steps share the server, so state built by one step is visible to the next.
export async function runScenario(repoRoot: string, build: ServerBuild, scenario: Scenario): Promise<CaseRun[]> {
  const server = await startServer(repoRoot, build, scenario.server);
  try {
    const runs: CaseRun[] = [];
    let seenFallbacks = (await fallbackLines(server.fallbackLogPath)).length;
    for (const step of expandTraps(scenario)) {
      let capture: Json;
      try {
        capture = normalizeCapture(await captureStep(server, step), server);
      } catch (error) {
        capture = { error: error instanceof Error ? error.message : String(error) };
      }
      const lines = await fallbackLines(server.fallbackLogPath);
      runs.push({ name: step.name, capture, fallbacks: lines.slice(seenFallbacks) });
      seenFallbacks = lines.length;
    }
    return runs;
  } catch (error) {
    throw new Error(`${build.label}: scenario ${scenario.name} failed\n${server.logs().slice(-4000)}`, { cause: error });
  } finally {
    await server.stop();
  }
}
