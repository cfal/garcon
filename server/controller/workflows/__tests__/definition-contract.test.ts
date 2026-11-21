import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  WORKFLOW_DEFINITION_LIMITS, editWorkflowDefinition, getWorkflowDefinitionFieldValue, getWorkflowStepSignal,
  parseWorkflowDefinition, parseWorkflowStepAddition, renderWorkflowPrompt,
  type WorkflowDefinition, type WorkflowDiagnosticCode, type WorkflowFieldPath,
} from '../../../../common/workflow-definition.js';
import { isRecord } from '../../../../common/json.js';
import { WORKFLOW_VALUE_BYTES } from '../../../../common/workflow-value.js';

const fixture = (name: string) => readFileSync(new URL(`../../../../common/workflow-definition/fixtures/${name}.workflow.yaml`, import.meta.url), 'utf8');
const recipe = fixture('research');

function validated(source = recipe): WorkflowDefinition {
  const { definition, diagnostics } = parseWorkflowDefinition(source);
  if (!definition) throw new Error(JSON.stringify(diagnostics));
  return definition;
}

function expectIssue(source: string, code: WorkflowDiagnosticCode, path?: WorkflowFieldPath) {
  const result = parseWorkflowDefinition(source);
  expect(result.definition).toBeNull();
  const issue = result.diagnostics.find((entry) => entry.code === code);
  expect(issue).toBeDefined();
  if (path) expect(result.diagnostics.filter((entry) => entry.code === code).map((entry) => entry.path)).toContainEqual(path);
}

