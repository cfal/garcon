import { describe, expect, it } from 'bun:test';
import { AssistantMessage, ThinkingMessage, UserMessage } from '../chat-types.ts';
import { parseChatId } from '../chat-id.ts';
import {
  GARCON_CREATE_CHAT_MODEL_MAX_BYTES,
  GARCON_GET_CHAT_ID,
  GARCON_MESSAGE_BODY_MAX_BYTES,
  GARCON_START_AGENT_PAYLOAD_MAX_BYTES,
  GARCON_START_PROMPT_MAX_BYTES,
  extractGarconCommands,
  garconCreateChatResultsContent,
  garconMessageContent,
  parseGarconCreateChatResults,
  parseGarconMessage,
} from '../garcon-commands.ts';

const AT = '2026-08-28T00:00:00.000Z';
const FIRST = parseChatId('1787974832309199');
const SECOND = parseChatId('1787973671383699');
const FIRST_REF = '69b623a7-757e-49f6-93b8-4b7ea1bc569b';
const SECOND_REF = '2cf0e440-11b4-41aa-bc90-36145b214f66';

function send(to, hideSender, body = 'message') {
  return `<garcon-send-message to="${to}" hide-sender="${hideSender}">\n${body}\n</garcon-send-message>`;
}

function createParams({
  ref = FIRST_REF,
  agent = 'codex',
  provider,
  endpoint,
  model = 'gpt-5.4',
  reasoningEffort,
} = {}) {
  return {
    ref,
    agent,
    ...(provider === undefined ? {} : { provider }),
    ...(endpoint === undefined ? {} : { endpoint }),
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

function startAgent(prompt = 'initial prompt', params = [createParams()], lineBreak = '\n') {
  return startAgentPayload({ prompt, params }, lineBreak);
}

function startAgentPayload(payload, lineBreak = '\n') {
  const json = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload, null, 2);
  return [
    '<garcon-start-agent>',
    json.replaceAll('\n', lineBreak),
    '</garcon-start-agent>',
  ].join(lineBreak);
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

  it('does not dispatch commands inside an unclosed envelope of another family', () => {
    const cases = [
      {
        outer: 'start-agent',
        content: [
          '<garcon-start-agent>',
          '{"prompt":"outer","params":[',
          send(FIRST, false, 'nested'),
        ].join('\n'),
      },
      {
        outer: 'start-agent',
        content: [
          '<garcon-start-agent>',
          '{"prompt":"outer","params":[',
          GARCON_GET_CHAT_ID,
        ].join('\n'),
      },
      {
        outer: 'send-message',
        content: [
          `<garcon-send-message to="${FIRST}" hide-sender="false">`,
          'Example:',
          startAgent('nested'),
        ].join('\n'),
      },
    ];

    for (const prefix of ['', 'answer\n']) {
      for (const { outer, content: nestedContent } of cases) {
        const content = `${prefix}${nestedContent}`;
        expect(extractGarconCommands(new AssistantMessage(AT, content))).toEqual({
          message: new AssistantMessage(AT, content),
          commands: [],
          issues: [{
            command: outer,
            reason: 'malformed',
            edge: prefix ? 'trailing' : 'leading',
          }],
        });
      }
    }
  });

  it('recovers trailing commands after a closed malformed envelope of another family', () => {
    const malformedStart = startAgentPayload('{"prompt":');
    const trailingSend = send(FIRST, false, 'valid');
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `answer\n${malformedStart}\n${trailingSend}`,
    ))).toEqual({
      message: new AssistantMessage(AT, `answer\n${malformedStart}`),
      commands: [{
        type: 'send-message',
        recipients: [FIRST],
        hideSender: false,
        body: 'valid',
      }],
      issues: [{ command: 'start-agent', reason: 'malformed', edge: 'trailing' }],
    });

    const malformedSend = send('invalid', false);
    const trailingStart = startAgent('valid');
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `answer\n${malformedSend}\n${trailingStart}`,
    ))).toEqual({
      message: new AssistantMessage(AT, `answer\n${malformedSend}`),
      commands: [{
        type: 'start-agent',
        prompt: 'valid',
        params: [{
          ref: FIRST_REF,
          agentId: 'codex',
          providerId: null,
          endpointId: null,
          model: 'gpt-5.4',
          reasoningEffort: null,
        }],
      }],
      issues: [{ command: 'send-message', reason: 'malformed', edge: 'trailing' }],
    });
  });
});

