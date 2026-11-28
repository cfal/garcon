import { readFile } from 'node:fs/promises';
import { captureStep, isUnported, type Capture } from './capture.js';
import { startServer, type ServerBuild } from './environment.js';
import { normalizeCapture } from './normalize.js';
import { BlockedPlaceholder, dayPlaceholders, resolvePlaceholders, type Placeholders } from './placeholders.js';
import type { Scenario } from './scenario.js';
import { expandTraps } from './traps.js';
import type { Json } from './wildcard.js';

export type UnavailableCase =
  | { kind: 'unported' }
  | { kind: 'blocked'; supplier: string };

export interface CaseRun {
  name: string;
  capture: Json;
  unavailable?: UnavailableCase;
  unresolvedPlaceholder?: string;
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
// Steps share the server, so state built by one step is visible to the next,
// and a later step can name a value of an earlier step's response.
export async function runScenario(repoRoot: string, build: ServerBuild, scenario: Scenario): Promise<CaseRun[]> {
  const server = await startServer(repoRoot, build, scenario.server);
  try {
    const runs: CaseRun[] = [];
    let offset = (await fallbacksSince(server.fallbackLogPath, 0)).offset;
    // Each step's capture before normalization, for later response placeholders.
    const captures = new Map<string, Capture>();
    const unavailable = new Set<string>();
    // Values earlier responses gave to placeholders, which later responses repeat.
    const carried = new Map<string, string>();
    // One clock for the whole run, so a day does not change between a request and its response.
    const now = new Date();
    const days = dayPlaceholders(scenario.steps, now);
    for (const step of expandTraps(scenario)) {
      let placeholders: Placeholders;
      try {
        placeholders = resolvePlaceholders(server, step, captures, now, unavailable);
      } catch (error) {
        if (error instanceof BlockedPlaceholder) {
          unavailable.add(step.name);
          runs.push({ name: step.name, capture: null, fallbacks: [], unavailable: { kind: 'blocked', supplier: error.supplier } });
        } else {
          const message = error instanceof Error ? error.message : String(error);
          runs.push({ name: step.name, capture: null, fallbacks: [], unresolvedPlaceholder: message });
        }
        continue;
      }
      for (const [value, placeholder] of placeholders.carried) carried.set(value, placeholder);
      let capture: Json;
      let unported = false;
      try {
        const raw = await captureStep(server, step, placeholders);
        captures.set(step.name, raw);
        capture = normalizeCapture(raw, server, { carried: [...carried], days });
        unported = isUnported(raw);
      } catch (error) {
        capture = { error: error instanceof Error ? error.message : String(error) };
      }
      const added = await fallbacksSince(server.fallbackLogPath, offset);
      if (unported) unavailable.add(step.name);
      runs.push({ name: step.name, capture, fallbacks: added.lines, ...(unported ? { unavailable: { kind: 'unported' } } : {}) });
      offset = added.offset;
    }
    return runs;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${build.label}: scenario ${scenario.name} failed: ${reason}\n${server.logs().slice(-4000)}`, { cause: error });
  } finally {
    await server.stop();
  }
}
