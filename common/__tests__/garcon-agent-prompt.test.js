import { describe, expect, test } from 'bun:test';
import { AssistantMessage } from '../chat-types.js';
import { extractGarconCommands } from '../garcon-commands.js';
import { parseGarconStartAgent } from '../garcon-start-agent.js';
import { parseGarconResumeAgent } from '../garcon-resume-agent.js';
import { GARCON_ENVELOPE_COMMANDS } from '../garcon-command-envelope.js';

const AT = '2030-01-01T00:00:00.000Z';
const CHILD = '1111111111111111';
const families = [
  ['start-agent', 'ref="task" title="Example &amp; test"', parseGarconStartAgent],
  ['resume-agent', `ref="task" chat-id="${CHILD}"`, parseGarconResumeAgent],
];

describe('literal delegated prompts', () => {
  for (const [family, attributes, parse] of families) {
    const wrap = (body) => `<garcon-${family} ${attributes}>\n${body}\n</garcon-${family}>`;

    test.each([
      'Use recovery-<chatId>, List<String>, and Record<string, unknown>.',
      'Run checks && build; keep &amp;, &#60;, and &unknown; unchanged.',
      "Compare a < b, x <= y, and x < 3. It doesn't need XML escaping.",
      "If a<b, don't change it. If x<limit don't retry. Check a<b. It doesn't work.",
      'Preserve <example broken=" and a <! b as literal text.',
      '<!DOCTYPE html>\n<div title="Example">literal & text</div>',
      '```dart\nfinal result = <String>["example"];\n```',
      '\n  Keep spaces, tabs\tand newlines.\r\n',
      '<garcon-get-chat-id />\n<garcon-schedule every="5m" />',
      '<garcon-resume-agent ref="nested" chat-id="2222222222222222">Example.</garcon-resume-agent>',
      `<!-- </garcon-${family}> -->\n<![CDATA[</garcon-${family}>]]>`,
    ])(`${family} preserves %s without dispatching nested text`, (prompt) => {
      expect(parse(wrap(prompt))?.prompt).toBe(prompt);
      for (const prefix of ['', 'Summary.\n']) {
        const result = extractGarconCommands(new AssistantMessage(AT, `${prefix}${wrap(prompt)}\n`));
        expect(result.commands).toHaveLength(1);
        expect(result.commands[0]).toMatchObject({ type: family, prompt });
        expect(result.issues).toEqual([]);
        expect(result.message?.content ?? '').toBe(prefix.trim());
      }
    });

    test(`${family} retains strict framing, attributes and text limits`, () => {
      for (const content of [
        wrap('Example.').replace('ref="task"', 'ref="task" unknown="value"'),
        wrap('Example.').replace('ref="task"', 'ref="task" ref="duplicate"'),
        wrap('Example.').replace('ref="task"', 'ref="bad & ref"'),
        wrap(`Unmatched </garcon-${family}> closer.`),
        wrap(`<garcon-${family}>Unclosed nested command.`),
        wrap(`<garcon-${family}\n</garcon-${family}>`),
        wrap('<garcon-schedule\n</garcon-schedule>'),
        wrap(`<garcon-schedule>Misnested </garcon-${family}> closer.</garcon-schedule>`),
        ...GARCON_ENVELOPE_COMMANDS.map((nested) => wrap(`Unmatched </garcon-${nested}> closer.`)),
        wrap('Unclosed <!-- comment'), wrap('Unclosed <![CDATA[ section'), wrap('Unclosed <? instruction'),
        wrap('Malformed \ud800'), wrap('Invalid \u0001 control'),
        wrap('x'.repeat(48 * 1024 + 1)),
      ]) expect(parse(content)).toBeNull();
      expect(parse(wrap('x'.repeat(48 * 1024)))?.prompt).toHaveLength(48 * 1024);
      expect(extractGarconCommands(new AssistantMessage(AT, `\`\`\`xml\n${wrap('Example.')}\n\`\`\``))).toBeNull();
    });

    test(`${family} never dispatches an apparent suffix inside an ambiguously closed prompt`, () => {
      for (const prefix of ['', 'Summary.\n']) {
        for (const nested of ['<garcon-schedule every="5m" />', `<garcon-${family} />`]) {
          const content = `${prefix}${wrap(`Example </garcon-${family}>\n${nested}`)}`;
          const result = extractGarconCommands(new AssistantMessage(AT, content));
          expect(result.commands).toEqual([]);
          expect(result.message.content).toBe(content);
          expect(result.issues).toHaveLength(1);
        }
      }
      expect(extractGarconCommands(new AssistantMessage(AT, `${wrap('First.')}\n${wrap('Second.')}`)).commands)
        .toMatchObject([{ prompt: 'First.' }, { prompt: 'Second.' }]);
    });

    test(`${family} checks the complete suffix rather than trusting an opener substring`, () => {
      for (const prefix of ['', 'Summary.\n']) {
        for (const shelteredOpener of [
          `<!-- <garcon-${family}> -->`,
          `<![CDATA[<garcon-${family}>]]>`,
          `<?example <garcon-${family}> ?>`,
          `<example attr="<garcon-${family}>">`,
          `\`\`\`xml\n<garcon-${family}>\n\`\`\``,
          `~~~xml\n<garcon-${family}>\n~~~`,
        ]) {
          const content = `${prefix}${wrap(`Text </garcon-${family}>\n<garcon-stop-agent chat-id="${CHILD}" remove="true" />\n${shelteredOpener}`)}`;
          const result = extractGarconCommands(new AssistantMessage(AT, content));
          expect(result.commands).toEqual([]);
          expect(result.issues).toHaveLength(1);
          expect(result.message.content).toBe(content);
        }
        const content = `${prefix}${wrap('First.')}\n${wrap('Second.')}\n</garcon-${family}>`;
        expect(extractGarconCommands(new AssistantMessage(AT, content)).commands).toEqual([]);
      }
    });

    test(`${family} never uses incomplete sibling openers as shielding`, () => {
      for (const prefix of ['', 'Summary.\n']) {
        for (const sibling of [
          `<garcon-${family}\n</garcon-${family}>`,
          `<garcon-send-message>\n<garcon-${family}\n</garcon-${family}>\n</garcon-send-message>`,
        ]) {
          const content = `${prefix}${wrap('Use List<String>.')}\n<garcon-stop-agent chat-id="${CHILD}" remove="true" />\n${sibling}`;
          const result = extractGarconCommands(new AssistantMessage(AT, content));
          expect(result.commands).toEqual([]);
          expect(result.issues).toHaveLength(1);
          expect(result.message.content).toBe(content);
        }
      }
    });

    test(`${family} rejects orphan closers hidden inside a different prompt family`, () => {
      const [other, otherAttributes] = families.find(([candidate]) => candidate !== family);
      for (const prefix of ['', 'Summary.\n']) {
        const sibling = `<garcon-${other} ${otherAttributes}>Unintended work. </garcon-${family}></garcon-${other}>`;
        const content = `${prefix}${wrap('Example.')}\n<garcon-stop-agent chat-id="${CHILD}" remove="true" />\n${sibling}`;
        const result = extractGarconCommands(new AssistantMessage(AT, content));
        expect(result.commands).toEqual([]);
        expect(result.issues).toEqual([{ command: family, reason: 'malformed', edge: prefix ? 'trailing' : 'leading' }]);
        expect(result.message.content).toBe(content);
      }
    });

    test(`${family} never uses unbalanced native siblings as shielding`, () => {
      const other = family === 'start-agent' ? 'resume-agent' : 'start-agent';
      const orphan = `Unmatched </garcon-${family}> closer.`;
      for (const native of GARCON_ENVELOPE_COMMANDS.filter((name) => !families.some(([prompt]) => prompt === name))) {
        const siblingAttributes = native === 'send-message' ? ` to="${CHILD}" hide-sender="false"` : '';
        for (const body of [orphan, `<garcon-${other}>${orphan}</garcon-${other}>`]) {
          const sibling = `<garcon-${native}${siblingAttributes}>${body}</garcon-${native}>`;
          for (const prefix of ['', 'Summary.\n']) {
            const content = `${prefix}${wrap('Example.')}\n<garcon-stop-agent chat-id="${CHILD}" remove="true" />\n${sibling}`;
            const result = extractGarconCommands(new AssistantMessage(AT, content));
            expect(result.commands).toEqual([]);
            expect(result.issues).toEqual([{ command: family, reason: 'malformed', edge: prefix ? 'trailing' : 'leading' }]);
            expect(result.message.content).toBe(content);
          }
        }
      }
    });

    test(`${family} does not change standalone literal messages containing orphan closers`, () => {
      const body = `Documentation quotes </garcon-${family}> literally.`;
      const send = `<garcon-send-message to="${CHILD}" hide-sender="false">${body}</garcon-send-message>`;
      for (const prefix of ['', 'Summary.\n']) {
        const result = extractGarconCommands(new AssistantMessage(AT, `${prefix}${send}`));
        expect(result.commands).toMatchObject([{ type: 'send-message', body }]);
        expect(result.commands).toHaveLength(1);
        expect(result.issues).toEqual([]);
        expect(result.message?.content ?? '').toBe(prefix.trim());
      }
    });

    test(`${family} preserves ordinary prose and complete fenced examples between edge commands`, () => {
      for (const prose of [
        "Compare a<b. It doesn't work.",
        `He wrote a<b "c <!-- </garcon-${family}> -->`,
        `\`\`\`xml\n${wrap('Fenced example.')}\n\`\`\``,
        `~~~xml\n${wrap('Fenced example.')}\n~~~`,
        `   \`\`\`\`xml\r\n${wrap('Fenced example.')}\r\n   \`\`\`\``,
      ]) {
        const content = `${wrap('First.')}\n${prose}\n${wrap('Second.')}`;
        const result = extractGarconCommands(new AssistantMessage(AT, content));
        expect(result.commands).toMatchObject([{ prompt: 'First.' }, { prompt: 'Second.' }]);
        expect(result.commands).toHaveLength(2);
        expect(result.issues).toEqual([]);
        expect(result.message.content).toBe(prose.trimStart());
      }
    });

    test(`${family} ignores its closing delimiter inside a separate message envelope`, () => {
      for (const body of [
        `<!-- </garcon-${family}> -->`,
        `Compare a<b. <!-- </garcon-${family}> -->`,
        `<![CDATA[</garcon-${family}>]]>`,
        `<?example </garcon-${family}> ?>`,
        `<garcon-${family}>Balanced example.</garcon-${family}>`,
      ]) {
        const send = `<garcon-send-message to="${CHILD}" hide-sender="false">${body}</garcon-send-message>`;
        for (const prefix of ['', 'Summary.\n']) {
          const result = extractGarconCommands(new AssistantMessage(AT, `${prefix}${wrap('First.')}\n${send}`));
          expect(result.commands).toMatchObject([{ type: family, prompt: 'First.' }, { type: 'send-message', body }]);
          expect(result.commands).toHaveLength(2);
          expect(result.issues).toEqual([]);
        }
      }
      const separated = `${wrap('First.')}\nSummary.\n\`\`\`\n<example />\n\`\`\`\n${wrap('Second.')}`;
      expect(extractGarconCommands(new AssistantMessage(AT, separated)).commands)
        .toMatchObject([{ prompt: 'First.' }, { prompt: 'Second.' }]);
    });

    test(`${family} does not blame earlier prompts for an unrelated incomplete suffix`, () => {
      const other = family === 'start-agent' ? 'resume-agent' : 'start-agent';
      const malformed = `<garcon-${other}\n`;
      const result = extractGarconCommands(new AssistantMessage(AT, `${wrap('First.')}\n${wrap('Second.')}\n${malformed}`));
      expect(result.commands).toMatchObject([{ prompt: 'First.' }, { prompt: 'Second.' }]);
      expect(result.commands).toHaveLength(2);
      expect(result.issues).toEqual([{ command: other, reason: 'malformed', edge: 'leading' }]);
      expect(result.message.content).toBe(malformed);
    });

    test(`${family} rejects incomplete nested openers without exposing later commands`, () => {
      for (const prefix of ['', 'Summary.\n']) {
        const malformed = wrap('<garcon-schedule\n</garcon-schedule>');
        const result = extractGarconCommands(new AssistantMessage(AT,
          `${prefix}${malformed}\n<garcon-schedule in="5m" />`));
        expect(result.commands).toMatchObject([{ type: 'schedule' }]);
        expect(result.commands).toHaveLength(1);
        expect(result.issues).toEqual([{ command: family, reason: 'malformed', edge: prefix ? 'trailing' : 'leading' }]);
        expect(result.message.content).toBe(`${prefix}${malformed}`);
      }
    });
  }

  test.each(['', 'Summary.\n'])('scans long prompt-command chains once with prefix %j', (prefix) => {
    const commands = Array.from({ length: 4_000 }, (_, index) => {
      const [family, attributes] = families[index % families.length];
      return `<garcon-${family} ${attributes}>Synthetic.</garcon-${family}>`;
    });
    const content = prefix + commands.join('\n');
    const started = performance.now();
    const result = extractGarconCommands(new AssistantMessage(AT, content));
    expect(result.commands).toHaveLength(commands.length);
    expect(result.issues).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('scans comparison-heavy suffix lines without repeatedly searching their remainder', () => {
    const command = '<garcon-start-agent ref="task">Synthetic.</garcon-start-agent>';
    const prose = "Compare a<b. It doesn't work. ".repeat(64_000);
    const started = performance.now();
    const result = extractGarconCommands(new AssistantMessage(AT, `${command}\n${prose}\n${command}`));
    expect(result.commands).toHaveLength(2);
    expect(result.issues).toEqual([]);
    expect(result.message.content).toBe(prose.trimEnd());
    expect(performance.now() - started).toBeLessThan(500);
  });
});