describe('YAML v1 workflow definition', () => {
  test('loads the reference recipe with typed input, keyed delivery, join, and human decision', () => {
    const { version, inputs, steps } = validated();
    const [research, verify, summary, decide] = steps;
    expect(version).toBe(1);
    expect(inputs.topic).toEqual({ type: 'string', description: 'Subject for the exercise' });
    expect(steps.map((step) => step.id)).toEqual(['research', 'verify', 'summary', 'decide']);
    expect(getWorkflowStepSignal(research, 'finding_ready')).toEqual({
      payload: 'json', delivery: 'many', key: 'finding_id', fields: { finding_id: 'string', claim: 'string', evidence: 'string' },
    });
    expect(getWorkflowStepSignal(research, 'research_started')).toEqual({ payload: 'none', delivery: 'once' });
    expect(getWorkflowStepSignal(research, 'report_ready')).toEqual({ payload: 'text', delivery: 'once' });
    expect(verify.on).toEqual({ kind: 'each', signal: { stepId: 'research', signal: 'finding_ready' }, maxConcurrency: 2 });
    expect(summary).toMatchObject({
      on: { kind: 'all', close: { stepId: 'research', signal: 'turn_completed' }, steps: ['verify'] },
      bindings: { verifications: { kind: 'all', stepId: 'verify' } },
    });
    expect(decide).toMatchObject({ kind: 'decision', choices: { accept: 'Accept the report', stop: 'Stop without accepting' } });
    expect(getWorkflowStepSignal(decide, 'stop')).toEqual({ payload: 'none', delivery: 'once' });
    expect(getWorkflowStepSignal(decide, 'turn_completed')).toBeUndefined();
    expect(getWorkflowStepSignal(research, 'turn_completed')).toEqual({ payload: 'text', delivery: 'once' });
  });

  test('preserves New Chat choices without resolving executor-owned settings', () => {
    const source = recipe.replace('    permissionMode: default', `    permissionMode: plan
    thinkingMode: high
    executorId: ffffffff-ffff-4fff-8fff-ffffffffffff
    projectPath: /not-mounted/worktree
    apiProviderId: synthetic-provider
    modelEndpointId: synthetic-endpoint
    model: synthetic-model
    agentSettings: { ownerId: codex, schemaVersion: 1, values: { speed: fast } }
    orderedPreambleIds: []
    attachments: [{ path: ./prompt.md }]
    tags: [review-needed]`);
    const [research, verify] = validated(source).steps;
    expect(research).toMatchObject({
      executorId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', projectPath: '/not-mounted/worktree',
      apiProviderId: 'synthetic-provider', modelEndpointId: 'synthetic-endpoint', model: 'synthetic-model',
      agentSettings: { ownerId: 'codex', schemaVersion: 1, values: { speed: 'fast' } },
      permissionMode: 'plan', thinkingMode: 'high', orderedPreambleIds: [],
      attachments: [{ path: './prompt.md' }], tags: ['review-needed'],
    });
    expect(Object.hasOwn(verify, 'executorId')).toBe(false);
    expectIssue(source.replace('ownerId: codex', 'ownerId: pi'), 'invalid-value', ['steps', 0, 'agentSettings', 'ownerId']);
    expectIssue(source.replace('executorId: ffffffff-ffff-4fff-8fff-ffffffffffff', 'executorId: null'), 'invalid-type', ['steps', 0, 'executorId']);
  });

  test('accepts a literal command after a no-payload decision choice but rejects agent settings or custom emits on it', () => {
    const source = `${recipe}
  - id: record_stop
    kind: command
    shell: sh
    command: 'printf "%s" "{{unchanged}}"'
    on: { kind: once, signal: decide.stop }
`;
    const step = validated(source).steps.at(-1)!;
    expect(step).toMatchObject({ kind: 'command', command: 'printf "%s" "{{unchanged}}"' });
    expect(getWorkflowStepSignal(step, 'turn_completed')).toEqual({ payload: 'text', delivery: 'once' });
    expectIssue(`${source}    model: synthetic\n    signals: { false_success: {payload: none} }\n`, 'unknown-field', ['steps', 4, 'signals']);
  });

  test('preserves typed JSON, boolean, and numeric defaults and checks wrong defaults', () => {
    const source = recipe.replace('inputs:\n', `inputs:
  config: { type: json, default: { quoted: [1, true, null, yes] } }
  enabled: { type: boolean, default: false }
  count: { type: number, default: 0 }
  empty: { type: json, default: null }
`);
    const { inputs } = validated(source);
    expect(inputs.config.default).toEqual({ quoted: [1, true, null, 'yes'] });
    expect(inputs.enabled.default).toBe(false);
    expect(inputs.count.default).toBe(0);
    expect(inputs.empty.default).toBeNull();
    expectIssue(source.replace('default: false', 'default: "false"'), 'invalid-type', ['inputs', 'enabled', 'default']);
  });

  test('reports an exact source range and correction for a misspelled signal', () => {
    const source = fixture('invalid-signal');
    const { definition, diagnostics: [diagnostic] } = parseWorkflowDefinition(source);
    expect(definition).toBeNull();
    expect(diagnostic).toMatchObject({
      code: 'unknown-signal', stepId: 'verify', path: ['steps', 1, 'on', 'signal'],
      range: { start: { line: 19, column: 15 }, end: { line: 19, column: 36 } },
    });
    expect(diagnostic.message).toContain('Did you mean "research.finding_ready"?');
    expect(source.slice(diagnostic.range.start.offset, diagnostic.range.end.offset)).toBe('research.findng_ready');
  });

  test('rejects input defaults that exceed the encoded launch budget, including together', () => {
    const definition = (inputs: unknown) => JSON.stringify({ version: 1, name: 'Defaults', inputs,
      steps: [{ id: 'print', kind: 'command', command: 'pwd' }] });
    const size = WORKFLOW_VALUE_BYTES;
    const string = (value: string) => ({ type: 'string', default: value });
    const overhead = JSON.stringify({ a: '' }).length;
    expect(validated(definition({ a: string('x'.repeat(size - overhead)) })).inputs.a).toBeDefined();
    expectIssue(definition({ a: string('x'.repeat(size - overhead + 1)) }), 'invalid-value', ['inputs', 'a', 'default']);
    const each = string('\u00e9'.repeat(size / 4));
    expectIssue(definition({ a: each, b: each }), 'invalid-value', ['inputs']);
  });

  test('allows a decision group in a join but not as a source of final text, including run additions', () => {
    const group = 'version: 1\nname: Review\nsteps:\n'
      + '  - {id: research, kind: agent, prompt: Investigate, signals: {found: {delivery: many, payload: json, fields: {id: string}, key: id}}}\n'
      + '  - {id: review, kind: decision, prompt: Review, choices: {ok: Approve}, on: {kind: each, signal: research.found}}\n';
    const join = { id: 'summary', kind: 'agent', prompt: 'Summarize', on: { kind: 'all', close: 'research.turn_completed', steps: ['review'] } };
    const base = validated(group);
    expect(parseWorkflowStepAddition(base, JSON.stringify(join)).diagnostics).toEqual([]);
    const bound = { ...join, bindings: { reports: 'all.review' } };
    expectIssue(group + '  - ' + JSON.stringify(bound), 'invalid-binding', ['steps', 2, 'bindings', 'reports']);
    expect(parseWorkflowStepAddition(base, JSON.stringify(bound)).diagnostics).toMatchObject([
      { code: 'invalid-binding', path: ['bindings', 'reports'] },
    ]);
  });

  test('keeps sibling indentation across indented trailing comments on block edits', () => {
    for (const newline of ['\n', '\r\n']) {
      const source = ['version: 1', 'name: Indentation', 'steps:', '  - id: first', '    kind: decision',
        '    prompt: Pick', '    choices:', '      ok: Accept', '      # choice note', '    # first only',
        '  - id: second', '    kind: command', '    command: pwd', ''].join(newline);
      const first = source.indexOf('  - id: first');
      const second = source.indexOf('  - id: second');
      const removed = editWorkflowDefinition(source, [{ kind: 'delete', path: ['steps', 0] }]);
      expect(removed.diagnostics).toEqual([]);
      expect(removed.source).toBe(source.slice(0, first) + source.slice(second));
      const added = editWorkflowDefinition(source, [{ kind: 'upsert', path: ['steps', 0, 'name'], value: 'First' }]);
      expect(added.diagnostics).toEqual([]);
      expect(added.definition?.steps[0].name).toBe('First');
      expect(added.source.replace('    name: First' + newline, '')).toBe(source);
      const atEof = ['version: 1', 'name: Literal', 'steps:', '  - id: command', '    kind: command',
        '    command: |+', '      pwd', '         '].join(newline);
      const literal = editWorkflowDefinition(atEof, [{ kind: 'upsert', path: ['steps', 0, 'name'], value: 'Keep' }]);
      expect(literal.definition?.steps[0]).toEqual({ ...validated(atEof).steps[0], name: 'Keep' });
    }
  });

  test('rejects malformed syntax and non-data YAML before using it', () => {
    expectIssue('version: 1\nname: [broken\n', 'yaml-syntax');
    expectIssue(`%YAML 1.1\n---\n${recipe}`, 'yaml-subset');
    expectIssue(`${recipe}\n---\nname: another\n`, 'yaml-subset');
    expectIssue(`${recipe}\n'name': Repeated\n`, 'yaml-subset', ['name']);
    expectIssue(recipe.replace('Verify synthetic research', '&n Verify synthetic research\ndescription: *n'), 'yaml-subset', ['description']);
    expectIssue(recipe.replace('Verify synthetic research', '!side-effect Research'), 'yaml-subset', ['name']);
    expectIssue(recipe.replace('Verify synthetic research', '.inf'), 'yaml-subset', ['name']);
    expectIssue(recipe.replace('Verify synthetic research', '9007199254740993'), 'yaml-subset', ['name']);
    expectIssue(recipe.replace('inputs:\n', 'inputs:\n  1: {type: string}\n'), 'yaml-subset', ['inputs']);
    expect(validated(`%YAML 1.2\n---\n${recipe}`).version).toBe(1);
  });

  test('stops at bounded byte size, nesting, and steps', () => {
    expectIssue(`#${'\u00e9'.repeat(WORKFLOW_DEFINITION_LIMITS.sourceBytes / 2)}\n${recipe}`, 'source-limit');
    expectIssue(`version: 1\nname: ${'['.repeat(512)}deep${']'.repeat(512)}\n`, 'source-limit');
    const excess = Array.from({ length: WORKFLOW_DEFINITION_LIMITS.steps }, (_, index) => (
      `  - {id: extra_${index}, kind: command, command: 'printf example'}\n`
    )).join('');
    expectIssue(recipe + excess, 'invalid-value', ['steps']);
  });

  test('checks cycles, IDs, closure, many keys, and binding scope', () => {
    expectIssue(recipe.replace('id: decide', 'id: summary'), 'duplicate-id', ['steps', 3, 'id']);
    expectIssue(recipe.replace('    name: Research', '    name: Research\n    on: { kind: once, signal: summary.turn_completed }'), 'cycle');
    expectIssue(recipe.replace('close: research.turn_completed', 'close: research.report_ready'), 'invalid-subscription', ['steps', 2, 'on', 'close']);
    expectIssue(recipe.replace('steps: [verify]', 'steps: [verify, verify]'), 'invalid-subscription', ['steps', 2, 'on', 'steps', 1]);
    expectIssue(recipe.replace('key: finding_id', 'key: missing'), 'invalid-repeat-key', ['steps', 0, 'signals', 'finding_ready', 'key']);
    expectIssue(recipe.replace('finding_id: string', 'finding_id: number'), 'invalid-repeat-key');
    expectIssue(recipe.replace('maxConcurrency: 2', 'maxConcurrency: 5'), 'invalid-type', ['steps', 1, 'on', 'maxConcurrency']);
    expectIssue(recipe.replace('signal: research.finding_ready', 'signal: research.report_ready'), 'invalid-subscription');
    expectIssue(recipe.replace('research_started: { payload: none }', 'turn_completed: { payload: none }'), 'invalid-value');
    expectIssue(recipe.replace('claim: signal.claim', 'claim: signal.undeclared'), 'invalid-binding', ['steps', 1, 'bindings', 'claim']);
    expectIssue(recipe.replace('verifications: all.verify', 'verifications: all.research'), 'invalid-binding', ['steps', 2, 'bindings', 'verifications']);
    expectIssue(recipe.replace('topic: inputs.topic', 'topic: inputs.secret'), 'invalid-binding', ['steps', 0, 'bindings', 'topic']);
    expectIssue(recipe.replace('{{topic}}', '{{unbound}}'), 'invalid-binding', ['steps', 0, 'prompt']);
  });

  test('substitutes named values only and renders arguments as data', () => {
    expect(renderWorkflowPrompt('{{ topic }} {{report}} {{process.exit(0)}}', {
      topic: '$& {{report}}', report: [false, { score: 2 }],
    })).toBe('$& {{report}} [false,{"score":2}] {{process.exit(0)}}');
    expect(() => renderWorkflowPrompt('{{constructor}}', {})).toThrow('Missing workflow prompt binding');
  });
});

