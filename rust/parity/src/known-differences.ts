import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { firstDifference, isObject, parseJsonPath, WILDCARD, type Difference, type Json } from './wildcard.js';

export interface KnownDifference {
  scope: 'scenario' | 'suite';
  name: string;
  case: string;
  path: string;
  parts: ReadonlyArray<string | number>;
  result: Json;
  reason: string;
  buildLabels?: readonly string[];
}

export function parseKnownDifferences(json: Json): KnownDifference[] {
  if (!Array.isArray(json)) throw new Error('Known differences must be a JSON array');
  const identities = new Set<string>();
  return json.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`Known difference ${index + 1} must be an object`);
    const scope = Object.hasOwn(entry, 'scenario') ? 'scenario' : 'suite';
    const name = entry[scope];
    if (Object.hasOwn(entry, 'scenario') === Object.hasOwn(entry, 'suite')
      || typeof name !== 'string' || !name.trim()
      || typeof entry.case !== 'string' || !entry.case.trim()
      || typeof entry.path !== 'string'
      || typeof entry.reason !== 'string' || !entry.reason.trim()
      || !Object.hasOwn(entry, 'result')) {
      throw new Error(`Known difference ${index + 1} needs exactly one scenario or suite, a case, path, result and reason`);
    }
    const buildLabels = entry.buildLabels;
    if (buildLabels !== undefined && (scope !== 'scenario' || !Array.isArray(buildLabels) || !buildLabels.length
      || !buildLabels.every((label): label is string => typeof label === 'string' && label.trim().length > 0)
      || new Set(buildLabels).size !== buildLabels.length)) {
      throw new Error(`Known difference ${index + 1}: buildLabels must be a nonempty list of distinct scenario replay labels`);
    }
    const identity = JSON.stringify([scope, name, entry.case, entry.path]);
    if (identities.has(identity)) throw new Error(`Duplicate known difference for ${name}/${entry.case} at ${entry.path}`);
    identities.add(identity);
    return {
      scope, name, case: entry.case, path: entry.path, parts: parseJsonPath(entry.path), result: entry.result!, reason: entry.reason,
      ...(buildLabels === undefined ? {} : { buildLabels }),
    };
  });
}

export async function readKnownDifferences(repoRoot: string): Promise<KnownDifference[]> {
  return parseKnownDifferences(JSON.parse(await readFile(join(repoRoot, 'rust/parity/known-differences.json'), 'utf8')) as Json);
}

export function scenarioKnownDifferencesForBuild(entries: readonly KnownDifference[], label: string): KnownDifference[] {
  return entries.filter((entry) => entry.scope === 'scenario' && (entry.buildLabels?.includes(label) ?? true));
}

function atPath(value: Json | undefined, parts: KnownDifference['parts']): { value: Json | undefined; wildcardAncestor?: true } {
  for (const key of parts) {
    if (value === WILDCARD) return { value: undefined, wildcardAncestor: true };
    if (typeof key === 'number' && Array.isArray(value)) value = value[key];
    else if (typeof key === 'string' && isObject(value) && Object.hasOwn(value, key)) value = value[key];
    else return { value: undefined };
  }
  return { value };
}

const describe = (value: Json | undefined) => value === undefined ? '(absent)' : JSON.stringify(value).slice(0, 200);

function stale(entry: KnownDifference): Difference {
  return { path: entry.path, kind: 'value', expected: `a known difference still present (${entry.reason})`, actual: 'matches the original recording' };
}

export function compareWithKnown(
  expected: Json | undefined,
  actual: Json | undefined,
  entries: readonly KnownDifference[],
): Difference | null {
  if (!entries.length || expected === undefined || actual === undefined) return firstDifference(expected, actual);
  if (!firstDifference(expected, actual)) return stale(entries[0]!);
  const approved = new Set<string>();
  for (const entry of entries) {
    const original = atPath(expected, entry.parts);
    const candidate = atPath(actual, entry.parts).value;
    if (original.wildcardAncestor || !firstDifference(original.value, candidate)) return stale(entry);
    if (!isDeepStrictEqual(candidate, entry.result)) {
      return { path: entry.path, kind: 'value', expected: describe(entry.result), actual: describe(candidate) };
    }
    approved.add(entry.path);
  }
  return firstDifference(expected, actual, '$', approved);
}

export function missingKnownCase(entry: KnownDifference): Difference {
  return { path: entry.path, kind: 'missing', expected: `a recorded case for the known difference (${entry.reason})`, actual: '(case no longer recorded)' };
}
