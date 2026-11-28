import { estimateHandoffTokens } from '../../../../server/controller/chats/token-fitting/budget.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);
const pkg = await Bun.file(new URL('../../../../server/node_modules/tokenx/package.json', import.meta.url)).json();
if (pkg.version !== '2.1.1') throw new Error(`Expected tokenx 2.1.1, got ${pkg.version}`);

const corpus = new Set([
  '', ' ', '\t', '\r', '\n', '\r\n', '\n ', '.\n', '.\n ', 'a\n', 'a\r', 'a\r\n',
  'x\r\ny', 'x\u2028y', 'x\u2029y', '\ufeff', '\u0085', '\u200b', '\u00a0\u2001',
  'abcdefghi', 'ABCDEFGH', '1234567', '!!!!!!!!!!', 'xyz12abc', '1234.0123',
  'A_8___A', '"a" @b.#c', '\ud800', '\udfff', 'x\ud800xy', 'x\udfffxy',
  '\u00e9abcdefghi', '\u00e4\u00e9abcdefghi', '\u4f60\u597dabc', '\u3042\u30a2\uac00',
  '\u{1f469}\u200d\u{1f4bb}', 'a\u{1f60a}b', '\u{20bb7}', '\u{20bb7}\u6f22',
  '\u{1f1fa}\u{1f1f8}', '\u{1f44d}\u{1f3fd}', '\u2764\ufe0f', '1\ufe0f\u20e3',
  '\u212a', '\u0130\u0131', '\u017f', '\u00df\u1e9e', '\u03a3\u03c3\u03c2',
]);

const contexts = ['', 'abcdefghijklm', 'ABCDEF0123456', '\u00e4', '\u00e9', '\u010d', '\u0416',
  '\u0398', '\u304b', '\u30b7', '\uac00', '\u6771', '\u{1f469}\u200d', '\u200d\u{1f4bb}'];
const representatives: string[] = [];
for (const [first, last, stride] of [
  [0, 0x024f, 1], [0x0300, 0x052f, 1], [0x1100, 0x11ff, 5], [0x1e00, 0x1fff, 2],
  [0x2000, 0x20ff, 1], [0x2300, 0x27ff, 7], [0x2e80, 0x33ff, 5], [0x3400, 0x4dff, 67],
  [0x4e00, 0x9fff, 113], [0xa960, 0xa97f, 1], [0xac00, 0xd7ff, 101],
  [0xf900, 0xfaff, 11], [0xfe00, 0xfe0f, 1], [0xff00, 0xffef, 7],
  [0x1f000, 0x1faff, 17], [0x20000, 0x2a6df, 1079], [0xe0020, 0xe007f, 3],
]) {
  for (let code = first; code <= last; code += stride) {
    const character = String.fromCodePoint(code);
    representatives.push(character);
    corpus.add(character);
    corpus.add(`Abcdef${character}ghijkl`);
    corpus.add(`${character.repeat(9)}\n`);
  }
}

let seed = 0xace07ed;
function next(n: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed >>> 8) % n;
}

const delimiters = ['', '', ' ', ' \n', '\n\r', '\t\n ', '\ufeff', '\u00a0', '.!/(,)', '\\[]{}<>'];
for (let iteration = 0; iteration < 8192; iteration++) {
  let text = contexts[next(contexts.length)];
  const count = 1 + next(14);
  for (let index = 0; index < count; index++) {
    text += representatives[next(representatives.length)] + delimiters[next(delimiters.length)];
  }
  corpus.add(text + contexts[next(contexts.length)]);
}

const cases = Array.from(corpus, (text) => [
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)),
  estimateHandoffTokens(text),
]);
process.stdout.write(process.argv.includes('--summary') ? `${cases.length} tokenx checks\n` : JSON.stringify(cases));
