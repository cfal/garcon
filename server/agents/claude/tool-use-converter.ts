// Converts Claude CLI wire payloads directly into concrete
// ToolUseMessage subclasses. Owns all Claude-specific field extraction.

import {
  BashToolUseMessage,
  ReadToolUseMessage,
  EditToolUseMessage,
  WriteToolUseMessage,
  ApplyPatchToolUseMessage,
  GrepToolUseMessage,
  GlobToolUseMessage,
  WebSearchToolUseMessage,
  WebFetchToolUseMessage,
  TodoWriteToolUseMessage,
  TodoReadToolUseMessage,
  TaskToolUseMessage,
  UpdatePlanToolUseMessage,
  WriteStdinToolUseMessage,
  EnterPlanModeToolUseMessage,
  ExitPlanModeToolUseMessage,
  AskUserQuestionToolUseMessage,
  UnknownToolUseMessage,
  type AskUserQuestionPrompt,
  type ToolUseChatMessage,
} from '../../../common/chat-types.js';
import { normalizeTodoItems } from '../shared/normalize-util.js';

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

// Preserves non-object payloads as { raw: value } for the Unknown fallback,
// matching the behavior of normalizeToolInput for history data.
function asInput(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined || v === '') return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return { raw: v };
    } catch {
      return { raw: v };
    }
  }
  return {};
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asChanges(v: unknown): Array<{ path?: string; kind?: string }> | undefined {
  return Array.isArray(v) ? v as Array<{ path?: string; kind?: string }> : undefined;
}

function claudeAskUserQuestions(v: unknown): AskUserQuestionPrompt[] {
  if (!Array.isArray(v)) return [];
  const questions: AskUserQuestionPrompt[] = [];
  for (const entry of v) {
    const raw = asObject(entry);
    const questionText = asString(raw.question);
    if (!questionText) continue;

    const options: AskUserQuestionPrompt['options'] = [];
    if (Array.isArray(raw.options)) {
      for (const rawOption of raw.options) {
        const option = asObject(rawOption);
        const label = asString(option.label);
        if (!label) continue;
        options.push({
          id: label,
          label,
          description: asString(option.description),
          preview: asString(option.preview),
        });
      }
    }

    const question: AskUserQuestionPrompt = {
      id: questionText,
      prompt: questionText,
      options,
      allowMultiple: asBoolean(raw.multiSelect),
    };
    const header = asString(raw.header);
    if (header) question.header = header;
    questions.push(question);
  }
  return questions;
}

// Resolves Claude tool name to a canonical key for dispatch.
// Claude tools use PascalCase or snake_case names.
function canonicalize(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

/**
 * Converts a Claude CLI tool_use part to a concrete ToolUseMessage.
 * Returns UnknownToolUseMessage for unrecognized or malformed payloads.
 */
export function convertClaudeToolUse(ts: string, part: unknown): ToolUseChatMessage {
  const rawPart = asObject(part);
  const rawName = typeof rawPart.name === 'string' ? rawPart.name : 'Unknown';
  const toolId = typeof rawPart.id === 'string' ? rawPart.id : '';
  const input = asObject(rawPart.input);
  const key = canonicalize(rawName);

  switch (key) {
    case 'bash':
    case 'shellcommand':
    case 'execcommand': {
      const command = asString(input.command);
      if (command === undefined) break;
      return new BashToolUseMessage(ts, toolId, command, asString(input.description));
    }

    case 'read': {
      const filePath = asString(input.file_path ?? input.filePath ?? input.path);
      if (filePath === undefined) break;
      return new ReadToolUseMessage(ts, toolId, filePath,
        asNumber(input.offset ?? input.start_line ?? input.startLine),
        asNumber(input.limit ?? input.num_lines ?? input.numLines),
        asNumber(input.end_line ?? input.endLine));
    }

    case 'edit':
      return new EditToolUseMessage(ts, toolId,
        asString(input.file_path ?? input.filePath),
        asString(input.old_string ?? input.oldString),
        asString(input.new_string ?? input.newString),
        asChanges(input.changes));

    case 'write': {
      const filePath = asString(input.file_path ?? input.filePath);
      if (filePath === undefined) break;
      return new WriteToolUseMessage(ts, toolId, filePath, asString(input.content));
    }

    case 'applypatch':
      return new ApplyPatchToolUseMessage(ts, toolId,
        asString(input.file_path ?? input.filePath),
        asString(input.old_string ?? input.oldString),
        asString(input.new_string ?? input.newString));

    case 'grep':
      return new GrepToolUseMessage(ts, toolId,
        asString(input.pattern), asString(input.path));

    case 'glob':
      return new GlobToolUseMessage(ts, toolId,
        asString(input.pattern), asString(input.path));

    case 'websearch': {
      const query = asString(input.query);
      if (query === undefined) break;
      return new WebSearchToolUseMessage(ts, toolId, query);
    }

    case 'webfetch': {
      const url = asString(input.url);
      if (url === undefined) break;
      return new WebFetchToolUseMessage(ts, toolId, url, asString(input.prompt));
    }

    case 'todowrite':
      return new TodoWriteToolUseMessage(ts, toolId, normalizeTodoItems(input.todos ?? input.items));

    case 'todoread':
      return new TodoReadToolUseMessage(ts, toolId);

    case 'task':
      return new TaskToolUseMessage(ts, toolId,
        asString(input.subagent_type ?? input.subagentType),
        asString(input.description),
        asString(input.prompt),
        asString(input.model),
        asString(input.resume));

    case 'updateplan':
      return new UpdatePlanToolUseMessage(ts, toolId, normalizeTodoItems(input.items ?? input.todos));

    case 'writestdin':
      return new WriteStdinToolUseMessage(ts, toolId, input);

    case 'enterplanmode':
    case 'planenter':
      return new EnterPlanModeToolUseMessage(ts, toolId);

    case 'exitplanmode':
    case 'exitplan':
    case 'planexit': {
      const plan = asString(input.plan);
      if (plan === undefined) break;
      return new ExitPlanModeToolUseMessage(ts, toolId, plan,
        Array.isArray(input.allowedPrompts) ? input.allowedPrompts : undefined);
    }

    case 'askuserquestion': {
      const questions = claudeAskUserQuestions(input.questions);
      if (questions.length === 0) break;
      return new AskUserQuestionToolUseMessage(ts, toolId, asString(input.title), questions);
    }
  }

  return new UnknownToolUseMessage(ts, toolId, rawName, asInput(rawPart.input));
}