describe('workflow step addition', () => {
  const base = validated();
  const fragment = `id: second_opinion
kind: agent
prompt: Review {{report}}
bindings: {report: signal}
`;

  test('validates against the effective definition, with ranges local to the fragment', () => {
    const before = structuredClone(base);
    const accepted = parseWorkflowStepAddition(base, `${fragment}on: { kind: once, signal: summary.turn_completed }\n`);
    expect(accepted.diagnostics).toEqual([]);
    expect(accepted.step).toMatchObject({ kind: 'agent', id: 'second_opinion' });
    const bad = `${fragment}on: { kind: once, signal: second_opinion.turn_completed }\n`;
    const { step, diagnostics: [diagnostic] } = parseWorkflowStepAddition(base, bad);
    expect(step).toBeNull();
    expect(diagnostic).toMatchObject({ code: 'unknown-step', stepId: 'second_opinion', path: ['on', 'signal'],
      range: { start: { line: 5, column: 27 } } });
    expect(bad.slice(diagnostic.range.start.offset, diagnostic.range.end.offset)).toBe('second_opinion.turn_completed');
    expect(parseWorkflowStepAddition(base, fragment.replace('second_opinion', 'verify')).diagnostics[0].code).toBe('duplicate-id');
    expect(base).toEqual(before);
  });

  test('binds an explicitly selected stored occurrence only on a root addition', () => {
    const completed = { evidence: { stepId: 'verify', signal: 'turn_completed' } };
    expect(parseWorkflowStepAddition(base, fragment).step).toBeNull();
    const added = parseWorkflowStepAddition(base, fragment, completed);
    expect(added.diagnostics).toEqual([]);
    expect(added.step?.on).toBeUndefined();
    expect(parseWorkflowStepAddition(base, `${fragment}on: { kind: once, signal: summary.turn_completed }\n`, completed).diagnostics[0])
      .toMatchObject({ code: 'invalid-subscription', path: ['on'] });
    const selected = { evidence: { stepId: 'research', signal: 'finding_ready' } };
    expect(parseWorkflowStepAddition(base, fragment.replace('report: signal', 'report: signal.claim'), selected).diagnostics).toEqual([]);
    expect(parseWorkflowStepAddition(base, fragment.replace('report: signal', 'report: signal.undeclared'), selected).diagnostics[0])
      .toMatchObject({ code: 'invalid-binding', path: ['bindings', 'report'] });
    expect(parseWorkflowStepAddition(base, fragment, { evidence: { stepId: 'research', signal: 'research_started' } }).step).toBeNull();
  });
});

