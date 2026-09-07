import type { HistoricalSearchMessageRow } from '../rows.js';

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliett', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
  'xray', 'yankee', 'zulu', 'server', 'search', 'transcript', 'ledger',
];

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticBody(random: () => number, targetBytes: number): string {
  const parts: string[] = [];
  let size = 0;
  while (size < targetBytes) {
    const word = WORDS[Math.floor(random() * WORDS.length)]!;
    parts.push(word);
    size += word.length + 1;
  }
  return parts.join(' ');
}

export function syntheticRows(options: {
  readonly seed: number;
  readonly count: number;
  readonly bodyBytes?: number;
  readonly startOrdinal?: number;
  readonly marker?: string;
}): HistoricalSearchMessageRow[] {
  const random = mulberry32(options.seed);
  return Array.from({ length: options.count }, (_, index) => {
    const base = syntheticBody(random, options.bodyBytes ?? 320);
    return {
      ordinal: (options.startOrdinal ?? 1) + index,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      timestamp: '2026-01-01T00:00:00.000Z',
      body: options.marker && index % 7 === 0 ? `${base} ${options.marker}` : base,
    };
  });
}
