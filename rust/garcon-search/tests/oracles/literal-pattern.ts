if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

// Mirrors the literal expression from query.ts:224, before the FTS filter.
function literalExpression(literal: string): RegExp {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll(' ', '[\\s\\p{White_Space}]+');
  const word = '[\\p{L}\\p{N}\\p{M}_]';
  const before = /^[\p{L}\p{N}\p{M}_]/u.test(literal) ? `(?<!${word})` : '';
  const after = /[\p{L}\p{N}\p{M}_]$/u.test(literal) ? `(?!${word})` : '';
  return new RegExp(`${before}${escaped}${after}`, 'iu');
}

const literalAndSpelling = [
  ['k', 'K'], ['k', '\u212a'], ['\u212a', 'k'],
  ['s', '\u017f'], ['\u017f', 'S'], ['S', '\u017f'],
  ['i', 'I'], ['i', '\u0130'], ['i', '\u0131'], ['\u0131', 'i'],
  ['\u03c3', '\u03a3'], ['\u03c3', '\u03c2'], ['\u03c2', '\u03a3'],
  ['\u00df', 'SS'], ['\u00df', '\u1e9e'], ['\u1e9e', '\u00df'],
  ['\u00e9', 'e\u0301'], ['e\u0301', '\u00e9'], ['\u00e9', '\u00c9'],
  ['\u{10400}', '\u{10428}'], ['\u{10428}', '\u{10400}'],
  ['\u{16ea0}', '\u{16ebb}'], ['\u{16ebb}', '\u{16ea0}'],
  ['A B', 'a b'], ['A B', 'a\u0085b'], ['A B', 'a\ufeffb'],
  ['A B', 'a\u2028\n\u2003b'], ['A B', 'ab'], ['A B', 'a\u200db'],
  ['a  b', 'a b'], ['a  b', 'a\u00a0 b'], ['a\0b', 'A\0B'],
  ['#731', '#731'], ['#731', '731'], ['C++', 'c++'], ['C++', 'c+'],
  ["/workspace/src/index.ts", "/WORKSPACE/src/index.ts"],
  ['a[b]\\c', 'A[B]\\C'], ['(a|b)', '(A|B)'], ['a.b?*', 'A.B?*'],
  ['`field`:"value"', '`FIELD`:"Value"'], ["don't", "DON'T"],
  ['x_4', 'X_4'], ['key:value', 'KEY:VALUE'],
  ['\u65e5\u672c\u8a9e', '\u65e5\u672c\u8a9e'],
  ['\u{10940}', '\u{10940}'], ['\u{1e6c0}', '\u{1e6c0}'],
  ['A\u200dB', 'a\u200db'],
  ['\u{1f469}\u200d\u{1f4bb} test', '\u{1f469}\u200d\u{1f4bb}\tTEST'],
] as const;

const contexts = [
  '', ' ', '-', '/', '\n', '\u0085', '\ufeff', '\u00a0', '\u2003', '\u2029',
  '\u200d', '\u200c', '\u200b', '\0', '.', '+', '#', '\u{1f642}',
  '_', 'a', '1', '\u0660', '\u2169', '\u4e2d', '\u0301', '\u20dd',
  '\u{1d167}', '\u{10400}', '\u{10940}', '\u{16ea0}', '\u{1e6c0}',
  '\u{11b60}', '\u{1fbf0}', '\u{e000}', '\u{10ffff}',
];

let seed = 0x789abc12;
function random(max: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % max;
}

for (const [literal, spelling] of literalAndSpelling) {
  const regex = literalExpression(literal);
  const print = (body: string) => {
    const match = regex.exec(body);
    console.log(JSON.stringify({
      literal, source: regex.source, body,
      span: match ? [match.index, match.index + match[0].length] : null,
    }));
  };
  for (const context of contexts) {
    print(`${context}${spelling}!`);
    print(`!${spelling}${context}`);
    print(`\u{1f642} ${context}${spelling}${context} / ${literal}!`);
  }
  for (let index = 0; index < 64; index += 1) {
    const prefix = contexts[random(contexts.length)];
    const middle = contexts[random(contexts.length)];
    const suffix = contexts[random(contexts.length)];
    print(`${prefix}${spelling}${middle}${literal}${suffix}`);
  }
}