describe('source-preserving workflow edits', () => {
  test('keeps untouched text, field order, line endings, and inline comments', () => {
    const source = recipe.replace('Verify synthetic research', 'Verify synthetic research   # Keep this').replaceAll('\n', '\r\n');
    const edited = editWorkflowDefinition(source, [{ path: ['name'], value: 'Name: changed' }]);
    expect(edited.definition?.name).toBe('Name: changed');
    expect(edited.source).toBe(source.replace('Verify synthetic research', '"Name: changed"'));
  });

  test('does not change an invalid source or apply an invalid candidate', () => {
    const invalid = fixture('invalid-signal');
    expect(editWorkflowDefinition(invalid, [{ path: ['name'], value: 'Draft' }]).source).toBe(invalid);
    const rejected = editWorkflowDefinition(recipe, [{ path: ['steps', 0, 'id'], value: 'renamed' }]);
    expect(rejected.definition).toBeNull();
    expect(rejected.source).toBe(recipe);
    expect(rejected.attemptedSource).toContain('id: "renamed"');
    expect(rejected.diagnostics.some((diagnostic) => diagnostic.code === 'unknown-step')).toBe(true);
  });

  test('inserts a duplicate and connects it to the join atomically, without reformatting existing steps', () => {
    const source = recipe.replace('  - id: summary', '  # Keep this with the summary.\n  - id: summary');
    const original = getWorkflowDefinitionFieldValue(source, ['steps', 1]);
    if (!isRecord(original)) throw new Error('Expected a raw YAML mapping');
    expect(original.on).toMatchObject({ signal: 'research.finding_ready' });
    const edited = editWorkflowDefinition(source, [
      { kind: 'insert', path: ['steps'], index: 2, value: { ...original, id: 'verify_again', name: 'Second verifier' } },
      { kind: 'append', path: ['steps', 3, 'on', 'steps'], value: 'verify_again' },
    ]);
    expect(edited.diagnostics).toEqual([]);
    expect(edited.definition?.steps.map(({ id }) => id)).toEqual(['research', 'verify', 'verify_again', 'summary', 'decide']);
    expect(edited.definition?.steps[3].on).toMatchObject({ steps: ['verify', 'verify_again'] });
    const addedStart = edited.source.indexOf('  - id: verify_again');
    const addedEnd = edited.source.indexOf('\n\n  # Keep this with the summary.', addedStart);
    expect(addedStart).toBeGreaterThan(0);
    expect(addedEnd).toBeGreaterThan(addedStart);
    expect((edited.source.slice(0, addedStart) + edited.source.slice(addedEnd + 1)).replace(', "verify_again"', '')).toBe(source);

    const removed = editWorkflowDefinition(edited.source, [
      { kind: 'delete', path: ['steps', 2] },
      { kind: 'delete', path: ['steps', 2, 'on', 'steps', 1] },
    ]);
    expect(removed.diagnostics).toEqual([]);
    expect(removed.source).toBe(source);
  });

  test('upserts absent settings in a CRLF block mapping without rewriting its prompt or comments', () => {
    const source = recipe.replace('    prompt: |', '    prompt: | # Preserve this header').replaceAll('\n', '\r\n');
    const edited = editWorkflowDefinition(source, [
      { kind: 'upsert', path: ['steps', 0, 'thinkingMode'], value: 'high' },
      { kind: 'upsert', path: ['steps', 0, 'orderedPreambleIds'], value: [] },
    ]);
    expect(edited.diagnostics).toEqual([]);
    expect(edited.definition?.steps[0]).toMatchObject({ thinkingMode: 'high', orderedPreambleIds: [] });
    expect(edited.source.replace('    thinkingMode: high\r\n    orderedPreambleIds: []\r\n', '')).toBe(source);
  });

  test('preserves the literal style and CRLF when updating a multiline prompt', () => {
    const source = `version: 1
name: Literal prompt
steps:
  - id: decide
    kind: decision
    prompt: | # Keep the header
      Proceed?
    choices: {stop: Stop}
`.replaceAll('\n', '\r\n');
    const edited = editWorkflowDefinition(source, [{ kind: 'upsert', path: ['steps', 0, 'prompt'], value: 'New line\nAnother line\n' }]);
    expect(edited.diagnostics).toEqual([]);
    expect(edited.source).toBe(source.replace('      Proceed?\r\n', '      New line\r\n      Another line\r\n'));
    expect(edited.definition?.steps[0]).toMatchObject({ prompt: 'New line\nAnother line\n' });
  });

  test('removes an inline first block key and leaves an empty mapping when its last entry is removed', () => {
    const source = `version: 1
name: Remove settings
inputs: {subject: {type: string}}
steps:
  - name: Optional name
    id: decide
    kind: decision
    prompt: Proceed?
    choices: {stop: Stop}
    bindings: # Keep this comment
      topic: inputs.subject
`;
    const edited = editWorkflowDefinition(source, [
      { kind: 'delete', path: ['steps', 0, 'name'] },
      { kind: 'delete', path: ['steps', 0, 'bindings', 'topic'] },
    ]);
    expect(edited.diagnostics).toEqual([]);
    expect(edited.source).toBe(source.replace('name: Optional name', '').replace('topic: inputs.subject', '{}'));
    expect(edited.definition?.steps[0]).toMatchObject({ id: 'decide', bindings: {} });
  });

  test('appends and removes a step in a multiline flow list without dropping comments', () => {
    const source = `# Workflow header
version: 1
name: Flow
steps: [
  {id: one, kind: command, command: 'printf example'} # Keep original
] # Keep the list
`;
    const edited = editWorkflowDefinition(source, [
      { kind: 'append', path: ['steps'], value: { id: 'two', kind: 'command', command: 'printf next' } },
      { kind: 'upsert', path: ['steps', 1, 'shell'], value: 'sh' },
    ]);
    expect(edited.diagnostics).toEqual([]);
    expect(edited.definition?.steps[1]).toMatchObject({ id: 'two', shell: 'sh' });
    expect(edited.source).toContain(`{id: one, kind: command, command: 'printf example'}, # Keep original`);
    expect(edited.source).toContain('] # Keep the list');
    const removed = editWorkflowDefinition(edited.source, [{ kind: 'delete', path: ['steps', 1] }]);
    expect(removed.diagnostics).toEqual([]);
    expect(removed.source).toContain(`{id: one, kind: command, command: 'printf example'} # Keep original`);
    expect(removed.definition?.steps).toEqual(validated(source).steps);
  });

  test('rolls back every operation when a later edit fails', () => {
    const edited = editWorkflowDefinition(recipe, [
      { kind: 'upsert', path: ['name'], value: 'New title' },
      { kind: 'delete', path: ['steps', 2, 'missing'] },
    ]);
    expect(edited.definition).toBeNull();
    expect(edited.source).toBe(recipe);
    expect(edited.attemptedSource).toContain('"New title"');
    expect(edited.diagnostics[0]).toMatchObject({ code: 'invalid-edit', path: ['steps', 2, 'missing'] });
  });
});
