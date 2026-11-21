import { Lexer } from 'marked';
import type { AutomationSignalCandidate } from '../../../common/automation.js';
import { GARCON_COMMAND_ENVELOPE_MAX_BYTES, parseGarconEnvelopeFrame } from '../../../common/garcon-command-envelope.js';
import { normalizeGarconCommandBody } from '../../../common/garcon-command-text.js';

const TAG = 'garcon-workflow-emit';
const OPEN = /^<garcon-workflow-emit(?=[\s/>]|$)/;
const CLOSE = '</garcon-workflow-emit>';
const INVALID = { kind: 'invalid', reason: 'Use a standalone workflow emit with a signal and an optional content-type of none, text, or json.' } as const;

export function workflowSignalCandidates(content: string): readonly AutomationSignalCandidate[] {
  if (!content.includes(`<${TAG}`)) return [];
  // Refuses to inspect a prefix whose Markdown block boundaries may be incomplete.
  if (Buffer.byteLength(content) > GARCON_COMMAND_ENVELOPE_MAX_BYTES) {
    return OPEN.test(content) ? [{ kind: 'invalid', reason: 'Workflow emit message is too large.' }] : [];
  }
  const candidates: AutomationSignalCandidate[] = [];
  for (const token of Lexer.lex(content)) {
    if (token.type === 'space') continue;
    if (token.type !== 'html' && token.type !== 'paragraph') return [];
    const text = token.raw.trimEnd();
    if (!OPEN.test(text)) return [];
    candidates.push(parseCandidate(text));
  }
  return candidates;
}

function parseCandidate(text: string): AutomationSignalCandidate {
  const frame = parseGarconEnvelopeFrame(text, TAG, ['signal', 'content-type']);
  if (!frame?.attributes.signal || frame.body.includes(CLOSE)) return INVALID;
  const contentType = frame.attributes['content-type'] ?? null;
  if (contentType !== null && contentType !== 'none' && contentType !== 'text' && contentType !== 'json') return INVALID;
  const body = normalizeGarconCommandBody(frame.body);
  if ((contentType === 'none' && body.trim()) || (frame.selfClosing && (contentType === 'text' || contentType === 'json'))) return INVALID;
  return { kind: 'emit', name: frame.attributes.signal, payload: { contentType, text: body } };
}
