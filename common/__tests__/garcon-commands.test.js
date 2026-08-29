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

  it('keeps a quoted send opener inside a trailing command body', () => {
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
      message: new AssistantMessage(AT, 'answer'),
      commands: [{
        type: 'send-message',
        recipients: [FIRST],
        hideSender: false,
        body: `Use it like this:\n${quotedOpener}\nexample`,
      }],
      issues: [],
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

  it('does not consume commands in prose, outer whitespace, or non-assistant rows', () => {
    for (const content of [
      `Explanation ${GARCON_GET_CHAT_ID}`,
      ` ${GARCON_GET_CHAT_ID}`,
      `${GARCON_GET_CHAT_ID} `,
      '<garcon-get-chat-id/>',
      '<GARCON-GET-CHAT-ID />',
      `Example: ${send(FIRST, false)}`,
    ]) {
      expect(extractGarconCommands(new AssistantMessage(AT, content))).toBeNull();
    }
    expect(extractGarconCommands(new ThinkingMessage(AT, GARCON_GET_CHAT_ID))).toBeNull();
    expect(extractGarconCommands(new UserMessage(AT, GARCON_GET_CHAT_ID))).toBeNull();
  });

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
