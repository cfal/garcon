import { afterAll, beforeAll } from 'bun:test';

const RealDate = Date;
const fixtureTime = RealDate.parse('2026-11-02T00:00:00.000Z');
beforeAll(() => {
  globalThis.Date = class extends RealDate {
    constructor(...args: [] | [string | number | Date]) {
      super(args.length ? args[0] : fixtureTime);
    }
    static now(): number {
      return fixtureTime;
    }
  } as typeof Date;
});
afterAll(() => {
  globalThis.Date = RealDate;
});

await import('../../../../server-agents/codex/src/agents/codex/__tests__/user-input.test.ts');
