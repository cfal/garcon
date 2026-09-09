import { describe, expect, it } from 'bun:test';
import { AssistantMessage } from '../chat-types.ts';
import { extractGarconCommands } from '../garcon-commands.ts';
import { parseGarconStopAgent } from '../garcon-stop-agent.ts';

const CHAT = '2000000000000000';
const STOP = `<garcon-stop-agent chat-id="${CHAT}" />`;
const transform = (text) => extractGarconCommands(new AssistantMessage('', text));

describe('stop agent command', () => {
  it.each(['', ' remove="false"', ' remove="true"'])('parses literal removal selection: %s', (attribute) => {
    expect(parseGarconStopAgent(`<garcon-stop-agent chat-id="${CHAT}"${attribute} />`)).toEqual({
      type: 'stop-agent', chatId: CHAT, remove: attribute === ' remove="true"',
    });
  });

  it.each([
    '<garcon-stop-agent />', '<garcon-stop-agent chat-id="invalid" />',
    `<garcon-stop-agent chat-id="${CHAT}" chat-id="${CHAT}" />`,
    ...['True', 'FALSE', '1', '0', ' false ', ''].map((value) => `<garcon-stop-agent chat-id="${CHAT}" remove="${value}" />`),
    ...['ref="stop"', 'async="true"', 'unknown="value"'].map((attribute) => `<garcon-stop-agent chat-id="${CHAT}" ${attribute} />`),
    `<garcon-stop-agent chat-id="${CHAT}"></garcon-stop-agent>`,
    `<garcon-stop-agent chat-id="${CHAT}">body</garcon-stop-agent>`,
    `<garcon-stop-agent chat-id="${CHAT}"`,
  ])('rejects malformed stop: %s', (text) => {
    expect(parseGarconStopAgent(text)).toBeNull();
    for (const content of [text, `Retained\n${text}`]) {
      expect(transform(content)?.commands ?? []).toEqual([]);
      expect(transform(content)?.issues).toEqual([{ command: 'stop-agent', reason: 'malformed',
        edge: content === text ? 'leading' : 'trailing' }]);
      expect(transform(content)?.message?.content).toBe(content);
    }
  });

  it('extracts mixed edge commands in source order and preserves retained text', () => {
    const text = `${STOP}\n<garcon-get-chat-id />\nRetained\n<garcon-stop-agent chat-id="${CHAT}" remove="true" />`;
    expect(transform(text)?.commands.map((command) => command.type)).toEqual(['stop-agent', 'get-chat-id', 'stop-agent']);
    expect(transform(text)?.message?.content).toBe('Retained');
    expect(transform(`${STOP}\n\n`)).toMatchObject({ message: null, commands: [{ type: 'stop-agent', remove: false }] });
  });

  it.each([
    `Text\n${STOP}\nMore text`, `\`\`\`xml\n${STOP}\n\`\`\``,
    `<garcon-resume-agent ref="nested" chat-id="${CHAT}">\n${STOP}\n</garcon-resume-agent>`,
  ])('does not execute nested or non-edge commands: %s', (text) => {
    expect(transform(text)?.commands ?? []).toEqual([]);
  });
});
