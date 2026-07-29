import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

// Chat busy-ness has exactly two public questions, and this pins them so a third cannot be added
// quietly. Four features once each invented their own subset of execution state, the subsets were
// not nested, and the fork and reload guards ended up disagreeing about the same instant. If this
// test fails, consume ownsExecution or the processing projection rather than widening the surface;
// see the ExecutionOwnership module documentation and the AGENTS.md rule.
const ALLOWED_EXECUTION_PREDICATES = [
  'ownsExecution',
  'isChatTurnReserved',
  'isChatStopInFlight',
];

function predicatesIn(source, interfaceName) {
  const body = source.split(`export interface ${interfaceName} {`)[1]?.split('\n}')[0];
  if (body === undefined) throw new Error(`${interfaceName} not found`);
  return [...body.matchAll(/^\s{2}(\w+)\(chatId: string\): boolean;$/gm)].map((match) => match[1]);
}

describe('chat execution predicate surface', () => {
  const source = readFileSync('server/chat-execution/types.ts', 'utf8');

  it('exposes only the sanctioned busy questions', () => {
    for (const facet of ['ChatExecutionCommands', 'ChatExecutionQueries']) {
      for (const predicate of predicatesIn(source, facet)) {
        expect(
          ALLOWED_EXECUTION_PREDICATES,
          `${facet}.${predicate} is a new chat busy-ness predicate`,
        ).toContain(predicate);
      }
    }
  });

  it('keeps ownsExecution reachable from both facets', () => {
    expect(predicatesIn(source, 'ChatExecutionCommands')).toContain('ownsExecution');
    expect(predicatesIn(source, 'ChatExecutionQueries')).toContain('ownsExecution');
  });

  it('keeps the ownership union defined in exactly one place', () => {
    const coordinator = readFileSync(
      'server/chat-execution/chat-execution-coordinator.ts',
      'utf8',
    );
    const inlineUnions = coordinator.match(/hasOwner\([^)]*\)\s*\|\|\s*this\.#turnRunner\.isChatRunning/g);
    expect(inlineUnions ?? []).toHaveLength(1);
  });
});
