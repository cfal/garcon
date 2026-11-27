import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from './wildcard.js';

// `auth` selects the credential a request carries: the parity session token
// (default), none, or a syntactically valid token signed with another secret.
export type RequestAuth = 'token' | 'none' | 'forged';

export interface HttpStep {
  method: string;
  // Relative to the server's base URL. `originPath` addresses the origin root
  // instead, for requests outside a base-path mount.
  path?: string;
  originPath?: string;
  headers?: Record<string, string>;
  json?: Json;
  body?: string;
  auth?: RequestAuth;
}

export interface WebSocketStep {
  path: string;
  auth?: RequestAuth;
  protocols?: string[];
  send?: Json[];
  // Replies are the frames that carry a `clientRequestId` the step sent.
  // They are collected until `frames` arrive, the socket closes, or the
  // socket stays quiet for `quietMs`. Unsolicited broadcasts are not
  // recorded, since their timing is not controlled by the step.
  frames?: number;
  quietMs?: number;
}

export interface ScenarioStep {
  name: string;
  http?: HttpStep;
  ws?: WebSocketStep;
}

export interface Scenario {
  name: string;
  description: string;
  server?: {
    basePath?: string;
    files?: Record<string, string>;
    // `none` starts the server without a provisioned account.
    account?: 'provisioned' | 'none';
    // `disabled` starts the server with authentication disabled.
    auth?: 'enabled' | 'disabled';
  };
  steps: ScenarioStep[];
  // Generates trap variants for every step; see traps.ts.
  traps?: boolean;
}

const SCENARIO_DIRECTORY = 'rust/parity/scenarios';

function assertScenario(value: unknown, file: string): asserts value is Scenario {
  const scenario = value as Partial<Scenario>;
  if (typeof scenario?.name !== 'string' || !Array.isArray(scenario.steps)) {
    throw new Error(`${file}: a scenario needs a name and steps`);
  }
  if (scenario.server?.account !== undefined && scenario.server.account !== 'provisioned' && scenario.server.account !== 'none') {
    throw new Error(`${file}: server.account is "provisioned" or "none"`);
  }
  if (scenario.server?.auth !== undefined && scenario.server.auth !== 'enabled' && scenario.server.auth !== 'disabled') {
    throw new Error(`${file}: server.auth is "enabled" or "disabled"`);
  }
  const names = new Set<string>();
  for (const step of scenario.steps) {
    if (typeof step?.name !== 'string' || (!step.http === !step.ws)) {
      throw new Error(`${file}: every step needs a name and exactly one of http or ws`);
    }
    if (names.has(step.name)) throw new Error(`${file}: duplicate step ${step.name}`);
    names.add(step.name);
  }
}

export async function loadScenarios(repoRoot: string, only?: string): Promise<Scenario[]> {
  const directory = join(repoRoot, SCENARIO_DIRECTORY);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const parsed: unknown = JSON.parse(await readFile(join(directory, file), 'utf8'));
    assertScenario(parsed, file);
    if (`${parsed.name}.json` !== file) throw new Error(`${file}: name must match the file name`);
    if (!only || parsed.name === only) scenarios.push(parsed);
  }
  return scenarios;
}
