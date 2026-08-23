// Converts OpenCode SDK wire payloads directly into concrete
// ToolUseMessage subclasses. Owns all OpenCode-specific field extraction.

import {
  AskUserQuestionToolUseMessage,
  BashToolUseMessage,
  ExecToolUseMessage,
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
  ExternalToolUseMessage,
  UnknownToolUseMessage,
  type ToolUseChatMessage,
  type AskUserQuestionPrompt,
} from '@garcon/common/chat-types';
import { normalizeTodoItems } from '@garcon/server-agent-common/shared/normalize-util';

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

// Resolves OpenCode tool name to a canonical key for dispatch.
function canonicalize(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

// Pins the built-in tool inventory shipped by OpenCode 1.18.19 so dependency
// upgrades must reconcile every provider-owned tool with Garcon's contract.
// https://github.com/anomalyco/opencode/blob/2b72179c663cadcb54f54d9f19221b3fb3d11fb6/packages/opencode/src/tool/registry.ts#L229-L249
export const OPENCODE_BUILTIN_TOOL_IDS = Object.freeze([
  'invalid',
  'question',
  'bash',
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'task',
  'webfetch',
  'todowrite',
  'websearch',
  'skill',
  'apply_patch',
  'execute',
  'lsp',
  'plan_exit',
] as const);

const OPENCODE_BUILTIN_TOOL_KEYS = new Set<string>(
  OPENCODE_BUILTIN_TOOL_IDS.map(canonicalize),
);

export function convertOpenCodeQuestionToolUse(
  ts: string,
  toolId: string,
  value: unknown,
): AskUserQuestionToolUseMessage | null {
  if (!Array.isArray(value)) return null;
  const questions: AskUserQuestionPrompt[] = [];
  for (const [questionIndex, entry] of value.entries()) {
    const rawQuestion = asObject(entry);
    const prompt = asString(rawQuestion.question);
    if (!prompt) return null;
    const options: AskUserQuestionPrompt['options'] = [];
    if (Array.isArray(rawQuestion.options)) {
      for (const [optionIndex, entry] of rawQuestion.options.entries()) {
        const rawOption = asObject(entry);
        const label = asString(rawOption.label);
        if (!label) continue;
        const option: AskUserQuestionPrompt['options'][number] = {
          id: `question-${questionIndex + 1}-option-${optionIndex + 1}`,
          label,
        };
        const description = asString(rawOption.description);
        if (description !== undefined) option.description = description;
        options.push(option);
      }
    }
    const question: AskUserQuestionPrompt = {
      id: `question-${questionIndex + 1}`,
      prompt,
      options,
      allowMultiple: asBoolean(rawQuestion.multiple) ?? false,
    };
    const header = asString(rawQuestion.header);
    if (header) question.header = header;
    questions.push(question);
  }
  if (questions.length === 0) return null;
  return new AskUserQuestionToolUseMessage(ts, toolId, undefined, questions);
}

/**
 * Converts an OpenCode tool part to a concrete ToolUseMessage.
 * Returns UnknownToolUseMessage for unrecognized or malformed payloads.
 */
export function convertOpenCodeToolUse(ts: string, part: unknown): ToolUseChatMessage {
  const rawPart = asObject(part);
  const state = asObject(rawPart.state);
  const rawName = typeof rawPart.tool === 'string' ? rawPart.tool : 'Unknown';
  const toolId = typeof rawPart.callID === 'string'
    ? rawPart.callID
    : typeof rawPart.id === 'string'
      ? rawPart.id
      : '';
  const input = asObject(state.input);
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

    case 'applypatch': {
      const patch = asString(input.patchText ?? input.patch_text ?? input.patch);
      if (patch === undefined) break;
      return new ApplyPatchToolUseMessage(ts, toolId, undefined, undefined, undefined, patch);
    }

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
        asString(input.task_id ?? input.taskId ?? input.resume));

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
      return new ExitPlanModeToolUseMessage(ts, toolId, asString(input.plan) ?? '',
        Array.isArray(input.allowedPrompts) ? input.allowedPrompts : undefined);
    }

    case 'question': {
      const question = convertOpenCodeQuestionToolUse(ts, toolId, input.questions);
      if (question) return question;
      break;
    }

    case 'execute': {
      const code = asString(input.code);
      if (code === undefined) break;
      return new ExecToolUseMessage(ts, toolId, code, 'javascript');
    }

    case 'skill':
    case 'lsp':
    case 'invalid':
      return new ExternalToolUseMessage(ts, toolId, rawName, asInput(state.input), 'opencode');
  }

  const normalizedInput = asInput(state.input);
  if (typeof rawPart.tool !== 'string' || OPENCODE_BUILTIN_TOOL_KEYS.has(key)) {
    return new UnknownToolUseMessage(ts, toolId, rawName, normalizedInput);
  }
  return new ExternalToolUseMessage(ts, toolId, rawName, normalizedInput, 'opencode');
}
