import { describe, expect, it } from 'bun:test';
import { boundAgentChildResult, agentChildOutcomeContent, GARCON_AGENT_OUTPUT_MAX_BYTES } from '../garcon-agent-result.ts';
import { garconCommandResultContent, parseGarconCommandResult, parseAgentCommandOutcome } from '../garcon-command-results.ts';
import { parseTranscriptNoticeDetail } from '../transcript-notice-details.ts';

const base = { ref: 'Review.1', async: false, requestViewId: '00000000-0000-4000-8000-000000000001', requestOrdinal: 3 };
const chatId = '1111111111111111';
const available = (text = 'A & B < C\n\nExact answer.\n') => ({ availability: 'available', completeness: 'complete', text });
const terminals = [
  { status: 'completed', chatId, output: available() },
  { status: 'completed', chatId, output: available('') },
  { status: 'failed', chatId, errorCode: 'INTERNAL_ERROR', output: { ...available(), completeness: 'best-effort' } },
  { status: 'interrupted', chatId, reason: 'user-stop', output: available('partial') },
  { status: 'interrupted', chatId, reason: 'chat-deleted', output: { availability: 'unavailable', reason: 'retention-pressure' } },
  { status: 'result-unavailable', chatId, reason: 'receipt-unavailable' },
  { status: 'result-unavailable', chatId, reason: 'receipt-expired' },
];

for (const type of ['agent-start-outcome', 'agent-resume-outcome']) {
  describe(type, () => {
    it('round-trips the full admission and terminal matrix without a turn ID', () => {
      for (const outcome of [
        { status: 'accepted', chatId }, { status: 'accepted', chatId, async: true },
        { status: 'rejected', reason: 'not-delegated' }, { status: 'rejected', reason: 'busy', chatId },
        { status: 'preamble-rejected', reason: 'composition-invalid', chatId },
        { status: 'preamble-rejected', reason: 'slash-command-blocked', chatId },
        { status: 'outcome-unknown' }, { status: 'outcome-unknown', chatId }, ...terminals,
      ]) {
        const detail = { type, ...base, ...outcome };
        expect(parseTranscriptNoticeDetail(detail)).toEqual(detail);
        const xml = garconCommandResultContent(detail);
        expect(parseGarconCommandResult(xml)).toEqual(detail);
        expect(xml).not.toContain('turn-id');
        expect(xml).not.toContain('nativeResultInput');
      }
    });

    it('rejects cross-status, unknown, missing and private fields in JSON and XML', () => {
      const valid = { type, ...base, ...terminals[0] };
      for (const detail of [
        ...terminals.map((outcome) => ({ type, ...base, ...outcome, async: true })),
        ...['ref', 'async', 'requestViewId', 'requestOrdinal', 'chatId', 'output'].map((key) => ({ ...valid, [key]: undefined })),
        { ...valid, turnId: 'private' }, { ...valid, nativeResultInput: true }, { ...valid, title: 'private' },
        { ...valid, status: 'accepted' }, { ...valid, reason: 'receipt-expired' },
        { ...valid, status: 'failed', errorCode: 'arbitrary-error' }, { ...valid, errorCode: 'INTERNAL_ERROR' },
        { ...valid, output: { ...available(), reason: 'too-large' } },
        { ...valid, output: { availability: 'unavailable', reason: 'too-large', completeness: 'complete' } },
        { ...valid, output: available('\ud800') }, { ...valid, output: available('\0') },
        { ...valid, output: available('x'.repeat(GARCON_AGENT_OUTPUT_MAX_BYTES + 1)) },
      ]) expect(parseAgentCommandOutcome(detail)).toBeNull();
      const xml = garconCommandResultContent(valid);
      for (const content of [
        `Prefix ${xml}`, `${xml} suffix`, xml.replace('async="false"', 'async="TRUE"'),
        xml.replace('status="completed"', 'status="accepted"'), xml.replace('output="available"', 'output="unavailable"'),
        xml.replace('output="available"', 'output="available" output-reason="too-large"'),
        xml.replace('ref="Review.1"', 'ref="Review.1" ref="Review.1"'),
        xml.replace('&amp;', '&#38;'), xml.replace('&lt;', '<nested>'),
        xml.replace('request-ordinal="3"', 'request-ordinal="03"'),
      ]) expect(parseGarconCommandResult(content)).toBeNull();
    });

    it('preserves text framing and single entity decoding', () => {
      for (const text of ['', '\n  one\n\ntwo  \n', '\r\nraw\r\n', 'answer\r', 'answer\r\r',
        '\ranswer', '\nanswer\r', '\r\nanswer\r\n\r', '\n\nanswer\n\n', '&lt; <garcon-start-agent />', '𐐀']) {
        const detail = { type, ...base, status: 'completed', chatId, output: available(text) };
        expect(parseGarconCommandResult(garconCommandResultContent(detail))).toEqual(detail);
      }
    });

    it('bounds decoded bytes and escaped expansion before building decoded notice content', () => {
      const detail = { type, ...base, status: 'completed', chatId, output: available('x'.repeat(GARCON_AGENT_OUTPUT_MAX_BYTES)) };
      expect(boundAgentChildResult(detail)).toEqual(detail);
      expect(agentChildOutcomeContent(detail)).toContain(detail.output.text);
      expect(parseGarconCommandResult(garconCommandResultContent(detail))).toEqual(detail);
      for (const [text, reason] of [
        ['x'.repeat(GARCON_AGENT_OUTPUT_MAX_BYTES + 1), 'too-large'],
        ['é'.repeat(GARCON_AGENT_OUTPUT_MAX_BYTES), 'too-large'],
        ['&'.repeat(GARCON_AGENT_OUTPUT_MAX_BYTES), 'too-large'],
        ['\0', 'invalid-text'], ['\ud800', 'invalid-text'],
      ]) {
        const bounded = boundAgentChildResult({ ...detail, output: available(text) });
        expect(bounded.output).toEqual({ availability: 'unavailable', reason });
        expect(parseGarconCommandResult(garconCommandResultContent(bounded))).toEqual(bounded);
        expect(agentChildOutcomeContent(bounded).length).toBeLessThan(1024);
      }
    });
  });
}
