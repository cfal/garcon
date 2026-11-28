// The original tests send multi-megabyte runs through the converter. The fixture
// stores those strings losslessly without checking in hundreds of megabytes.
const tag = '$agyTextRuns';
const minRun = 8192;

function packText(text: string): unknown {
  if (text.length < minRun) return text;
  const parts: (string | [string, number])[] = [];
  let pending = 0;
  for (let start = 0; start < text.length;) {
    const char = text[start];
    if (char !== 'x' && char !== ' ') {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < text.length && text[end] === char) end++;
    if (end - start >= minRun) {
      if (pending < start) parts.push(text.slice(pending, start));
      parts.push([char, end - start]);
      pending = end;
    }
    start = end;
  }
  if (!parts.length) return text;
  if (pending < text.length) parts.push(text.slice(pending));
  return { [tag]: parts };
}

export function packLargeText(value: unknown): unknown {
  if (typeof value === 'string') return packText(value);
  if (Array.isArray(value)) return value.map(packLargeText);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, packLargeText(item)]));
  }
  return value;
}

export function unpackLargeText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unpackLargeText);
  if (value && typeof value === 'object') {
    const wrapped = value as Record<string, unknown>;
    if (Object.hasOwn(wrapped, tag) && Object.keys(wrapped).length === 1) {
      const parts = wrapped[tag] as (string | [string, number])[];
      return parts.map(part => typeof part === 'string' ? part : part[0].repeat(part[1])).join('');
    }
    return Object.fromEntries(Object.entries(wrapped).map(([key, item]) => [key, unpackLargeText(item)]));
  }
  return value;
}
