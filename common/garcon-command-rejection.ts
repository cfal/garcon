import { escapeGarconXmlText, parseGarconCommandEnvelope, GARCON_ENVELOPE_COMMANDS } from './garcon-command-envelope.js';
import type { GarconCommandIssue } from './garcon-commands.js';
import { isRecord } from './json.js';

export interface GarconCommandRejection {
  readonly sourceViewId: string;
  readonly sourceOrdinal: number;
  readonly issues: readonly GarconCommandIssue[];
  readonly message: string;
}

export const TICKET_COMMAND_REJECTION_GUIDANCE =
  'Check required ticket attributes, field values, and valid JSON where required. '
  + 'For JSON bodies, serialize the JSON first, then XML-escape the body once: & -> &amp;, < -> &lt;, > -> &gt;. '
  + 'Keep the outer command tags unchanged. For example, <T> becomes &lt;T&gt; and && becomes &amp;&amp;.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROMPT_GUIDANCE = 'Use a ref matching [A-Za-z0-9][A-Za-z0-9._-]{0,63}, lowercase true/false flags, '
  + 'and a nonblank literal prompt of at most 48 KiB in an envelope of at most 64 KiB. '
  + 'Do not XML-escape the prompt. Balance Garcon command tags and complete comments (<!-- -->), '
  + 'CDATA (<![CDATA[ ]]>), and processing instructions (<? ?>). Do not embed an unmatched outer closing tag. '
  + 'Keep Garcon tags balanced in subsequent commands in the same message.';

export function garconCommandIssueGuidance(command: GarconCommandIssue['command']): string {
  switch (command) {
    case 'start-agent':
      return `Check double-quoted start attributes; selecting agent or provider requires model. ${PROMPT_GUIDANCE}`;
    case 'resume-agent':
      return `Only ref, a 16-digit chat-id, and optional async are allowed. ${PROMPT_GUIDANCE}`;
    case 'stop-agent':
      return 'Use a self-closing command with a 16-digit chat-id and optional remove="true|false"; no body or other attributes.';
    case 'send-message':
      return 'Use double-quoted to then hide-sender="true|false", 1-16 unique 16-digit recipients, '
        + 'and a nonblank literal body of at most 60 KiB. Do not XML-escape the body.';
    case 'schedule':
      return 'Check schedule attributes and minute-aligned dates or ordered whole d/h/m durations. '
        + 'XML-escape & and < in body text and use lowercase busy="queue|skip".';
    default:
      return TICKET_COMMAND_REJECTION_GUIDANCE;
  }
}

export function garconCommandRejectionGuidance(issues: readonly GarconCommandIssue[]): string {
  const guidance = new Set(issues.map((issue) => garconCommandIssueGuidance(issue.command)));
  return 'These command candidates were rejected before execution. '
    + [...guidance].join(' ')
    + ' Retry only the rejected commands; independently valid commands may already have executed.';
}

export function garconCommandRejectionNotice(issue: GarconCommandIssue): string {
  return `Garcon could not parse a ${issue.command} command. Not executed. ${garconCommandIssueGuidance(issue.command)}`;
}

export function garconCommandRejectionContent(rejection: GarconCommandRejection): string {
  return `<garcon-command-rejected>\n${escapeGarconXmlText(JSON.stringify(rejection))}\n</garcon-command-rejected>`;
}

export function parseGarconCommandRejection(content: string): GarconCommandRejection | null {
  const envelope = parseGarconCommandEnvelope(content.trim(), 'garcon-command-rejected', []);
  if (!envelope || envelope.selfClosing) return null;
  try {
    const raw: unknown = JSON.parse(envelope.body);
    if (!isRecord(raw) || Object.keys(raw).some((key) => !['sourceViewId', 'sourceOrdinal', 'issues', 'message'].includes(key))) return null;
    const { sourceViewId, sourceOrdinal, message, issues: rawIssues } = raw;
    if (typeof sourceViewId !== 'string' || !UUID.test(sourceViewId)) return null;
    if (typeof sourceOrdinal !== 'number' || !Number.isSafeInteger(sourceOrdinal) || sourceOrdinal < 1) return null;
    if (typeof message !== 'string' || !message.trim() || !message.isWellFormed()) return null;
    if (new TextEncoder().encode(message).byteLength > 2048) return null;
    // Edge extraction reports at most one rejected candidate at each end.
    if (!Array.isArray(rawIssues) || rawIssues.length < 1 || rawIssues.length > 2) return null;
    const issues: GarconCommandIssue[] = [];
    for (const issue of rawIssues) {
      if (!isRecord(issue) || Object.keys(issue).some((key) => !['command', 'reason', 'edge'].includes(key))) return null;
      const command = GARCON_ENVELOPE_COMMANDS.find((candidate) => candidate === issue.command);
      if (!command || issue.reason !== 'malformed') return null;
      if (issue.edge !== 'leading' && issue.edge !== 'trailing') return null;
      issues.push({ command, reason: issue.reason, edge: issue.edge });
    }
    return { sourceViewId, sourceOrdinal, issues, message };
  } catch {
    return null;
  }
}
