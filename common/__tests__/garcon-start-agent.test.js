import { describe, expect, it } from 'bun:test';
import { parseGarconStartAgent, GARCON_START_PROMPT_MAX_BYTES } from '../garcon-start-agent.ts';

const start = (attributes = 'agent="codex" model="example-model"', body = 'Inspect the parser.') =>
  `<garcon-start-agent ref="task" ${attributes}>\n${body}\n</garcon-start-agent>`;

describe('single-child start grammar', () => {
  it('preserves explicit target selection and decoded prompt text', () => {
    expect(parseGarconStartAgent(start())).toEqual({
      type: 'start-agent', ref: 'task', async: false, fork: false, title: null, agentId: 'codex', model: 'example-model',
      providerId: null, reasoningEffort: null, prompt: 'Inspect the parser.',
    });
    expect(parseGarconStartAgent(start('model="example-model" reasoning-effort="low" provider="example" agent="codex"',
      '\n  A &amp; B &lt; C &gt; D &quot;quote&quot; &apos;x&apos; &amp;lt;  \n'))).toMatchObject({
      providerId: 'example', reasoningEffort: 'low', prompt: '\n  A & B < C > D "quote" \'x\' &lt;  \n',
    });
  });

  it.each([
    ['', null, null, null],
    ['model="example-model"', null, null, 'example-model'],
    ['provider="example" model="example-model"', null, 'example', 'example-model'],
    ['agent="example-agent" model="example-model"', 'example-agent', null, 'example-model'],
    ['agent="example-agent" provider="example" model="example-model"', 'example-agent', 'example', 'example-model'],
  ])('accepts the selection shape %s without filling in omitted values', (attributes, agentId, providerId, model) => {
    expect(parseGarconStartAgent(start(attributes))).toMatchObject({ agentId, providerId, model });
  });

  it.each(['agent="example-agent"', 'provider="example"', 'agent="example-agent" provider="example"'])
  ('requires a model when selecting %s', (attributes) => {
    expect(parseGarconStartAgent(start(attributes))).toBeNull();
  });

  it.each(['agent', 'provider', 'model'])('rejects an explicitly empty %s', (attribute) => {
    for (const value of ['', ' ']) expect(parseGarconStartAgent(start(`${attribute}="${value}"`))).toBeNull();
  });

  it('allows a reasoning override without overriding the inherited selection', () => {
    expect(parseGarconStartAgent(start('reasoning-effort="low"'))).toMatchObject({
      agentId: null, providerId: null, model: null, reasoningEffort: 'low',
    });
  });

  it.each(['params', 'path', 'project-path', 'permissions', 'permissionMode', 'parent', 'chat-id', 'endpoint', 'tags', 'preambles', 'settings'])
  ('rejects the forbidden %s attribute', (field) => {
    expect(parseGarconStartAgent(start(`agent="codex" model="example-model" ${field}="x"`))).toBeNull();
  });

  it('preserves exact provider names after XML decoding', () => {
    expect(parseGarconStartAgent(start('agent="codex" model="example" provider="Example Proxy &amp; Co"')))
      .toMatchObject({ providerId: 'Example Proxy & Co' });
  });

  it('rejects incomplete, duplicate, unquoted, nested, batch, and malformed text', () => {
    for (const content of [
      start('agent="codex"'), start('agent="" model="example-model"'),
      start('agent="codex" model="x" model="y"'), start("agent='codex' model=\"x\""),
      start('agent="codex" model="x"suffix'), start('agent="codex" model="x"', ''),
      start('agent="codex" model="x"', '<garcon-schedule in="1m" />'),
      '<garcon-start-agent>{"prompt":"x","params":[{}]}</garcon-start-agent>',
      '<garcon-start-agent ref="task" async="true" agent="codex" model="x" />',
      start(undefined, 'bad &unknown;'), start(undefined, 'bad &#60;'), start(undefined, 'bad &'),
      start(undefined, '\ud800'), start(undefined, '\0'), start(undefined, 'x').slice(0, -1),
    ]) expect(parseGarconStartAgent(content)).toBeNull();
  });

  it('bounds UTF-8 bytes before and after decoding', () => {
    expect(parseGarconStartAgent(start(undefined, 'x'.repeat(GARCON_START_PROMPT_MAX_BYTES)))).not.toBeNull();
    expect(parseGarconStartAgent(start(undefined, 'x'.repeat(GARCON_START_PROMPT_MAX_BYTES + 1)))).toBeNull();
    expect(parseGarconStartAgent(start(undefined, 'é'.repeat(GARCON_START_PROMPT_MAX_BYTES)))).toBeNull();
    expect(parseGarconStartAgent(start(undefined, '&amp;'.repeat(14000)))).toBeNull();
  });
});
