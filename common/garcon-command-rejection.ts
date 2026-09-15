import { escapeGarconXmlText, parseGarconCommandEnvelope, GARCON_ENVELOPE_COMMANDS } from './garcon-command-envelope.js';
import type { GarconCommandIssue } from './garcon-commands.js';
import { isRecord } from './json.js';

export interface GarconCommandRejection {
  readonly issues: readonly GarconCommandIssue[];
  readonly message: string;
}

export const TICKET_COMMAND_REJECTION_GUIDANCE =
  'These ticket command candidates were rejected before execution. Check required attributes, field values, and valid JSON where required. '
  + 'For JSON bodies, serialize the JSON first, then XML-escape the body once: & -> &amp;, < -> &lt;, > -> &gt;. '
  + 'Keep the outer command tags unchanged. For example, <T> becomes &lt;T&gt; and && becomes &amp;&amp;. '
  + 'Retry only the rejected commands; independently valid commands may already have executed.';

export function garconCommandRejectionContent(rejection: GarconCommandRejection): string {
  return `<garcon-command-rejected>\n${escapeGarconXmlText(JSON.stringify(rejection))}\n</garcon-command-rejected>`;
}

export function parseGarconCommandRejection(content: string): GarconCommandRejection | null {
  const envelope = parseGarconCommandEnvelope(content.trim(), 'garcon-command-rejected', []);
  if (!envelope || envelope.selfClosing) return null;
  try {
    const raw: unknown = JSON.parse(envelope.body);
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== 'issues' && key !== 'message')) return null;
    if (typeof raw.message !== 'string' || !raw.message.trim() || !raw.message.isWellFormed()
      || new TextEncoder().encode(raw.message).byteLength > 2048) return null;
    // Edge extraction reports at most one rejected candidate at each end.
    if (!Array.isArray(raw.issues) || raw.issues.length < 1 || raw.issues.length > 2) return null;
    const issues: GarconCommandIssue[] = [];
    for (const issue of raw.issues) {
      if (!isRecord(issue) || Object.keys(issue).some((key) => !['command', 'reason', 'edge'].includes(key))
        || !GARCON_ENVELOPE_COMMANDS.includes(issue.command as GarconCommandIssue['command'])
        || issue.reason !== 'malformed' || (issue.edge !== 'leading' && issue.edge !== 'trailing')) return null;
      issues.push({ command: issue.command as GarconCommandIssue['command'], reason: issue.reason, edge: issue.edge });
    }
    return { issues, message: raw.message };
  } catch {
    return null;
  }
}
