import { describe, expect, it } from 'bun:test';
import { AssistantMessage, ThinkingMessage, UserMessage } from '../chat-types.ts';
import { parseChatId } from '../chat-id.ts';
import {
  GARCON_GET_CHAT_ID,
  GARCON_MESSAGE_BODY_MAX_BYTES,
  extractGarconCommands,
  garconMessageContent,
  parseGarconMessage,
} from '../garcon-commands.ts';

const AT = '2026-08-28T00:00:00.000Z';
const FIRST = parseChatId('1787974832309199');
const SECOND = parseChatId('1787973671383699');

function send(to, hideSender, body = 'message') {
  return `<garcon-send-message to="${to}" hide-sender="${hideSender}">\n${body}\n</garcon-send-message>`;
}

describe('Garcon edge commands', () => {
  it('extracts chat-ID commands from either physical edge', () => {
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `${GARCON_GET_CHAT_ID}\nanswer`,
    ))).toEqual({
      message: new AssistantMessage(AT, 'answer'),
      commands: [{ type: 'get-chat-id' }],
      issues: [],
    });
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `answer\n${GARCON_GET_CHAT_ID}`,
    ))).toEqual({
      message: new AssistantMessage(AT, 'answer'),
      commands: [{ type: 'get-chat-id' }],
      issues: [],
    });
    expect(extractGarconCommands(new AssistantMessage(AT, GARCON_GET_CHAT_ID)))
      .toEqual({ message: null, commands: [{ type: 'get-chat-id' }], issues: [] });
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `${GARCON_GET_CHAT_ID}\n\n`,
    ))).toEqual({ message: null, commands: [{ type: 'get-chat-id' }], issues: [] });
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `answer\n${GARCON_GET_CHAT_ID}\n`,
    ))).toEqual({
      message: new AssistantMessage(AT, 'answer'),
      commands: [{ type: 'get-chat-id' }],
      issues: [],
    });
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `${GARCON_GET_CHAT_ID}\nanswer  `,
    ))).toEqual({
      message: new AssistantMessage(AT, 'answer  '),
      commands: [{ type: 'get-chat-id' }],
      issues: [],
    });
  });

  it('extracts whole-message commands despite trailing whitespace', () => {
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `${send(FIRST, false)}\n`,
    ))).toEqual({
      message: null,
      commands: [{
        type: 'send-message',
        recipients: [FIRST],
        hideSender: false,
        body: 'message',
      }],
      issues: [],
    });
  });

  it('extracts multiple command kinds in document order from both edges', () => {
    const leadingSend = send(`${FIRST}, ${SECOND}, ${FIRST}`, false, 'first body');
    const trailingSend = send(SECOND, true, 'second body');
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `${GARCON_GET_CHAT_ID}\n${leadingSend}\nanswer\n${trailingSend}\n${GARCON_GET_CHAT_ID}`,
    ))).toEqual({
      message: new AssistantMessage(AT, 'answer'),
      commands: [
        { type: 'get-chat-id' },
        {
          type: 'send-message',
          recipients: [FIRST, SECOND],
          hideSender: false,
          body: 'first body',
        },
        {
          type: 'send-message',
          recipients: [SECOND],
          hideSender: true,
          body: 'second body',
        },
        { type: 'get-chat-id' },
      ],
      issues: [],
    });
  });

  it('keeps an unbalanced send opener inert even when introduced as an example', () => {
    const quotedOpener = `<garcon-send-message to="${SECOND}" hide-sender="false">`;
    const command = [
      `<garcon-send-message to="${FIRST}" hide-sender="false">`,
      'Use it like this:',
      quotedOpener,
      'example',
      '</garcon-send-message>',
    ].join('\n');

    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `answer\n${command}`,
    ))).toEqual({
      message: new AssistantMessage(AT, `answer\n${command}`),
      commands: [],
      issues: [{ command: 'send-message', reason: 'malformed', edge: 'trailing' }],
    });
  });

  it('does not reroute a trailing command through a complete nested command', () => {
    const command = send(
      FIRST,
      false,
      `before\n${send(SECOND, false, 'nested')}\nafter`,
    );
    const content = `answer\n${command}`;

    expect(extractGarconCommands(new AssistantMessage(AT, content))).toEqual({
      message: new AssistantMessage(AT, content),
      commands: [],
      issues: [{ command: 'send-message', reason: 'malformed', edge: 'trailing' }],
    });
  });

  it('rejects a closing delimiter inside a trailing command body', () => {
    const command = send(
      FIRST,
      false,
      'Close with </garcon-send-message> when done.',
    );
    const content = `answer\n${command}`;

    expect(extractGarconCommands(new AssistantMessage(AT, content))).toEqual({
      message: new AssistantMessage(AT, content),
      commands: [],
      issues: [{ command: 'send-message', reason: 'malformed', edge: 'trailing' }],
    });
  });

  it('extracts stacked trailing send commands in document order', () => {
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `answer\n${send(FIRST, false, 'first')}\n${send(SECOND, true, 'second')}`,
    ))).toEqual({
      message: new AssistantMessage(AT, 'answer'),
      commands: [
        {
          type: 'send-message',
          recipients: [FIRST],
          hideSender: false,
          body: 'first',
        },
        {
          type: 'send-message',
          recipients: [SECOND],
          hideSender: true,
          body: 'second',
        },
      ],
      issues: [],
    });
  });

  it('preserves body bytes except one adjacent newline on each side', () => {
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      send(FIRST, false, '\n  body  \n'),
    )).commands[0]).toEqual({
      type: 'send-message',
      recipients: [FIRST],
      hideSender: false,
      body: '\n  body  \n',
    });
    const crlf = `<garcon-send-message to="${FIRST}" hide-sender="true">\r\nbody\r\n</garcon-send-message>`;
    expect(extractGarconCommands(new AssistantMessage(AT, crlf)).commands[0].body)
      .toBe('body');
  });

  it('keeps malformed send commands as assistant text and reports one issue', () => {
    for (const content of [
      send('invalid', false),
      send(`${FIRST},`, false),
      `<garcon-send-message hide-sender="false" to="${FIRST}">message</garcon-send-message>`,
      `<garcon-send-message to="${FIRST}" hide-sender="FALSE">message</garcon-send-message>`,
      `<garcon-send-message to="${FIRST}" hide-sender="false"></garcon-send-message>`,
      `<garcon-send-message to="${FIRST}" hide-sender="false">message`,
      `<garcon-send-message to="${FIRST}" hide-sender="false">${'x'.repeat(GARCON_MESSAGE_BODY_MAX_BYTES + 1)}</garcon-send-message>`,
    ]) {
      const result = extractGarconCommands(new AssistantMessage(AT, content));
      expect(result?.message?.content).toBe(content);
      expect(result?.commands).toEqual([]);
      expect(result?.issues).toHaveLength(1);
    }
    const padded = `${send('invalid', false)}\n`;
    const result = extractGarconCommands(new AssistantMessage(AT, padded));
    expect(result?.message?.content).toBe(padded);
    expect(result?.commands).toEqual([]);
    expect(result?.issues).toHaveLength(1);
  });

  it('rejects more than 16 unique recipients but permits duplicates within the cap', () => {
    const ids = Array.from({ length: 17 }, (_, index) =>
      String(1787974832309100n + BigInt(index)));
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      send(ids.join(','), false),
    )).issues).toHaveLength(1);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      send(Array(17).fill(FIRST).join(','), false),
    )).commands[0].recipients).toEqual([FIRST]);
  });

  it('does not consume commands in prose, leading whitespace, or non-assistant rows', () => {
    for (const content of [
      `Explanation ${GARCON_GET_CHAT_ID}`,
      ` ${GARCON_GET_CHAT_ID}`,
      '<garcon-get-chat-id/>',
      '<GARCON-GET-CHAT-ID />',
      `Example: ${send(FIRST, false)}`,
    ]) {
      expect(extractGarconCommands(new AssistantMessage(AT, content))).toBeNull();
    }
    expect(extractGarconCommands(new ThinkingMessage(AT, GARCON_GET_CHAT_ID))).toBeNull();
    expect(extractGarconCommands(new UserMessage(AT, GARCON_GET_CHAT_ID))).toBeNull();
  });

  it('rejects the removed start-agent batch grammar', () => {
    for (const content of [
      '<garcon-start-agent>\n{"prompt":"test"}\n</garcon-start-agent>',
      '<garcon-start-agent>\n{"prompt":"test"}',
    ]) {
      expect(extractGarconCommands(new AssistantMessage(AT, content))).toMatchObject({
        message: new AssistantMessage(AT, content), commands: [],
        issues: [{ command: 'start-agent', reason: 'malformed', edge: 'leading' }],
      });
    }
  });

  it('extracts single starts and schedules across mixed edge chains without changing prose', () => {
    const start = '<garcon-start-agent agent="codex" model="example">Inspect.</garcon-start-agent>';
    const schedule = '<garcon-schedule every="5m" />';
    const result = extractGarconCommands(new AssistantMessage(AT,
      `${start}\n${schedule}\nAnswer  \n${send(FIRST, false)}\n${start}\n${GARCON_GET_CHAT_ID}\n`));
    expect(result.message.content).toBe('Answer');
    expect(result.commands.map((command) => command.type)).toEqual(['start-agent', 'schedule', 'send-message', 'start-agent', 'get-chat-id']);
    expect(result.issues).toEqual([]);
    expect(extractGarconCommands(new AssistantMessage(AT, `${schedule}\nAnswer  `)).message.content).toBe('Answer  ');
  });

  it('keeps mixed command envelopes opaque, including malformed and unclosed bodies', () => {
    const start = '<garcon-start-agent agent="codex" model="example">';
    const schedule = '<garcon-schedule every="5m">';
    for (const opener of [start, schedule, `<garcon-send-message to="${FIRST}" hide-sender="false">`]) {
      for (const nested of [GARCON_GET_CHAT_ID, '<garcon-schedule in="1m" />', `${start}Inspect.</garcon-start-agent>`]) {
        for (const prefix of ['', 'Answer\n']) {
          const result = extractGarconCommands(new AssistantMessage(AT, `${prefix}${opener}\n${nested}`));
          expect(result.commands).toEqual([]);
          expect(result.issues).toHaveLength(1);
        }
      }
    }
    const malformed = `${start}\n<garcon-schedule in="1m" />\n</garcon-start-agent>`;
    const result = extractGarconCommands(new AssistantMessage(AT, `${malformed}\n${GARCON_GET_CHAT_ID}`));
    expect(result.commands).toEqual([{ type: 'get-chat-id' }]);
    expect(result.issues).toHaveLength(1);
  });

  it('keeps unsupported markup opaque while finding an outer envelope boundary', () => {
    for (const family of ['start-agent', 'schedule', 'send-message']) {
      for (const prefix of ['', 'Answer\n']) {
        for (const [open, close] of [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?example', '?>']]) {
          for (const terminated of [false, true]) {
            const malformed = `${prefix}<garcon-${family}>\n${open}</garcon-${family}>${terminated ? close : ''}\n<garcon-schedule in="1m" />`;
            const result = extractGarconCommands(new AssistantMessage(AT, malformed));
            expect(result.message.content).toBe(malformed);
            expect(result.commands).toEqual([]);
            expect(result.issues).toHaveLength(1);
            const closed = `${malformed}\n</garcon-${family}>`;
            const content = `${closed}\n<garcon-schedule in="5m" />`;
            const recovered = extractGarconCommands(new AssistantMessage(AT, content));
            expect(recovered.message.content).toBe(terminated ? closed : content);
            expect(recovered.commands).toMatchObject(terminated
              ? [{ type: 'schedule', firstRun: { type: 'after', minutes: 5 } }] : []);
            expect(recovered.commands).toHaveLength(terminated ? 1 : 0);
            expect(recovered.issues).toHaveLength(1);
          }
        }
        const content = `${prefix}<garcon-${family}>\n<!DOCTYPE example [<!ENTITY closer "</garcon-${family}>">]>\n</garcon-${family}>\n<garcon-schedule in="1m" />`;
        const result = extractGarconCommands(new AssistantMessage(AT, content));
        expect(result.message.content).toBe(content);
        expect(result.commands).toEqual([]);
        expect(result.issues).toHaveLength(1);
      }
    }
  });

  it('never executes code-fenced examples or result/action lookalikes', () => {
    for (const content of [
      '<garcon-schedule-action />', '<garcon-schedule-result status="created" />',
      '<garcon-start-agent-result status="created" />',
      '```xml\n<garcon-schedule in="1m" />\n```',
      '~~~xml\n<garcon-schedule in="1m" />',
      `Example:\n\`\`\`xml\n${GARCON_GET_CHAT_ID}`,
      'Example <garcon-schedule in="1m" />',
    ]) expect(extractGarconCommands(new AssistantMessage(AT, content))).toBeNull();
    expect(extractGarconCommands(new UserMessage(AT, '<garcon-schedule in="1m" />'))).toBeNull();
  });

  for (const family of ['start-agent', 'schedule', 'send-message']) {
    for (const prefix of ['', 'Answer\n']) {
      it(`preserves Markdown fences in a retained ${prefix ? 'trailing' : 'leading'} ${family}`, () => {
        for (const fence of ['~~~', '```', '   ~~~~']) {
          const malformed = `${prefix}<garcon-${family}>\n${fence}xml\n</garcon-${family}>`;
          for (const suffix of [GARCON_GET_CHAT_ID, '<garcon-schedule in="1m" />',
            '<garcon-start-agent agent="codex" model="example">Inspect.</garcon-start-agent>', send(FIRST, false)]) {
            const content = `${malformed}\n${suffix}`;
            const result = extractGarconCommands(new AssistantMessage(AT, content));
            expect(result?.commands ?? []).toEqual([]);
            expect(result?.message.content ?? content).toBe(content);
          }
          const result = extractGarconCommands(new AssistantMessage(AT,
            `${malformed}\n${fence}\n<garcon-schedule in="1m" />`));
          expect(result.commands).toMatchObject([{ type: 'schedule', firstRun: { minutes: 1 } }]);
          expect(result.commands).toHaveLength(1);
        }
      });
    }
  }

  it('keeps fences opaque only inside envelopes that are removed', () => {
    for (const envelope of [
      '<garcon-start-agent agent="codex" model="example">\n~~~xml\n</garcon-start-agent>',
      '<garcon-schedule in="1m">\n~~~xml\n</garcon-schedule>',
      send(FIRST, false, '~~~xml'),
    ]) {
      const removed = extractGarconCommands(new AssistantMessage(AT, `Answer\n${envelope}\n<garcon-schedule in="5m" />`));
      expect(removed.commands).toHaveLength(2);
      expect(removed.message.content).toBe('Answer');
      for (const following of ['Retained prose', '<garcon-start-agent />']) {
        const content = `Answer\n${envelope}\n${following}\n<garcon-schedule in="5m" />`;
        const retained = extractGarconCommands(new AssistantMessage(AT, content));
        expect(retained?.commands ?? []).toEqual([]);
        expect(retained?.message.content ?? content).toBe(content);
      }
    }
  });

  it('never uses a nested self-closing command to close a malformed outer opener', () => {
    for (const family of ['start-agent', 'schedule', 'send-message']) {
      for (const attributes of ['', ' broken="']) {
        for (const prefix of ['', 'Answer\n']) {
          const malformed = `<garcon-${family}${attributes}\n<garcon-schedule in="1m" />\n<garcon-schedule in="5m" />`;
          const content = `${prefix}${malformed}`;
          expect(extractGarconCommands(new AssistantMessage(AT, content))).toMatchObject({
            message: new AssistantMessage(AT, content), commands: [],
            issues: [{ command: family, reason: 'malformed' }],
          });
          const closed = `${content}\n</garcon-${family}>`;
          const result = extractGarconCommands(new AssistantMessage(AT, `${closed}\n<garcon-schedule in="10m" />`));
          if (attributes) {
            expect(result.message.content).toBe(`${closed}\n<garcon-schedule in="10m" />`);
            expect(result.commands).toEqual([]);
          } else {
            expect(result.message.content).toBe(closed);
            expect(result.commands).toMatchObject([{ type: 'schedule', firstRun: { type: 'after', minutes: 10 } }]);
            expect(result.commands).toHaveLength(1);
          }
          expect(result.issues).toHaveLength(1);
        }
      }
    }
  });

  for (const family of ['start-agent', 'schedule', 'send-message']) {
    for (const prefix of ['', 'Answer\n']) {
      const edge = prefix ? 'trailing' : 'leading';
      it(`shields commands after nested closers in an unclosed ${edge} ${family}`, () => {
        const nestedFamily = family === 'schedule' ? 'start-agent' : 'schedule';
        for (const opener of [`<garcon-${family}>`, `<garcon-${family}\n`]) {
          for (const nested of [
            `<garcon-${family}>nested</garcon-${family}>`,
            `<garcon-schedule><garcon-${family}>nested</garcon-${family}></garcon-schedule>`,
            `<garcon-${nestedFamily}></garcon-${family}></garcon-${nestedFamily}>`,
          ]) {
            for (const suffix of [
              '<garcon-schedule in="1m" />', GARCON_GET_CHAT_ID,
              '<garcon-start-agent agent="codex" model="example">Inspect.</garcon-start-agent>',
              send(FIRST, false),
            ]) {
              const content = `${prefix}${opener}\n${nested}\n${suffix}`;
              expect(extractGarconCommands(new AssistantMessage(AT, content))).toEqual({
                message: new AssistantMessage(AT, content), commands: [],
                issues: [{ command: family, reason: 'malformed', edge }],
              });
            }
          }
        }
      });

      it(`ignores closing tags inside malformed quoted ${edge} ${family} openers`, () => {
        for (const opener of [
          `<garcon-${family} broken="`,
          `<garcon-${family} broken='`,
          `<garcon-${family}>\n<garcon-schedule broken="`,
          `<garcon-${family}>\n<garcon-schedule broken='`,
          `<garcon-${family}>\n<example broken="`,
          `<garcon-${family}>\n<garcon-start-agent-result broken='`,
        ]) {
          const content = `${prefix}${opener}</garcon-${family}>\n<garcon-schedule in="1m" />`;
          expect(extractGarconCommands(new AssistantMessage(AT, content))).toEqual({
            message: new AssistantMessage(AT, content), commands: [],
            issues: [{ command: family, reason: 'malformed', edge }],
          });
        }
      });

      it(`recovers only beyond the balanced outer closer of a malformed ${edge} ${family}`, () => {
        const malformed = `${prefix}<garcon-${family}>\n<garcon-${family}>nested</garcon-${family}>\n</garcon-${family}>`;
        const result = extractGarconCommands(new AssistantMessage(AT, `${malformed}\n<garcon-schedule in="10m" />`));
        expect(result.message.content).toBe(malformed);
        expect(result.commands).toMatchObject([{ type: 'schedule', firstRun: { type: 'after', minutes: 10 } }]);
        expect(result.commands).toHaveLength(1);
        expect(result.issues).toEqual([{ command: family, reason: 'malformed', edge }]);
      });
    }
  }

  it('can consume a valid command at the opposite edge of a malformed one', () => {
    const malformed = send('invalid', false);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `${malformed}\nanswer\n${GARCON_GET_CHAT_ID}`,
    ))).toEqual({
      message: new AssistantMessage(AT, `${malformed}\nanswer`),
      commands: [{ type: 'get-chat-id' }],
      issues: [{ command: 'send-message', reason: 'malformed', edge: 'leading' }],
    });
  });

  it('recovers a trailing send after an earlier closed malformed send', () => {
    const malformed = send('invalid', false, 'invalid body');
    const valid = send(FIRST, false, 'valid body');
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `answer\n${malformed}\n${valid}`,
    ))).toEqual({
      message: new AssistantMessage(AT, `answer\n${malformed}`),
      commands: [{
        type: 'send-message',
        recipients: [FIRST],
        hideSender: false,
        body: 'valid body',
      }],
      issues: [{ command: 'send-message', reason: 'malformed', edge: 'trailing' }],
    });
  });

  it('does not dispatch a chat-ID command inside an unclosed send-message envelope', () => {
    const nestedContent = [
      `<garcon-send-message to="${FIRST}" hide-sender="false">`,
      'Example:',
      GARCON_GET_CHAT_ID,
    ].join('\n');
    for (const prefix of ['', 'answer\n']) {
      const content = `${prefix}${nestedContent}`;
      expect(extractGarconCommands(new AssistantMessage(AT, content))).toEqual({
        message: new AssistantMessage(AT, content),
        commands: [],
        issues: [{
          command: 'send-message',
          reason: 'malformed',
          edge: prefix ? 'trailing' : 'leading',
        }],
      });
    }
  });
});

describe('Garcon received-message envelope', () => {
  it('round-trips visible and hidden senders', () => {
    const visible = garconMessageContent(FIRST, 'message\nbody');
    expect(visible).toBe(
      `<garcon-message from="${FIRST}">\nmessage\nbody\n</garcon-message>`,
    );
    expect(parseGarconMessage(visible)).toEqual({ fromChatId: FIRST, body: 'message\nbody' });

    const hidden = garconMessageContent(null, 'message');
    expect(hidden).toBe('<garcon-message>\nmessage\n</garcon-message>');
    expect(parseGarconMessage(hidden)).toEqual({ fromChatId: null, body: 'message' });
  });

  it('rejects noncanonical envelopes', () => {
    for (const content of [
      `<garcon-message from="invalid">message</garcon-message>`,
      `<garcon-message from="${FIRST}" extra="x">message</garcon-message>`,
      '<garcon-message></garcon-message>',
      'prefix <garcon-message>message</garcon-message>',
      '<garcon-message>message</garcon-message> suffix',
    ]) {
      expect(parseGarconMessage(content)).toBeNull();
    }
  });
});
