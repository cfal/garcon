import type { AutomationSignalCandidate } from '../../../common/automation.js';
import {
  GARCON_COMMAND_ENVELOPE_MAX_BYTES, garconEnvelopeOpenerEnd, parseGarconEnvelopeFrame,
} from '../../../common/garcon-command-envelope.js';
import { normalizeGarconCommandBody } from '../../../common/garcon-command-text.js';

const TAG = 'garcon-workflow-emit';
const OPEN = /<garcon-workflow-emit(?=[\s/>]|$)/u;
const CLOSE = '</garcon-workflow-emit>';
const INVALID = { kind: 'invalid', reason: 'Use a standalone workflow emit with a signal and an optional content-type of none, text, or json.' } as const;

export function workflowSignalCandidates(content: string): readonly AutomationSignalCandidate[] {
  let start = content.search(OPEN);
  if (start < 0 || (start > 0 && !/^(?:[ \t]*\r?\n)*$/u.test(content.slice(0, start)))) return [];
  if (content.length > GARCON_COMMAND_ENVELOPE_MAX_BYTES || Buffer.byteLength(content) > GARCON_COMMAND_ENVELOPE_MAX_BYTES) {
    return [{ kind: 'invalid', reason: 'Workflow emit message is too large.' }];
  }
  const text = content.trimEnd();
  const separator = /(?:[ \t]*\r?\n){2,}/y;
  const candidates: AutomationSignalCandidate[] = [];
  for (;;) {
    const openerEnd = garconEnvelopeOpenerEnd(text, start);
    if (openerEnd < 0) return [INVALID];
    let end = openerEnd;
    if (text[openerEnd - 2] !== '/') {
      const close = text.indexOf(CLOSE, openerEnd);
      if (close < 0) return [INVALID];
      end = close + CLOSE.length;
    }
    candidates.push(parseCandidate(text.slice(start, end)));
    if (end === text.length) return candidates;
    // Blank lines inside the raw body are data; only a gap between complete frames separates emits.
    separator.lastIndex = end;
    if (!separator.test(text) || text.slice(separator.lastIndex).search(OPEN) !== 0) {
      const rest = text.slice(end);
      return rest.endsWith(CLOSE) && !OPEN.test(rest) ? [INVALID] : [];
    }
    start = separator.lastIndex;
  }
}

function parseCandidate(text: string): AutomationSignalCandidate {
  const frame = parseGarconEnvelopeFrame(text, TAG, ['signal', 'content-type']);
  if (!frame?.attributes.signal || OPEN.test(frame.body)) return INVALID;
  const contentType = frame.attributes['content-type'] ?? null;
  if (contentType !== null && contentType !== 'none' && contentType !== 'text' && contentType !== 'json') return INVALID;
  const body = normalizeGarconCommandBody(frame.body);
  if ((contentType === 'none' && body.trim()) || (frame.selfClosing && (contentType === 'text' || contentType === 'json'))) return INVALID;
  return { kind: 'emit', name: frame.attributes.signal, payload: { contentType, text: body } };
}
