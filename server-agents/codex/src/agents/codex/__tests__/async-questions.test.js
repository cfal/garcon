import { describe, expect, it } from 'bun:test';
import { asyncQuestionReplyText } from '@garcon/common/async-user-questions';
import { FILE_CONTEXT_SEPARATOR } from '@garcon/common/file-mention-context';
import { codexAsyncQuestions, codexQuestionReplyInput, codexHistoricalQuestionReply } from '../async-questions.js';
import { convertCodexAppServerItem, convertCodexRawCodeModeItem } from '../app-server/converter.js';
import { normalizeCodexJsonlEntry } from '../history-normalizer.js';

const timestamp = '2026-01-01T00:00:00Z';
const questions = [{ title: 'Which environment?', options: ['Staging', 'Production'] }, { title: 'Deadline?', options: null }];
const native = { type: 'agentMessage', id: 'call-async', text: 'Which environment?\n- Staging\n- Production\n\nDeadline?', phase: 'final_answer', delivery: 'async', questions };
const reply = { questionId: '["request_user_input_async","call-async",0]', question: questions[0].title, answer: ' Staging\nOnly tests. ' };

describe('Codex asynchronous questions', () => {
  it('normalizes structured questions as an assistant, never as a tool or permission', () => {
    const result = convertCodexAppServerItem(native, timestamp);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'assistant-message', content: native.text, questions: {
      id: native.id, questions: [{ id: reply.questionId, prompt: questions[0].title, allowFreeText: true, options: [{ id: 'option-0', label: 'Staging' }, { id: 'option-1', label: 'Production' }] },
        { id: '["request_user_input_async","call-async",1]', prompt: 'Deadline?', options: [], allowFreeText: true }],
    } });
    expect(convertCodexRawCodeModeItem({ type: 'function_call', name: 'request_user_input_async', call_id: native.id, arguments: '{}' }, timestamp, new Map())).toEqual([]);
    expect(convertCodexRawCodeModeItem({ type: 'function_call_output', call_id: native.id, output: '{"accepted":true}' }, timestamp, new Map())).toEqual([]);
  });
  it('preserves fallback text for malformed, non-async, or oversized structured data', () => {
    const malformed = [
      null,
      {},
      [],
      [null],
      [{ title: '' }],
      [{ title: 'Question', options: [] }],
      [{ title: 'Question', options: 'Staging' }],
      [{ title: 'Question', options: [3] }],
      [{ title: 'Question', options: Array(101).fill('Staging') }],
      Array(101).fill(questions[0]),
    ];
    for (const value of malformed) {
      expect(codexAsyncQuestions('call', 'async', value)).toBeUndefined();
      expect(convertCodexAppServerItem({ ...native, questions: value }, timestamp)[0].content).toBe(native.text);
    }
    expect(codexAsyncQuestions('call', undefined, questions)).toBeUndefined();
  });
  it('accepts omitted or null suggestions but retains the full supported suggestion set', () => {
    for (const options of [undefined, null]) {
      expect(codexAsyncQuestions('call', 'async', [{ title: 'Question', options }])?.questions[0].options).toEqual([]);
    }
    const options = Array.from({ length: 100 }, (_, index) => `Suggestion ${index}`);
    expect(codexAsyncQuestions('call', 'async', [{ title: 'Question', options }])?.questions[0].options)
      .toEqual(options.map((label, index) => ({ id: `option-${index}`, label })));
  });
  it('formats native ordinary input without losing composed prefix or file context', () => {
    const text = asyncQuestionReplyText(reply);
    const output = codexQuestionReplyInput(`prefix\n${text}\nsuffix`, reply);
    expect(output).toBe(`prefix\n<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: reply.questionId, question: reply.question, answer: reply.answer }])}\n</send_user_message_question_reply>\nsuffix`);
    expect(() => codexQuestionReplyInput('unrelated', reply)).toThrow();
    const oversized = { ...reply, questionId: 'x'.repeat(513) };
    expect(codexQuestionReplyInput(text, oversized)).toBe(text);
  });
  it('reconstructs only exact native replies and retains original answer whitespace', () => {
    const input = codexQuestionReplyInput(asyncQuestionReplyText(reply), reply);
    expect(codexHistoricalQuestionReply(timestamp, input, 'client-1')).toMatchObject({
      type: 'user-message', content: asyncQuestionReplyText(reply), metadata: { questionReply: reply, upstreamRequestId: 'client-1' },
    });
    expect(codexHistoricalQuestionReply(timestamp, `prose\n${input}`)).toBeNull();
    expect(codexHistoricalQuestionReply(timestamp, '<send_user_message_question_reply>not JSON</send_user_message_question_reply>')).toBeNull();
    expect(normalizeCodexJsonlEntry({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: input } }, {}).canonical[0].metadata.questionReply).toEqual(reply);
  });
  it('never replaces a matching passage inside appended file context', () => {
    const answer = { ...reply, answer: 'Use @sample.txt' };
    const text = asyncQuestionReplyText(answer);
    const suffix = `${FILE_CONTEXT_SEPARATOR}sample.txt\n${text}`;
    const framed = codexQuestionReplyInput(text, answer);
    expect(codexQuestionReplyInput(`prior input\n${text}${suffix}`, answer))
      .toBe(`prior input\n${framed}${suffix}`);
  });
  it('keeps readable input when an authored file separator makes framing ambiguous', () => {
    const answer = { ...reply, answer: `Literal separator:${FILE_CONTEXT_SEPARATOR}keep this text` };
    const content = asyncQuestionReplyText(answer);
    expect(codexQuestionReplyInput(content, answer)).toBe(content);
  });
  it('keeps object replies, multi-answer text, and malformed-batch fallback distinct', () => {
    const nativeReply = { questionItemId: reply.questionId, question: reply.question, answer: reply.answer };
    const envelope = value => `<send_user_message_question_reply>${JSON.stringify(value)}</send_user_message_question_reply>`;
    expect(codexHistoricalQuestionReply(timestamp, envelope(nativeReply))?.metadata?.questionReply).toEqual(reply);

    const batch = codexHistoricalQuestionReply(timestamp, envelope([nativeReply, nativeReply]));
    expect(batch?.content).toBe([asyncQuestionReplyText(reply), asyncQuestionReplyText(reply)].join('\n\n'));
    expect(batch?.metadata?.questionReply).toBeUndefined();
    for (const invalid of [[], [nativeReply, null], [nativeReply, { ...nativeReply, answer: '' }]]) {
      expect(codexHistoricalQuestionReply(timestamp, envelope(invalid))).toBeNull();
    }
  });
  it('limits native question context on UTF-8 boundaries', () => {
    const long = { ...reply, question: 'Q\n' + '\u00e9'.repeat(300) };
    const output = codexQuestionReplyInput(asyncQuestionReplyText(long), long);
    const parsed = JSON.parse(output.split('\n')[1])[0];
    expect(Buffer.byteLength(parsed.question)).toBe(512);
    expect(parsed.question).not.toContain('\n');
    expect(parsed.answer).toBe(reply.answer);
  });
});
