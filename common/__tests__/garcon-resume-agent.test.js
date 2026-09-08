import { describe, expect, it } from 'bun:test';
import { parseGarconResumeAgent } from '../garcon-resume-agent.ts';
import { parseGarconStartAgent } from '../garcon-start-agent.ts';
import { extractGarconCommands } from '../garcon-commands.ts';
import { AssistantMessage } from '../chat-types.ts';

const CHILD = '1111111111111111';
const resume = (attrs = 'ref="r1"', body = 'Continue.') =>
  `<garcon-resume-agent chat-id="${CHILD}" ${attrs}>${body}</garcon-resume-agent>`;

describe('delegated child request options', () => {
  it('defaults to terminal reporting and preserves refs exactly', () => {
    expect(parseGarconResumeAgent(resume())).toEqual({ type: 'resume-agent', chatId: CHILD, ref: 'r1', async: false, prompt: 'Continue.' });
    for (const ref of ['a', 'A0._-', 'a'.repeat(64)]) {
      expect(parseGarconResumeAgent(resume(`ref="${ref}" async="true"`))).toMatchObject({ ref, async: true });
    }
    expect(parseGarconResumeAgent(resume('ref="r1" async="false"'))?.async).toBe(false);
  });

  it('rejects absent refs, invalid booleans, targets, bodies and configuration overrides', () => {
    for (const attrs of ['', 'ref=""', 'ref=" a"', 'ref="a "', 'ref="a/b"', 'ref="é"',
      'ref=".a"', `ref="${'a'.repeat(65)}"`, 'ref="a" ref="b"',
      ...['TRUE', 'False', '1', '0', ''].map((value) => `ref="r1" async="${value}"`),
      ...['fork', 'title', 'agent', 'provider', 'model', 'reasoning-effort', 'project-path', 'permissions', 'parent', 'preambles']
        .map((field) => `ref="r1" ${field}="x"`),
    ]) expect(parseGarconResumeAgent(resume(attrs))).toBeNull();
    for (const body of ['', ' \n ', 'bad &', '<nested />', '\ud800', '\0', 'x'.repeat(48 * 1024 + 1)]) {
      expect(parseGarconResumeAgent(resume(undefined, body))).toBeNull();
    }
    expect(parseGarconResumeAgent(resume().replace(CHILD, '123'))).toBeNull();
    expect(parseGarconResumeAgent(`<garcon-resume-agent ref="r1" chat-id="${CHILD}" />`)).toBeNull();
    expect(parseGarconResumeAgent(resume(undefined, 'x'.repeat(48 * 1024)))).not.toBeNull();
    expect(parseGarconResumeAgent(resume(undefined, 'A &amp; B &amp;lt;'))?.prompt).toBe('A & B &lt;');
  });

  it('keeps repeated refs as independent leading and trailing commands', () => {
    const message = new AssistantMessage('2030-01-01T00:00:00.000Z', `${resume()}\n${resume()}`);
    expect(extractGarconCommands(message).commands).toHaveLength(2);
    expect(extractGarconCommands(new AssistantMessage(message.timestamp, `Visible text.\n${resume()}`)).commands).toHaveLength(1);
  });

  it('start fork and async flags are independent, and title uses the shared title boundary', () => {
    const start = (attrs = '') => `<garcon-start-agent ref="r1" agent="test" model="test" ${attrs}>Task.</garcon-start-agent>`;
    expect(parseGarconStartAgent(start())).toMatchObject({ fork: false, async: false, title: null });
    for (const fork of ['true', 'false']) for (const async of ['true', 'false']) {
      expect(parseGarconStartAgent(start(`fork="${fork}" async="${async}"`)))
        .toMatchObject({ fork: fork === 'true', async: async === 'true' });
    }
    expect(parseGarconStartAgent(start('title="  A  &amp; B &quot;review&quot;  "'))?.title).toBe('A  & B "review"');
    for (const title of ['x', 'x'.repeat(120), '𐐀'.repeat(120)]) {
      expect(parseGarconStartAgent(start(`title="${title}"`))?.title).toBe(title);
    }
    for (const attrs of ['fork="TRUE"', 'fork="1"', 'fork=""', 'fork="true" fork="true"',
      ...[' ', 'x'.repeat(121), '𐐀'.repeat(121), 'A\nB', 'A\tB', 'A\u2028B', 'A\u2029B', '\ud800']
        .map((title) => `title="${title}"`),
    ]) expect(parseGarconStartAgent(start(attrs))).toBeNull();
  });
});
