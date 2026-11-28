import { describe, test } from 'bun:test';
import { ClientTrace, installTraceTestContext } from '../../trace-sink.js';

await installTraceTestContext();

function record() {
  new ClientTrace(process.env.GARCON_TEST_TRACE_DIR!, 'http://127.0.0.1:4099', null, (value) => value)
    .receive({ type: 'sample' });
}

describe.if(true)('if', () => test('same', record));
describe.todoIf(false)('todoIf', () => test('same', record));
describe.each([['first'], ['second']])('row %s', () => {
  describe.skipIf(false)('skipIf', () => test('same', record));
});
