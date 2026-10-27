import { describe, expect, it } from 'bun:test';
import {
  validateRepositoryTranscriptConformanceInventory,
  validateTranscriptConformanceInventory,
} from '../validate-transcript-ledger-v5-cases.js';

function testSource(id, title) {
  return `it('[${id}] ${title}', () => {});`;
}

describe('Transcript Ledger V5 case inventory', () => {
  it('accepts one source occurrence for every sorted inventory ID', () => {
    const result = validateTranscriptConformanceInventory(
      'TLV5-L02.01-STORE-UNIT-01\nTLV5-L03.01-CORE-UNIT-01\n',
      [
        {
          path: 'first.test.js',
          contents: testSource('TLV5-L02.01-STORE-UNIT-01', 'commits rows'),
        },
        {
          path: 'second.test.ts',
          contents: testSource('TLV5-L03.01-CORE-UNIT-01', 'publishes after commit'),
        },
      ],
    );

    expect(result).toEqual({
      cases: [
        { id: 'TLV5-L02.01-STORE-UNIT-01', location: 'first.test.js:1' },
        { id: 'TLV5-L03.01-CORE-UNIT-01', location: 'second.test.ts:1' },
      ],
      errors: [],
    });
  });

  it('rejects unsorted, duplicate, missing, repeated, and unregistered IDs', () => {
    const result = validateTranscriptConformanceInventory(
      [
        'TLV5-L03.01-CORE-UNIT-01',
        'TLV5-L02.01-STORE-UNIT-01',
        'TLV5-L02.01-STORE-UNIT-01',
        'TLV5-L04.01-CORE-UNIT-01',
        '',
      ].join('\n'),
      [
        {
          path: 'cases.test.js',
          contents: [
            testSource('TLV5-L02.01-STORE-UNIT-01', 'first'),
            testSource('TLV5-L02.01-STORE-UNIT-01', 'duplicate'),
            testSource('TLV5-L05.01-CORE-UNIT-01', 'unregistered'),
          ].join('\n'),
        },
      ],
    );

    expect(result.errors).toEqual([
      'Inventory case IDs must be unique',
      'Inventory case IDs must be sorted',
      'Missing test case: TLV5-L03.01-CORE-UNIT-01',
      'Duplicate test case TLV5-L02.01-STORE-UNIT-01: cases.test.js:1, cases.test.js:2',
      'Missing test case: TLV5-L04.01-CORE-UNIT-01',
      'Unregistered test case TLV5-L05.01-CORE-UNIT-01: cases.test.js:3',
    ]);
  });

  it('validates the repository inventory', () => {
    expect(validateRepositoryTranscriptConformanceInventory().errors).toEqual([]);
  }, 30_000);

  it.each([
    '// it("[TLV5-SYNTHETIC-01] commented", () => {});',
    '/* test("[TLV5-SYNTHETIC-01] commented", () => {}); */',
    'const unused = "[TLV5-SYNTHETIC-01]";',
    'function unused() { test("[TLV5-SYNTHETIC-01] unregistered", () => {}); }',
    'const unused = () => test("[TLV5-SYNTHETIC-01] unregistered", () => {});',
    'const unused = function() { test("[TLV5-SYNTHETIC-01] unregistered", () => {}); };',
    'describe("suite", () => { function unused() { test("[TLV5-SYNTHETIC-01] unregistered", () => {}); } });',
    'beforeAll(() => { test("[TLV5-SYNTHETIC-01] not registration scope", () => {}); });',
    'const suite = describe.skip; suite("skipped", () => { test("[TLV5-SYNTHETIC-01] unregistered", () => {}); });',
    'const suite = false ? describe : describe.skip; suite("skipped", () => { test("[TLV5-SYNTHETIC-01] unregistered", () => {}); });',
    'describe("[TLV5-SYNTHETIC-01] empty", () => {});',
    'describe("[TLV5-SYNTHETIC-01] empty", () => { it.skip("skipped", () => {}); });',
    'it.skip("[TLV5-SYNTHETIC-01] skipped", () => {});',
    'test.todo("[TLV5-SYNTHETIC-01] pending");',
    'test.failing("[TLV5-SYNTHETIC-01] inverted", () => {});',
    'test.only("[TLV5-SYNTHETIC-01] focused", () => {});',
    'test.each([])("[TLV5-SYNTHETIC-01] empty table", () => {});',
    ...['([])', '[] as const', '[] satisfies readonly unknown[]'].flatMap(table => [
      `test.each(${table})("[TLV5-SYNTHETIC-01] empty table", () => {});`,
      `for (const row of ${table}) { test("[TLV5-SYNTHETIC-01] empty loop", () => {}); }`,
    ]),
    'for (const item of []) { test("[TLV5-SYNTHETIC-01] empty loop", () => {}); }',
    'test.notARegistration("[TLV5-SYNTHETIC-01] unrelated method", () => {});',
    'test.skipIf(true)("[TLV5-SYNTHETIC-01] skipped", () => {});',
    'test.runIf(false)("[TLV5-SYNTHETIC-01] skipped", () => {});',
    'describe.skip("suite", () => { it("[TLV5-SYNTHETIC-01] nested", () => {}); });',
    'describe.skip.each([1])("suite %s", () => { it("[TLV5-SYNTHETIC-01] nested", () => {}); });',
    'if (false) { test("[TLV5-SYNTHETIC-01] unreachable", () => {}); }',
    'const cases = [{ caseId: "[TLV5-SYNTHETIC-01]" }]; for (const row of cases) { test.skip(`${row.caseId} skipped`, () => {}); }',
    'const cases = [{ caseId: "[TLV5-SYNTHETIC-01]" }]; // test(cases[0].caseId, () => {});',
    'const suite = process.platform === "linux" ? describe : describe.skip; suite("unsupported alias", () => { test("[TLV5-SYNTHETIC-01] registered", () => {}); });',
    'const id = flag ? "[TLV5-SYNTHETIC-01]" : ""; test(`${id} computed title`, () => {});',
    'test("[TLV5-SYNTHETIC-01]" + " computed title", () => {});',
  ])('does not count a suppressed or non-test occurrence: %s', contents => {
    expect(validateTranscriptConformanceInventory('TLV5-SYNTHETIC-01\n', [{ path: 'case.test.ts', contents }]).errors)
      .toEqual(['Missing test case: TLV5-SYNTHETIC-01']);
  });

  it.each([
    'test(`[TLV5-SYNTHETIC-01] ${"template title"}`, () => {});',
    'const id = "[TLV5-SYNTHETIC-01]"; it(`${id} title`, () => {});',
    'for (const row of [{ caseId: "[TLV5-SYNTHETIC-01]" }] as const) { test(`${row.caseId} title`, () => {}); }',
    'const cases = [{ caseId: "[TLV5-SYNTHETIC-01]" }] as const; for (const { caseId } of cases) { test(`${caseId} title`, () => {}); }',
    'test.each([1, 2])("[TLV5-SYNTHETIC-01] case %s", () => {});',
    'describe("[TLV5-SYNTHETIC-01] suite", () => { it("runs", () => {}); });',
    'describe.skipIf(process.platform !== "linux")("platform suite", () => { test("[TLV5-SYNTHETIC-01] registered", () => {}); });',
    'test.skipIf(process.platform === "win32")("[TLV5-SYNTHETIC-01] conditional", () => {});',
  ])('resolves registered static and table-driven titles: %s', contents => {
    expect(validateTranscriptConformanceInventory('TLV5-SYNTHETIC-01\n', [{ path: 'case.test.ts', contents }]).errors)
      .toEqual([]);
  });
});