describe('Garcon start-agent commands', () => {
  it('extracts canonical blocks from both edges and preserves document order', () => {
    const first = startAgent('first prompt', [createParams()]);
    const second = startAgent('second prompt', [createParams({
      ref: SECOND_REF,
      agent: 'claude',
      provider: 'acme',
      endpoint: 'primary',
      model: 'claude-sonnet',
      reasoningEffort: 'high',
    })]);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `${first}\nanswer\n${second}`,
    ))).toEqual({
      message: new AssistantMessage(AT, 'answer'),
      commands: [
        {
          type: 'start-agent',
          prompt: 'first prompt',
          params: [{
            ref: FIRST_REF,
            agentId: 'codex',
            providerId: null,
            endpointId: null,
            model: 'gpt-5.4',
            reasoningEffort: null,
          }],
        },
        {
          type: 'start-agent',
          prompt: 'second prompt',
          params: [{
            ref: SECOND_REF,
            agentId: 'claude',
            providerId: 'acme',
            endpointId: 'primary',
            model: 'claude-sonnet',
            reasoningEffort: 'high',
          }],
        },
      ],
      issues: [],
    });
    expect(extractGarconCommands(new AssistantMessage(AT, first))?.message).toBeNull();
  });

  it('accepts LF and CRLF structure while preserving prompt bytes', () => {
    const prompt = '\n  preserve me  \n';
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent(prompt),
    ))?.commands[0].prompt).toBe(prompt);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent('crlf prompt', [createParams()], '\r\n'),
    ))?.commands[0].prompt).toBe('crlf prompt');
  });

  it('keeps command-looking prompt text opaque', () => {
    const prompt = [
      GARCON_GET_CHAT_ID,
      send(FIRST, false),
      startAgent('nested example', [createParams({ ref: SECOND_REF })]),
      'JSON-sensitive text: "quoted" <tag> & value',
    ].join('\n');
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent(prompt),
    ))?.commands).toEqual([{
      type: 'start-agent',
      prompt,
      params: [{
        ref: FIRST_REF,
        agentId: 'codex',
        providerId: null,
        endpointId: null,
        model: 'gpt-5.4',
        reasoningEffort: null,
      }],
    }]);
  });

  it('allows the exact envelope closer in the decoded prompt', () => {
    const prompt = 'before\n</garcon-start-agent>\nafter';
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent(prompt),
    ))?.commands[0].prompt).toBe(prompt);
  });

  it('peels three stacked trailing blocks in document order', () => {
    const first = startAgent('first', [createParams()]);
    const second = startAgent('second', [createParams({ ref: SECOND_REF })]);
    const third = startAgent('third', [createParams({
      ref: '00000000-0000-0000-0000-000000000003',
    })]);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `answer\n${first}\n${second}\n${third}`,
    ))?.commands.map((command) => command.type === 'start-agent' ? command.prompt : command.type))
      .toEqual(['first', 'second', 'third']);
  });

  it('peels a valid trailing block past an earlier malformed boundary candidate', () => {
    const malformed = startAgentPayload('{"prompt":');
    const result = extractGarconCommands(new AssistantMessage(
      AT,
      `answer\n${malformed}\n${startAgent('valid trailing')}`,
    ));

    expect(result?.commands.map((command) => (
      command.type === 'start-agent' ? command.prompt : command.type
    ))).toEqual(['valid trailing']);
    expect(result?.message?.content).toBe(`answer\n${malformed}`);
    expect(result?.issues).toEqual([
      { command: 'start-agent', reason: 'malformed', edge: 'trailing' },
    ]);
  });

  it('does not reroute a nested block through its malformed outer prompt', () => {
    const malformedOuter = [
      '<garcon-start-agent>',
      '{"prompt":"outer","params":[',
      startAgent('nested'),
    ].join('\n');

    expect(extractGarconCommands(new AssistantMessage(AT, malformedOuter))).toEqual({
      message: new AssistantMessage(AT, malformedOuter),
      commands: [],
      issues: [{ command: 'start-agent', reason: 'malformed', edge: 'leading' }],
    });

    const trailing = `answer\n${malformedOuter}`;
    expect(extractGarconCommands(new AssistantMessage(AT, trailing))).toEqual({
      message: new AssistantMessage(AT, trailing),
      commands: [],
      issues: [{ command: 'start-agent', reason: 'malformed', edge: 'trailing' }],
    });
  });

  it('bounds recovery across repeated closed malformed envelopes', () => {
    const malformed = startAgentPayload('{"prompt":');
    const content = `answer\n${Array(1_000).fill(malformed).join('\n')}`;

    expect(content.length).toBeLessThan(64 * 1024);
    expect(extractGarconCommands(new AssistantMessage(AT, content))).toEqual({
      message: new AssistantMessage(AT, content),
      commands: [],
      issues: [{ command: 'start-agent', reason: 'malformed', edge: 'trailing' }],
    });
  }, 1_500);

  it('accepts 16 params and rejects zero, 17, and duplicate refs', () => {
    const params = Array.from({ length: 16 }, (_, index) => createParams({
      ref: `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`,
    }));
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent('bounded', params),
    ))?.commands[0].params).toHaveLength(16);

    for (const content of [
      startAgent('none', []),
      startAgent('too many', [...params, createParams({ ref: SECOND_REF })]),
      startAgent('duplicate', [createParams(), createParams()]),
    ]) {
      const result = extractGarconCommands(new AssistantMessage(AT, content));
      expect(result?.commands).toEqual([]);
      expect(result?.issues).toEqual([
        { command: 'start-agent', reason: 'malformed', edge: 'leading' },
      ]);
    }
  });

  it('enforces prompt and model value bounds', () => {
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent('x'.repeat(GARCON_START_PROMPT_MAX_BYTES)),
    ))?.commands).toHaveLength(1);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent('x'.repeat(GARCON_START_PROMPT_MAX_BYTES + 1)),
    ))?.issues).toHaveLength(1);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent(' ', [createParams()]),
    ))?.issues).toHaveLength(1);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent('prompt', [createParams({
        model: 'x'.repeat(GARCON_CREATE_CHAT_MODEL_MAX_BYTES + 1),
      })]),
    ))?.issues).toHaveLength(1);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent('\ud800'),
    ))?.issues).toHaveLength(1);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgent('prompt', [createParams({ model: 'model\nname' })]),
    ))?.issues).toHaveLength(1);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      startAgentPayload(
        `${' '.repeat(GARCON_START_AGENT_PAYLOAD_MAX_BYTES + 1)}`
          + JSON.stringify({ prompt: 'prompt', params: [createParams()] }),
      ),
    ))?.issues).toHaveLength(1);
  });

  it('accepts every optional JSON field combination', () => {
    const params = [
      createParams(),
      createParams({ ref: SECOND_REF, provider: 'acme' }),
      createParams({
        ref: '00000000-0000-0000-0000-000000000003',
        provider: 'acme',
        endpoint: 'primary',
      }),
      createParams({
        ref: '00000000-0000-0000-0000-000000000004',
        reasoningEffort: 'future_mode',
      }),
    ];
    const parsed = extractGarconCommands(new AssistantMessage(
      AT,
      startAgent('prompt', params),
    ));
    expect(parsed?.commands[0].params).toEqual([
      expect.objectContaining({ providerId: null, endpointId: null, reasoningEffort: null }),
      expect.objectContaining({ providerId: 'acme', endpointId: null }),
      expect.objectContaining({ providerId: 'acme', endpointId: 'primary' }),
      expect.objectContaining({ reasoningEffort: 'future_mode' }),
    ]);
  });

  it('accepts order-independent keys and JSON-safe model text', () => {
    const model = 'vendor/model"<>&';
    const content = startAgentPayload(JSON.stringify({
      params: [{
        model,
        reasoningEffort: 'low',
        agent: 'codex',
        ref: FIRST_REF,
      }],
      prompt: 'reordered fields',
    }));

    expect(extractGarconCommands(new AssistantMessage(AT, content))?.commands[0])
      .toEqual({
        type: 'start-agent',
        prompt: 'reordered fields',
        params: [{
          ref: FIRST_REF,
          agentId: 'codex',
          providerId: null,
          endpointId: null,
          model,
          reasoningEffort: 'low',
        }],
      });
  });

  it('keeps structurally malformed blocks byte-identical as assistant text', () => {
    const malformedPayloads = [
      '{"prompt":',
      "{'prompt':'prompt','params':[]}",
      '{prompt:"prompt",params:[]}',
      '{"prompt":"prompt","params":[],}',
      '{"prompt":"prompt" /* comment */,"params":[]}',
      'prompt: prompt\nparams: []',
      null,
      [],
      { prompt: 'prompt' },
      { prompt: 'prompt', params: 'not-an-array' },
      { prompt: 'prompt', params: [createParams()], extra: true },
      { prompt: 42, params: [createParams()] },
      { prompt: 'prompt', params: [null] },
      { prompt: 'prompt', params: [createParams({ ref: FIRST_REF.toUpperCase() })] },
      { prompt: 'prompt', params: [{ agent: 'codex', model: 'gpt-5.4' }] },
      { prompt: 'prompt', params: [{ ref: FIRST_REF, model: 'gpt-5.4' }] },
      { prompt: 'prompt', params: [{ ref: FIRST_REF, agent: 'codex' }] },
      { prompt: 'prompt', params: [createParams({ endpoint: 'primary' })] },
      { prompt: 'prompt', params: [{ ...createParams(), extra: 'x' }] },
      { prompt: 'prompt', params: [createParams({ agent: 'Codex' })] },
      { prompt: 'prompt', params: [createParams({ model: ' padded ' })] },
      { prompt: 'prompt', params: [createParams({ reasoningEffort: 'High' })] },
      { prompt: 'prompt', params: [{ ...createParams(), provider: null }] },
    ];
    const malformedBlocks = [
      ...malformedPayloads.map((payload) => startAgentPayload(payload)),
      '<garcon-start-agent extra>\n{}\n</garcon-start-agent>',
    ];
    for (const content of malformedBlocks) {
      const result = extractGarconCommands(new AssistantMessage(AT, content));
      expect(result?.message?.content).toBe(content);
      expect(result?.commands).toEqual([]);
      expect(result?.issues).toEqual([
        { command: 'start-agent', reason: 'malformed', edge: 'leading' },
      ]);
    }
  });

  it('recovers a valid command from the opposite edge of a malformed block', () => {
    const malformed = startAgent('prompt', [createParams({ ref: 'INVALID' })]);
    expect(extractGarconCommands(new AssistantMessage(
      AT,
      `${malformed}\nanswer\n${GARCON_GET_CHAT_ID}`,
    ))).toEqual({
      message: new AssistantMessage(AT, `${malformed}\nanswer`),
      commands: [{ type: 'get-chat-id' }],
      issues: [{ command: 'start-agent', reason: 'malformed', edge: 'leading' }],
    });
  });
});

