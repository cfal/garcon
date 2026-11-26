import type { HttpStep, Scenario, ScenarioStep } from './scenario.js';

// Trap variants probe the edges a port most often gets wrong: authentication
// failures, path decoding and traversal, method and trailing-slash routing,
// non-ASCII input, and malformed bodies. They run after the scenario's own
// steps, in a fixed order, so both builds see the same server state.

const PATH_TRAPS: Array<[string, (path: string) => string]> = [
  ['trailing-slash', (path) => (path.endsWith('/') ? path.slice(0, -1) || '/' : `${path}/`)],
  ['dot-segment', (path) => `${path.replace(/\/$/, '')}/../${path.split('/').filter(Boolean).at(-1) ?? ''}`],
  ['encoded-traversal', (path) => `${path.replace(/\/$/, '')}/%2e%2e%2fauth.json`],
  ['non-ascii', (path) => `${path.replace(/\/$/, '')}/%C3%BC-%E9%9B%AA-%F0%9F%98%80`],
  ['double-slash', (path) => path.replace(/^\//, '//')],
];

function withPath(step: HttpStep, transform: (path: string) => string): HttpStep {
  if (step.originPath !== undefined) return { ...step, originPath: transform(step.originPath) };
  return { ...step, path: transform(step.path ?? '/') };
}

function httpTraps(step: ScenarioStep & { http: HttpStep }): ScenarioStep[] {
  const http = step.http;
  const traps: ScenarioStep[] = [];
  if ((http.auth ?? 'token') === 'token') {
    traps.push({ name: `${step.name}~unauthenticated`, http: { ...http, auth: 'none' } });
    traps.push({ name: `${step.name}~forged-token`, http: { ...http, auth: 'forged' } });
  }
  const method = http.method.toUpperCase();
  if (method === 'GET') {
    traps.push({ name: `${step.name}~head`, http: { ...http, method: 'HEAD' } });
    for (const [trap, transform] of PATH_TRAPS) {
      traps.push({ name: `${step.name}~${trap}`, http: withPath(http, transform) });
    }
  }
  if (http.json !== undefined) {
    traps.push({
      name: `${step.name}~malformed-json`,
      http: { ...http, json: undefined, body: '{"unterminated', headers: { ...http.headers, 'Content-Type': 'application/json' } },
    });
    traps.push({
      name: `${step.name}~non-ascii-json`,
      http: { ...http, json: { text: 'ü 雪 😀 ‮ \u0000' } },
    });
  }
  return traps;
}

export function expandTraps(scenario: Scenario): ScenarioStep[] {
  if (!scenario.traps) return scenario.steps;
  const traps = scenario.steps.flatMap((step): ScenarioStep[] => {
    if (step.http) return httpTraps(step as ScenarioStep & { http: HttpStep });
    if (step.ws) {
      return [
        { name: `${step.name}~unauthenticated`, ws: { ...step.ws, auth: 'none' } },
        { name: `${step.name}~forged-token`, ws: { ...step.ws, auth: 'forged' } },
        { name: `${step.name}~no-protocol`, ws: { ...step.ws, protocols: [] } },
      ];
    }
    return [];
  });
  return [...scenario.steps, ...traps];
}
