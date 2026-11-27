import { createHash } from 'node:crypto';
import type { CapturedBody, CapturedExchange, Capture } from './capture.js';
import type { StartedServer } from './environment.js';
import { dayPattern } from './placeholders.js';
import type { Json } from './wildcard.js';

export interface Normalization {
  // `[value, placeholder]`: values the scenario took from earlier responses,
  // which later responses must show under the same placeholder.
  carried?: ReadonlyArray<readonly [string, string]>;
  // `[day, placeholder]`: the clock-relative days the scenario names.
  days?: ReadonlyArray<readonly [string, string]>;
}

interface Context {
  pairs: ReadonlyArray<readonly [string, string]>;
  days: ReadonlyArray<readonly [RegExp, string]>;
}

// Replaces values that belong to one server start (temporary directories, the
// listening port, the session token) with stable placeholders, so a recording
// made on one machine replays on another.
function replacements(server: StartedServer, carried: Normalization['carried']): ReadonlyArray<readonly [string, string]> {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ...(carried ?? []),
    [server.dirs.configDir, '{{configDir}}'],
    [server.dirs.workspaceDir, '{{workspaceDir}}'],
    [server.dirs.projectDir, '{{projectDir}}'],
    [server.dirs.homeDir, '{{homeDir}}'],
    [server.dirs.root, '{{root}}'],
    [server.origin, '{{origin}}'],
    [server.origin.replace('127.0.0.1', 'localhost'), '{{origin}}'],
    [`:${server.port}`, ':{{port}}'],
    [server.token, '{{token}}'],
    [server.credentials.password, '{{password}}'],
  ];
  // A server without an account has no token or password to look for; an
  // empty value would match between every two characters.
  return pairs.filter(([from]) => from.length > 0).sort((left, right) => right[0].length - left[0].length);
}

// Values whose format is part of the contract but whose content changes with
// the clock or a random source, like rust-anything's built-in normalizers.
// Keeping a placeholder still checks that a value of that kind is present.
const VOLATILE_FORMATS: Array<[RegExp, string]> = [
  [/\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, '{{jwt}}'],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, '{{timestamp}}'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{{uuid}}'],
];

function normalizeString(value: string, { pairs, days }: Context): string {
  const replaced = pairs.reduce(
    (text, [from, to]) => (text.includes(from) ? text.replaceAll(from, to) : text),
    value,
  );
  const volatile = VOLATILE_FORMATS.reduce((text, [pattern, placeholder]) => text.replace(pattern, placeholder), replaced);
  // Days come last, so the date of an ISO timestamp is already a placeholder.
  return days.reduce((text, [pattern, placeholder]) => text.replace(pattern, placeholder), volatile);
}

function normalizeJson(value: Json, context: Context): Json {
  if (typeof value === 'string') return normalizeString(value, context);
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [normalizeString(key, context), normalizeJson(item, context)]));
  }
  return value;
}

// A body too large to record is kept as the digest and the byte length of its
// normalized text. Hashing the text as sent would differ whenever the body
// holds a value of the server start, and the digest would become a wildcard
// that compares nothing.
function textDigest(text: string): Json {
  const bytes = Buffer.from(text, 'utf8');
  return { kind: 'text-digest', sha256: createHash('sha256').update(bytes).digest('hex'), length: bytes.length };
}

export function normalizeCapture(capture: Capture, server: StartedServer, extra: Normalization = {}): Json {
  const context: Context = {
    pairs: replacements(server, extra.carried),
    days: (extra.days ?? []).map(([day, placeholder]) => [dayPattern(day), placeholder]),
  };
  const body = (capture as { body?: CapturedBody }).body;
  if (body?.kind === 'large-text') {
    const { body: _body, ...rest } = capture as CapturedExchange;
    return { ...normalizeJson(rest as unknown as Json, context) as { [key: string]: Json }, body: textDigest(normalizeString(body.value, context)) };
  }
  return normalizeJson(capture as unknown as Json, context);
}
