import { PI_MODELS, type SharedModelOption } from '../../common/models.js';
import { getPiBinary } from '../config.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedModels: SharedModelOption[] | null = null;
let cachedAt = 0;
let inflight: Promise<SharedModelOption[]> | null = null;

function splitTableLine(line: string): string[] {
  return line.trim().split(/\s{2,}/).map((part) => part.trim());
}

export function parsePiListModelsOutput(raw: string): SharedModelOption[] {
  const rows: SharedModelOption[] = [];
  const lines = raw.split('\n').filter((line) => line.trim());
  const headerIndex = lines.findIndex((line) => {
    const cols = splitTableLine(line).map((col) => col.toLowerCase());
    return cols[0] === 'provider'
      && cols[1] === 'model'
      && cols[2] === 'context'
      && cols[3] === 'max-out';
  });
  if (headerIndex < 0) return rows;

  for (const line of lines.slice(headerIndex + 1)) {
    const cols = splitTableLine(line);
    if (cols.length < 6) continue;
    const [provider, model, _context, _maxOut, _thinking, images] = cols;
    if (!provider || !model) continue;
    rows.push({
      value: `${provider}/${model}`,
      label: `${provider}/${model}`,
      supportsImages: images.toLowerCase() === 'yes',
    });
  }

  return rows;
}

async function readPiModels(): Promise<SharedModelOption[]> {
  const proc = Bun.spawn([getPiBinary(), '--list-models'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error((stderr || stdout || `pi --list-models exited ${exitCode}`).trim());
  }
  return parsePiListModelsOutput(stdout);
}

export async function getPiModels(): Promise<SharedModelOption[]> {
  const now = Date.now();
  if (cachedModels && now - cachedAt < MODEL_CACHE_TTL_MS) return cachedModels;
  if (inflight) return inflight;

  inflight = readPiModels()
    .then((models) => {
      cachedModels = [
        ...PI_MODELS.OPTIONS,
        ...models.filter((model) => model.value !== PI_MODELS.DEFAULT),
      ];
      cachedAt = Date.now();
      return cachedModels;
    })
    .catch(() => PI_MODELS.OPTIONS)
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function clearPiModelCacheForTests(): void {
  cachedModels = null;
  cachedAt = 0;
  inflight = null;
}
