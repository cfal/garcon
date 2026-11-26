import type { StartedServer } from './environment.js';
import type { Capture } from './capture.js';
import type { Json } from './wildcard.js';

// Replaces values that belong to one server start (temporary directories, the
// listening port, the session token) with stable placeholders, so a recording
// made on one machine replays on another.
function replacements(server: StartedServer): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
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
  return pairs.sort((left, right) => right[0].length - left[0].length);
}

// Values whose format is part of the contract but whose content changes with
// the clock or a random source, like rust-anything's built-in normalizers.
// Keeping a placeholder still checks that a value of that kind is present.
const VOLATILE_FORMATS: Array<[RegExp, string]> = [
  [/\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, '{{jwt}}'],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, '{{timestamp}}'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{{uuid}}'],
];

function normalizeString(value: string, pairs: Array<[string, string]>): string {
  const replaced = pairs.reduce((text, [from, to]) => text.replaceAll(from, to), value);
  return VOLATILE_FORMATS.reduce((text, [pattern, placeholder]) => text.replace(pattern, placeholder), replaced);
}

function normalizeJson(value: Json, pairs: Array<[string, string]>): Json {
  if (typeof value === 'string') return normalizeString(value, pairs);
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, pairs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [normalizeString(key, pairs), normalizeJson(item, pairs)]));
  }
  return value;
}

export function normalizeCapture(capture: Capture, server: StartedServer): Json {
  return normalizeJson(capture as unknown as Json, replacements(server));
}