describe('Garcon create-chat results', () => {
  it('round-trips ordered success and failure lines', () => {
    const results = [
      { ref: FIRST_REF, error: false, msg: 'created', chatId: FIRST },
      { ref: SECOND_REF, error: true, msg: 'unknown-model' },
    ];
    const content = garconCreateChatResultsContent(results);
    expect(content).toBe([
      `<garcon-create-chat-result ref="${FIRST_REF}" error="false" msg="created" chat-id="${FIRST}" />`,
      `<garcon-create-chat-result ref="${SECOND_REF}" error="true" msg="unknown-model" />`,
    ].join('\n'));
    expect(parseGarconCreateChatResults(content)).toEqual(results);
  });

  it('accepts exactly 1-16 unique result refs', () => {
    const results = Array.from({ length: 16 }, (_, index) => ({
      ref: `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`,
      error: true,
      msg: 'start-failed',
    }));
    expect(parseGarconCreateChatResults(
      garconCreateChatResultsContent(results),
    )).toEqual(results);
    expect(() => garconCreateChatResultsContent([])).toThrow();
    expect(() => garconCreateChatResultsContent([...results, {
      ref: SECOND_REF,
      error: true,
      msg: 'disabled',
    }])).toThrow();
  });

  it('rejects noncanonical or internally inconsistent result content', () => {
    const success = `<garcon-create-chat-result ref="${FIRST_REF}" error="false" msg="created" chat-id="${FIRST}" />`;
    for (const content of [
      '',
      `${success}\n`,
      `prefix\n${success}`,
      `<garcon-create-chat-result ref="${FIRST_REF}" error="false" msg="created" />`,
      `<garcon-create-chat-result ref="${FIRST_REF}" error="true" msg="created" />`,
      `<garcon-create-chat-result ref="${FIRST_REF}" error="true" msg="unknown" />`,
      `<garcon-create-chat-result ref="${FIRST_REF}" error="true" msg="disabled" chat-id="${FIRST}" />`,
      success.replace(FIRST_REF, FIRST_REF.toUpperCase()),
      `${success}\n${success}`,
    ]) {
      expect(parseGarconCreateChatResults(content)).toBeNull();
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
