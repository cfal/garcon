import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { commonTrailingPseudos } = require(join(dirname(require.resolve('@tailwindcss/typography')), 'utils.js'));

test.each([
  ['h1, h2', [null, 'h1, h2']],
  ['ol > li::marker, ul > li::marker', ['::marker', 'ol > li, ul > li']],
  ['a::before::marker, span::before::marker', ['::before::marker', 'a, span']],
  ['a::before, a::after', [null, 'a::before, a::after']],
  [':is(h1, h2) > a::before', ['::before', ':is(h1, h2) > a']],
])('typography preserves trailing-pseudo extraction for %s', (selector, expected) => {
  expect(commonTrailingPseudos(selector)).toEqual(expected);
});
