import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  WORKFLOW_DEFINITION_LIMITS, editWorkflowDefinition, getWorkflowStepSignal,
  parseWorkflowDefinition, parseWorkflowStepAddition, renderWorkflowPrompt,
  type WorkflowDefinition, type WorkflowDiagnosticCode, type WorkflowFieldPath,
} from '../workflow-definition.js';

const fixture = (name: string) => readFileSync(new URL(`../workflow-definition/fixtures/${name}.workflow.yaml`, import.meta.url), 'utf8');
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
});
