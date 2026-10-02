import { expect, test } from 'bun:test';
import { parseArgs } from 'node:util';
import { EXECUTOR_PARSE_OPTIONS, parseExecutorCliCommand } from '../executor-args.js';
import { TICKET_PARSE_OPTIONS, parseTicketCliCommand } from '../ticket-args.js';

const connection = { runtime: 'controller' as const, configDir: '/config' };

test('executor options parse without the ticket option table', () => {
  const parse = (args: string[]) => {
    const { values, positionals } = parseArgs({ args, options: EXECUTOR_PARSE_OPTIONS, allowPositionals: true, strict: true });
    return parseExecutorCliCommand(positionals, values, connection, '/workspace');
  };
  expect(parse(['executor', 'create', '--label', 'Worker', '--direction', 'executor-connects']).operation)
    .toMatchObject({ action: 'create', request: { label: 'Worker' } });
  expect(parse(['executor', 'wait', 'local', '--ready']).operation).toMatchObject({ action: 'wait', id: 'local' });
  expect(() => parse(['executor', 'create', '--label', 'One', '--label', 'Two', '--direction', 'executor-connects']))
    .toThrow('may be used only once');
});

test('ticket options own title, cwd, labels and ready without the top-level table', () => {
  const parse = (args: string[]) => {
    const { values, positionals } = parseArgs({ args, options: TICKET_PARSE_OPTIONS, allowPositionals: true, strict: true });
    return parseTicketCliCommand(positionals, values, connection, '/workspace');
  };
  expect(parse(['ticket', 'create', '--title', 'Synthetic', '--cwd', '/project', '--label', 'one', '--label', 'two']))
    .toMatchObject({ cwd: '/project', operation: { action: 'create', input: { title: 'Synthetic', labels: ['one', 'two'] } } });
  expect(parse(['ticket', 'list', '--ready']).operation).toMatchObject({ action: 'list', query: { ready: true } });
});
