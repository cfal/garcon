import {
  AssistantMessage,
  ErrorMessage,
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  ReadToolUseMessage,
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
  parseChatMessage,
  type ChatMessage,
  type TodoItem,
  type ToolUseChatMessage,
} from '../../common/chat-types.ts';
import type { SharedChatSnapshot } from '../../common/share-types.ts';

interface SharedTranscriptLinks {
  canonicalPath: string;
  appPath: string;
  jsonPath: string;
  plainTextPath: string;
}

interface TranscriptEntry {
  role: string;
  timestamp: string;
  content: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function summarizeTodos(todos: TodoItem[] | undefined): string {
  if (!todos || todos.length === 0) return 'No tasks recorded.';
  return todos
    .map((item) => `- [${item.status}] ${item.content}`)
    .join('\n');
}

function stringifyStructured(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatReadRange(message: ReadToolUseMessage): string | null {
  if (typeof message.offset === 'number' && typeof message.limit === 'number' && message.limit > 0) {
    const start = Math.max(1, Math.trunc(message.offset));
    const end = start + Math.max(1, Math.trunc(message.limit)) - 1;
    return `Lines ${start}-${end}`;
  }
  if (typeof message.offset === 'number' && typeof message.endLine === 'number') {
    const start = Math.max(1, Math.trunc(message.offset));
    const end = Math.max(start, Math.trunc(message.endLine));
    return `Lines ${start}-${end}`;
  }
  if (typeof message.offset === 'number') {
    return `From line ${Math.max(1, Math.trunc(message.offset))}`;
  }
  if (typeof message.limit === 'number' && message.limit > 0) {
    return `Up to ${Math.max(1, Math.trunc(message.limit))} lines`;
  }
  return null;
}

function formatToolUseMessage(message: ToolUseChatMessage): { role: string; content: string } {
  switch (message.type) {
    case 'bash-tool-use': {
      const lines = [message.description, message.command].filter(Boolean);
      return { role: 'Tool Call', content: lines.join('\n') || 'Bash command executed.' };
    }
    case 'read-tool-use': {
      const details = [`Read ${message.filePath}`];
      const range = formatReadRange(message);
      if (range) details.push(range);
      return { role: 'Tool Call', content: details.join('\n') };
    }
    case 'list-tool-use':
      return { role: 'Tool Call', content: `List directory\n${message.path || '.'}` };
    case 'edit-tool-use': {
      const lines = [`Edit ${message.filePath || 'file'}`];
      if (message.oldString || message.newString) {
        lines.push('Requested inline change.');
      }
      if (message.changes?.length) {
        lines.push(
          message.changes
            .map((change) => `- ${change.kind || 'change'} ${change.path || ''}`.trim())
            .join('\n'),
        );
      }
      return { role: 'Tool Call', content: lines.join('\n') };
    }
    case 'write-tool-use':
      return { role: 'Tool Call', content: `Write file\n${message.filePath}` };
    case 'apply-patch-tool-use':
      return { role: 'Tool Call', content: `Apply patch\n${message.filePath || 'Patch target unspecified.'}` };
    case 'grep-tool-use':
      return { role: 'Tool Call', content: `Search text\nPattern: ${message.pattern || '(missing)'}${message.path ? `\nPath: ${message.path}` : ''}` };
    case 'glob-tool-use':
      return { role: 'Tool Call', content: `Match files\nPattern: ${message.pattern || '(missing)'}${message.path ? `\nPath: ${message.path}` : ''}` };
    case 'web-search-tool-use':
      return { role: 'Tool Call', content: `Search the web\n${message.query}` };
    case 'web-fetch-tool-use':
      return { role: 'Tool Call', content: `Fetch URL\n${message.url}${message.prompt ? `\nInstruction: ${message.prompt}` : ''}` };
    case 'todo-write-tool-use':
      return { role: 'Plan Update', content: summarizeTodos(message.todos) };
    case 'todo-read-tool-use':
      return { role: 'Plan Read', content: 'Read the current task list.' };
    case 'task-tool-use': {
      const lines = ['Run subtask'];
      if (message.subagentType) lines.push(`Agent: ${message.subagentType}`);
      if (message.description) lines.push(`Description: ${message.description}`);
      if (message.prompt) lines.push(`Prompt: ${message.prompt}`);
      return { role: 'Tool Call', content: lines.join('\n') };
    }
    case 'update-plan-tool-use':
      return { role: 'Plan Update', content: summarizeTodos(message.todos) };
    case 'write-stdin-tool-use':
      return { role: 'Tool Call', content: `Write to running process\n${stringifyStructured(message.input)}` };
    case 'enter-plan-mode-tool-use':
      return { role: 'Plan Mode', content: 'Entered plan mode.' };
    case 'exit-plan-mode-tool-use':
      return { role: 'Plan Mode', content: `Exited plan mode\n${message.plan}` };
    case 'amp-finder-tool-use':
      return { role: 'Tool Call', content: `Amp finder\n${message.query || ''}`.trim() };
    case 'amp-oracle-tool-use': {
      const lines = ['Amp oracle'];
      if (message.task) lines.push(`Task: ${message.task}`);
      if (message.context) lines.push(`Context: ${message.context}`);
      if (message.files?.length) lines.push(`Files: ${message.files.join(', ')}`);
      return { role: 'Tool Call', content: lines.join('\n') };
    }
    case 'amp-librarian-tool-use': {
      const lines = ['Amp librarian'];
      if (message.query) lines.push(`Query: ${message.query}`);
      if (message.context) lines.push(`Context: ${message.context}`);
      return { role: 'Tool Call', content: lines.join('\n') };
    }
    case 'amp-skill-tool-use':
      return { role: 'Tool Call', content: `Amp skill\n${message.name || ''}`.trim() };
    case 'amp-mermaid-tool-use':
      return { role: 'Tool Call', content: 'Amp mermaid diagram tool.' };
    case 'amp-handoff-tool-use':
      return { role: 'Tool Call', content: `Amp handoff\n${message.goal || ''}`.trim() };
    case 'amp-look-at-tool-use': {
      const lines = ['Amp look-at'];
      if (message.path) lines.push(`Path: ${message.path}`);
      if (message.objective) lines.push(`Objective: ${message.objective}`);
      return { role: 'Tool Call', content: lines.join('\n') };
    }
    case 'amp-find-thread-tool-use':
      return { role: 'Tool Call', content: `Amp find thread\n${message.query || ''}`.trim() };
    case 'amp-read-thread-tool-use': {
      const lines = ['Amp read thread'];
      if (message.threadId) lines.push(`Thread: ${message.threadId}`);
      if (message.goal) lines.push(`Goal: ${message.goal}`);
      return { role: 'Tool Call', content: lines.join('\n') };
    }
    case 'amp-task-list-tool-use': {
      const lines = ['Amp task list'];
      if (message.action) lines.push(`Action: ${message.action}`);
      if (message.taskId) lines.push(`Task ID: ${message.taskId}`);
      if (message.title) lines.push(`Title: ${message.title}`);
      if (message.status) lines.push(`Status: ${message.status}`);
      return { role: 'Tool Call', content: lines.join('\n') };
    }
    case 'unknown-tool-use':
      return {
        role: 'Tool Call',
        content: `Unknown tool: ${message.rawName}\n${stringifyStructured(message.input)}`,
      };
    default:
      return { role: 'Tool Call', content: stringifyStructured(message) };
  }
}

function normalizeImages(images: UserMessage['images']): string {
  if (!images || images.length === 0) return '';
  const lines = images.map((image, index) => `- ${image.name || `image-${index + 1}`}`);
  return `\n\nAttached images:\n${lines.join('\n')}`;
}

function formatMessage(message: ChatMessage, raw: unknown): TranscriptEntry {
  if (message instanceof UserMessage) {
    return {
      role: 'User',
      timestamp: message.timestamp,
      content: `${message.content}${normalizeImages(message.images)}`.trim(),
    };
  }
  if (message instanceof AssistantMessage) {
    return { role: 'Assistant', timestamp: message.timestamp, content: message.content || '' };
  }
  if (message instanceof ThinkingMessage) {
    return { role: 'Assistant Thinking', timestamp: message.timestamp, content: message.content || '' };
  }
  if (message instanceof ToolResultMessage) {
    return {
      role: message.isError ? 'Tool Result Error' : 'Tool Result',
      timestamp: message.timestamp,
      content: stringifyStructured(message.content),
    };
  }
  if (message instanceof ErrorMessage) {
    return { role: 'Error', timestamp: message.timestamp, content: message.content || '' };
  }
  if (message instanceof PermissionRequestMessage) {
    const requested = formatToolUseMessage(message.requestedTool);
    return {
      role: 'Permission Request',
      timestamp: message.timestamp,
      content: `Requested access for ${requested.role.toLowerCase()}.\n${requested.content}`.trim(),
    };
  }
  if (message instanceof PermissionResolvedMessage) {
    return {
      role: 'Permission Response',
      timestamp: message.timestamp,
      content: message.allowed ? 'Permission granted.' : 'Permission denied.',
    };
  }
  if (message instanceof PermissionCancelledMessage) {
    return {
      role: 'Permission Response',
      timestamp: message.timestamp,
      content: `Permission request cancelled${message.reason ? `: ${message.reason}` : '.'}`,
    };
  }
  const toolSummary = formatToolUseMessage(message as ToolUseChatMessage);
  if (toolSummary.content) {
    return { role: toolSummary.role, timestamp: message.timestamp, content: toolSummary.content };
  }
  return {
    role: 'Message',
    timestamp: '',
    content: stringifyStructured(raw),
  };
}

function buildTranscriptEntries(snapshot: SharedChatSnapshot): TranscriptEntry[] {
  return (snapshot.messages ?? []).map((raw) => {
    const parsed = raw && typeof raw === 'object'
      ? parseChatMessage(raw as Record<string, unknown>)
      : null;
    if (!parsed) {
      return {
        role: 'Unknown Message',
        timestamp: '',
        content: stringifyStructured(raw),
      };
    }
    return formatMessage(parsed, raw);
  });
}

function transcriptSummary(snapshot: SharedChatSnapshot, entries: TranscriptEntry[]): string {
  const parts = [snapshot.title, ...entries.slice(0, 2).map((entry) => entry.content)]
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 220);
}

function formatMetadataLines(snapshot: SharedChatSnapshot): string[] {
  return [
    `Title: ${snapshot.title || 'Untitled Chat'}`,
    `Provider: ${snapshot.provider || 'Unknown'}`,
    `Model: ${snapshot.model || 'Unknown'}`,
    `Shared At: ${snapshot.sharedAt || ''}`,
    `Project Path: ${snapshot.projectPath || ''}`,
    '',
    'Transcript',
  ];
}

export function renderSharedChatText(snapshot: SharedChatSnapshot): string {
  const entries = buildTranscriptEntries(snapshot);
  const lines = formatMetadataLines(snapshot);

  for (const entry of entries) {
    lines.push('');
    lines.push(`[${entry.role}]${entry.timestamp ? ` ${entry.timestamp}` : ''}`);
    lines.push(entry.content || '(empty)');
  }

  return lines.join('\n');
}

export function renderSharedChatHtml(
  snapshot: SharedChatSnapshot,
  links: SharedTranscriptLinks,
): string {
  const entries = buildTranscriptEntries(snapshot);
  const summary = transcriptSummary(snapshot, entries);
  const renderedEntries = entries.map((entry) => `
      <section class="message">
        <div class="message-meta">
          <h2>${escapeHtml(entry.role)}</h2>
          ${entry.timestamp ? `<time datetime="${escapeHtml(entry.timestamp)}">${escapeHtml(entry.timestamp)}</time>` : ''}
        </div>
        <pre>${escapeHtml(entry.content || '(empty)')}</pre>
      </section>`).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(snapshot.title || 'Shared Chat')} - Garcon</title>
    <meta name="description" content="${escapeHtml(summary || 'Shared Garcon chat transcript')}">
    <link rel="canonical" href="${escapeHtml(links.canonicalPath)}">
    <link rel="alternate" type="text/plain" href="${escapeHtml(links.plainTextPath)}">
    <link rel="alternate" type="application/json" href="${escapeHtml(links.jsonPath)}">
    <style>
      :root {
        color-scheme: light dark;
        --background: #f6f7f9;
        --foreground: #111827;
        --muted: #5b6472;
        --card: rgba(255, 255, 255, 0.92);
        --border: rgba(15, 23, 42, 0.12);
        --accent: #0f766e;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #0b1020;
          --foreground: #eef2ff;
          --muted: #9aa4b2;
          --card: rgba(15, 23, 42, 0.9);
          --border: rgba(148, 163, 184, 0.24);
          --accent: #5eead4;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background:
          radial-gradient(circle at top, rgba(94, 234, 212, 0.14), transparent 32%),
          var(--background);
        color: var(--foreground);
      }
      main {
        width: min(960px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }
      .hero, .message {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 18px;
      }
      .hero {
        padding: 24px;
        margin-bottom: 20px;
        backdrop-filter: blur(12px);
      }
      .eyebrow {
        color: var(--accent);
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 10px 0 6px;
        font-size: clamp(1.8rem, 4vw, 2.7rem);
        line-height: 1.05;
      }
      .summary {
        margin: 0;
        color: var(--muted);
        max-width: 70ch;
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin: 20px 0;
      }
      .meta-card {
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: rgba(127, 127, 127, 0.06);
      }
      .meta-card dt {
        margin: 0 0 4px;
        color: var(--muted);
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .meta-card dd {
        margin: 0;
        font-weight: 600;
        word-break: break-word;
      }
      nav {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 18px;
      }
      nav a {
        color: inherit;
        text-decoration: none;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 10px 14px;
      }
      nav a.primary {
        background: var(--accent);
        border-color: transparent;
        color: #042f2e;
        font-weight: 700;
      }
      .messages {
        display: grid;
        gap: 14px;
      }
      .message {
        padding: 18px;
      }
      .message-meta {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 8px 16px;
        align-items: baseline;
        margin-bottom: 12px;
      }
      .message-meta h2 {
        margin: 0;
        font-size: 1rem;
      }
      .message-meta time {
        color: var(--muted);
        font-size: 0.9rem;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, monospace;
        line-height: 1.55;
      }
      footer {
        margin-top: 18px;
        color: var(--muted);
        font-size: 0.92rem;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="eyebrow">Garcon Shared Thread</div>
        <h1>${escapeHtml(snapshot.title || 'Untitled Chat')}</h1>
        <p class="summary">${escapeHtml(summary || 'Public transcript of a Garcon conversation.')}</p>
        <dl class="meta-grid">
          <div class="meta-card">
            <dt>Provider</dt>
            <dd>${escapeHtml(snapshot.provider || 'Unknown')}</dd>
          </div>
          <div class="meta-card">
            <dt>Model</dt>
            <dd>${escapeHtml(snapshot.model || 'Unknown')}</dd>
          </div>
          <div class="meta-card">
            <dt>Shared At</dt>
            <dd>${escapeHtml(snapshot.sharedAt || '')}</dd>
          </div>
          <div class="meta-card">
            <dt>Project Path</dt>
            <dd>${escapeHtml(snapshot.projectPath || '')}</dd>
          </div>
        </dl>
        <nav aria-label="Shared chat formats">
          <a class="primary" href="${escapeHtml(links.appPath)}">Open interactive view</a>
          <a href="${escapeHtml(links.plainTextPath)}">Plain text transcript</a>
          <a href="${escapeHtml(links.jsonPath)}">JSON snapshot</a>
        </nav>
      </section>
      <section class="messages" aria-label="Transcript">
${renderedEntries}
      </section>
      <footer>Shared via Garcon. This page includes the transcript in the initial HTML so readers and crawlers can inspect it without JavaScript.</footer>
    </main>
  </body>
</html>`;
}
