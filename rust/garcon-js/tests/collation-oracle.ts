if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const numeric = { numeric: true, sensitivity: 'base' } as const;
const english = new Intl.Collator('en', numeric);
const sign = Math.sign;
const probe = process.argv.includes('--locale');
if (probe) {
  console.log(JSON.stringify({
    locale: new Intl.Collator().resolvedOptions().locale,
    comparisons: [['\u00e4', 'z'], ['A', 'a'], ['file02', 'file2'], ['\u00e9', 'e\u0301']].map(([a, b]) => sign(a.localeCompare(b))),
    icu: process.versions.icu,
    cldr: process.versions.cldr,
    unicode: process.versions.unicode,
  }));
} else {
  const ascii = Array.from({ length: 26 }, (_, n) => String.fromCharCode(97 + n));
  const numbers = ['0', '1', '2', '3', '9', '10', '12', '20', '99', '100', '001', '00002', '009', '200', '\u0662', '\u06f0\u06f2', '\uff11\uff10', '\u0967\u0966', '\u0e50\u0e52', '0'.repeat(300) + '2', '9'.repeat(254), '9'.repeat(255), '1' + '0'.repeat(256)];
  const words = [
    '', '.', '..', './a', 'A.txt', 'a.txt', 'a/b', 'a\\b', 'a:b', 'Aa', 'aa', 'aaa',
    ' ', '  ', '\t', '\n', '\r\n', '\u00a0', '\u2003', 'a b', 'a\u00a0b', 'a\u2003b',
    '_', '-', '\u2010', '\u2014', '/', '\\', ',', ':', ';', '!', '?', '"', "'", '@', '#', '$', '+', '=', '~', '|', '(', ')', '[', ']', '{', '}',
    '\0', '\u00ad', '\u034f', '\u200b', '\u200d', '\ufeff', 'a\0b', 'a\u00adb', 'a\u034fb', 'a\u200bb', 'a\u200db', '\ufeffab',
    '\u00e9', 'e\u0301', '\u00c9', 'E\u0301', '\u00e8', '\u00ea', '\u00e4', 'a\u0308', '\u00e5', 'a\u030a', '\u212b', '\u00f1', 'n\u0303',
    '\u00f6', '\u00f8', '\u00df', 'ss', '\u1e9e', '\u00e6', 'ae', '\u0153', 'oe', '\u0130', '\u0131', '\u212a', 'e\u0327\u0301', 'e\u0301\u0327',
    '\u4e00', '\u4e2d', '\u4e2d\u6587', '\u56fd', '\u570b', '\u9fa5', '\u{20000}', '\uf900', '\u8c48',
    '\u3042', '\u3041', '\u30a2', '\uff71', '\u304b', '\u304c', '\u304b\u3099', '\u30ac', '\u30ab\u3099', '\u30ab', '\uff76',
    '\uac00', '\u1100\u1161', '\uac01', '\u1100\u1161\u11a8', '\ub2e4', '\ud55c',
    '\u2764', '\u2764\ufe0e', '\u2764\ufe0f', '\u{1f600}', '\u{1f603}', '\u{1f9d1}', '\u{1f469}', '\u{1f469}\u200d\u{1f4bb}',
    '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}', '\u{1f1fa}\u{1f1f8}', '\u{1f44d}', '\u{1f44d}\u{1f3fd}',
    '\ufffd', 'a\ufffd', '\ufffda', '\u{1f600}\ufffd', '\u0378', '\u{10ffff}',
  ];
  const hanSamples = [
    0x4e00, 0x4e01, 0x4e2d, 0x6c34, 0x8c48, 0x9f8d, 0x9fa5,
    0x3400, 0x3401, 0x3b00, 0x4db5,
    0x20000, 0x20001, 0x20509, 0x20b9f, 0x2a6d6,
    0x9fa6, 0x9fa7, 0x9fbb, 0x9fff,
    0xf900, 0xf901, 0xfa0e, 0x2f800,
  ].map(cp => String.fromCodePoint(cp));
  const strings = [...new Set([
    ...ascii, ...ascii.map(value => value.toUpperCase()), ...words, ...hanSamples,
    ...numbers, ...numbers.map(number => `file${number}.txt`),
    ...['eclair', '\u00e9clair', '\u4e2d', '\uac00', '\u{1f600}', 'A-b', 'a b'].flatMap(prefix => ['2', '10', '02'].map(number => prefix + number)),
    ...[...hanSamples, '\u3042', '\uac00', 'a', '2'].map(value => `prefix-${value}`),
  ])];
  const han = [...new Set(strings.flatMap(string => [...string]))].filter(char => (
    /^\p{Script=Han}$/u.test(char) && /^\p{Ideographic}$/u.test(char)
  ));
  const pairs: [number, number, number, number][] = [];
  for (let i = 0; i < strings.length; i++) {
    for (let j = i; j < strings.length; j++) {
      const [a, b] = [strings[i], strings[j]];
      const standard = sign(a.localeCompare(b));
      const base = sign(english.compare(a, b));
      if (standard !== sign(a.localeCompare(b, 'en')) || base !== sign(a.localeCompare(b, undefined, numeric))) {
        throw new Error(`Bun locale forms differ for ${JSON.stringify([a, b])}`);
      }
      pairs.push([i, j, standard, base]);
    }
  }
  // Rust only receives the well-formed projection of a JS surrogate string.
  const malformed = ['\ud800', 'a\udfff', '\udc00a', '\ud83d\ude00\ud800'].map(text => {
    const projected = text.toWellFormed();
    return [JSON.stringify(text), projected, sign(projected.localeCompare('a')), sign(english.compare(projected, 'a'))];
  });
  console.log(JSON.stringify({ strings, pairs, malformed, han }));
}
