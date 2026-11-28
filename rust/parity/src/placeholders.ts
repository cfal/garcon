import type { Capture } from './capture.js';
import type { StartedServer } from './environment.js';
import type { ScenarioStep } from './scenario.js';
import { isObject, type Json } from './wildcard.js';

// `{{name}}` in a request stands for a value filled in when the step runs:
// a value of the server start (`token`, `projectDir`, ...), a day relative to
// the clock, or a value of an earlier step's response.

// What can stand between the braces. A name of an earlier step's response has
// the step's name in it, and step names use hyphens.
const NAME = String.raw`[\w~.\[\]-]+`;
export const PLACEHOLDER = new RegExp(String.raw`\{\{(${NAME})\}\}`, 'g');
const WHOLE_VALUE = new RegExp(`^\\{\\{(${NAME})\\}\\}$`);

// `{{<step>.body.<path>}}`: the value at `path` in the JSON body of the
// response to the step named `<step>`.
const RESPONSE_BODY = /^([\w~-]+)\.body\.(\w+(?:\[\d+\])?(?:\.\w+(?:\[\d+\])?)*)$/;
const RESPONSE_HEADER = /^([\w~-]+)\.headers\.([a-z0-9_.-]+)$/;
const PATH_TOKEN = /[^\.[\]]+|\[\d+\]/g;

const DAY_NAME = /^today(?:Plus(?<plus>\d+)|Minus(?<minus>\d+))?$/;
const DAY_MS = 86_400_000;

// A day placeholder names a calendar day, in UTC, as `YYYY-MM-DD`: the form
// `GET /api/v1/usage` takes (common/usage.ts). Returns null for any other name.
export function dayOf(name: string, now: Date): string | null {
  const match = DAY_NAME.exec(name);
  if (!match) return null;
  const offset = Number(match.groups?.plus ?? 0) - Number(match.groups?.minus ?? 0);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offset * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// The days a run can find in a response, each with the placeholder that names
// it. The run's own day is always among them: whatever puts it in a response, a
// golden holding the date would go stale the next day. Every other day is only
// one the scenario's requests name, so a fixed date stays a fixed date.
export function dayPlaceholders(steps: readonly ScenarioStep[], now: Date): Array<[string, string]> {
  const names = new Set(['today']);
  for (const step of steps) {
    for (const name of placeholderNames(step)) {
      if (dayOf(name, now) !== null) names.add(name);
    }
  }
  return [...names].map((name) => [dayOf(name, now)!, `{{${name}}}`]);
}

// A day as a whole token: not the date of a timestamp, and not part of a
// longer number or range.
export function dayPattern(day: string): RegExp {
  return new RegExp(`(?<![\\d-])${day}(?![\\dT\\d-])`, 'g');
}

// Every text of a step in which a placeholder can stand.
function texts(step: ScenarioStep): string[] {
  const http = step.http;
  const ws = step.ws;
  return [
    ...(http ? [
      http.path ?? '',
      http.originPath ?? '',
      ...Object.values(http.headers ?? {}),
      ...(http.rawHeaders?.map(([, value]) => value) ?? []),
      http.body ?? '',
      ...(http.json === undefined ? [] : [JSON.stringify(http.json)]),
    ] : []),
    ...(ws ? [
      ws.path,
      ...(ws.protocols ?? []),
      ...(ws.send ?? []).map((message) => JSON.stringify(message)),
    ] : []),
  ];
}

export function placeholderNames(step: ScenarioStep): string[] {
  const names = new Set<string>();
  for (const text of texts(step)) {
    for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]!);
  }
  return [...names];
}

export interface Placeholders {
  // The text each placeholder name stands for.
  values: Record<string, string>;
  // The placeholders that stand for a value which is not a string, for a JSON
  // body field whose whole value is the placeholder.
  typed: Record<string, Json>;
  // `[value, placeholder]`: values taken from earlier responses that later
  // responses must show under the placeholder.
  carried: Array<[string, string]>;
}

// A shorter value could be part of an unrelated word, so it is not looked for
// in later responses.
const MIN_CARRIED_LENGTH = 8;

function responseValue(step: ScenarioStep, name: string, stepName: string, path: string, captures: ReadonlyMap<string, Capture>, source: 'headers' | 'body'): unknown {
  const missing = (what: string) => new Error(`${step.name}: {{${name}}} has no value: ${what}.`);
  const capture = captures.get(stepName);
  if (!capture) throw missing(`no step named "${stepName}" ran before it`);
  if (source === 'headers') {
    const value = 'body' in capture ? capture.rawHeaders?.get(path) : null;
    if (value == null) throw missing(`the response of "${stepName}" has no header ${path}`);
    return value;
  }
  if (!('body' in capture) || capture.body.kind !== 'json') throw missing(`the response of "${stepName}" has no JSON body`);
  let value: unknown = capture.body.value;
  for (const token of path.match(PATH_TOKEN) ?? []) {
    if (token.startsWith('[')) {
      const index = Number(token.slice(1, -1));
      if (!Array.isArray(value) || index >= value.length) throw missing(`the response of "${stepName}" has no ${path}`);
      value = value[index];
    } else {
      if (!isObject(value as Json) || !(token in (value as object))) {
        throw missing(`the response of "${stepName}" has no ${path}`);
      }
      value = (value as Record<string, unknown>)[token];
    }
  }
  return value;
}

// Resolves every placeholder of a step. A placeholder that stands for a value
// of an earlier response must resolve in every run, so one that cannot fails
// the step instead of being sent as written.
export function resolvePlaceholders(server: StartedServer, step: ScenarioStep, captures: ReadonlyMap<string, Capture>, now: Date): Placeholders {
  const seeded: Record<string, string> = {
    username: server.credentials.username,
    password: server.credentials.password,
    projectDir: server.dirs.projectDir,
    workspaceDir: server.dirs.workspaceDir,
    token: server.token,
  };
  const resolved: Placeholders = { values: {}, typed: {}, carried: [] };
  for (const name of placeholderNames(step)) {
    const day = dayOf(name, now);
    const header = RESPONSE_HEADER.exec(name);
    const reference = header ?? RESPONSE_BODY.exec(name);
    if (day !== null) {
      resolved.values[name] = day;
    } else if (name in seeded) {
      resolved.values[name] = seeded[name];
    } else if (reference) {
      const [, stepName, path] = reference;
      const value = responseValue(step, name, stepName!, path!, captures, header ? 'headers' : 'body');
      if (typeof value !== 'string') resolved.typed[name] = value as Json;
      resolved.values[name] = typeof value === 'string' ? value : JSON.stringify(value);
      if (typeof value === 'string' && value.length >= MIN_CARRIED_LENGTH) resolved.carried.push([value, `{{${name}}}`]);
    }
    // Any other `{{word}}` is the request's own text and is sent as written.
  }
  return resolved;
}

export function expandPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (match, name: string) => values[name] ?? match);
}

// Expands the placeholders in a JSON body. A field whose whole value is one
// placeholder takes the value with its own type, so a number stays a number.
export function expandJson(value: Json, placeholders: Placeholders): Json {
  if (Array.isArray(value)) return value.map((item) => expandJson(item, placeholders));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandJson(item, placeholders)]));
  }
  if (typeof value !== 'string') return value;
  const whole = WHOLE_VALUE.exec(value);
  if (whole && whole[1]! in placeholders.typed) return placeholders.typed[whole[1]!];
  return expandPlaceholders(value, placeholders.values);
}
