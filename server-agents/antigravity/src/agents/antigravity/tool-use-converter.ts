import {
  AgentMessageToolUseMessage,
  AntigravityEnterPlanModeToolUseMessage,
  AntigravityExitPlanModeToolUseMessage,
  BashToolUseMessage,
  BackgroundTaskToolUseMessage,
  EditToolUseMessage,
  ExternalToolUseMessage,
  GlobToolUseMessage,
  GrepToolUseMessage,
  ListToolUseMessage,
  McpToolUseMessage,
  ReadToolUseMessage,
  ScheduleToolUseMessage,
  TaskToolUseMessage,
  UnknownToolUseMessage,
  UpdatePlanToolUseMessage,
  WebFetchToolUseMessage,
  WebSearchToolUseMessage,
  WriteToolUseMessage,
  type ToolUseChatMessage,
  type PlanStep,
} from '@garcon/common/chat-types';
import { asObject, asString } from '@garcon/server-agent-common/acp/event-converter';

export const ANTIGRAVITY_TOOL_NAMESPACE = 'antigravity';

export interface AntigravityToolCall {
  readonly toolCallId: string;
  // Null when the frame names no tool; `kind` then only describes the category.
  readonly name: string | null;
  readonly planTitle: 'matched' | 'excluded' | null;
  readonly isMcp: boolean;
  readonly kind: string | null;
  readonly input: Record<string, unknown>;
}

// Tool arguments arrive in PascalCase from 1.5 and snake_case from older builds
// (https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/apps/server/src/provider/acp/AntigravityProtocol.ts#L444-L512).
function field(input: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (input[name] !== undefined) return input[name];
  }
  return undefined;
}

function stringField(input: Record<string, unknown>, ...names: string[]): string | undefined {
  return asString(field(input, ...names));
}

export function antigravityMcpArguments(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = input.arguments ?? input.args ?? input.Arguments;
  return value && typeof value === 'object' && !Array.isArray(value) ? asObject(value) : undefined;
}

export function antigravityToolName(call: AntigravityToolCall): string | null {
  return call.name ?? (call.planTitle === 'matched' ? 'update_steps' : null);
}

function lineField(input: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = field(input, ...names);
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function antigravityPlanSteps(raw: unknown): PlanStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    const { title, status } = asObject(entry);
    if (typeof title !== 'string') return undefined;
    if (status === 'done') steps.push({ content: title, status: 'completed' });
    else if (status === 'pending' || status === 'in_progress' || status === 'failed' || status === 'skipped') {
      steps.push({ content: title, status });
    } else return undefined;
  }
  return steps;
}

// Reads the tool identity from a `tool_call` update or a permission's `toolCall`.
export function antigravityToolCall(raw: Record<string, unknown>): AntigravityToolCall | null {
  const toolCallId = asString(raw.toolCallId);
  if (!toolCallId) return null;
  let planTitle: AntigravityToolCall['planTitle'] = null;
  const isMcp = asObject(raw._meta).is_mcp_tool_call === true;
  if (isMcp || (raw.kind && raw.kind !== 'other')) planTitle = 'excluded';
  else if (raw.title === 'Run update_steps') planTitle = 'matched';
  return {
    toolCallId,
    name: asString(raw.name) ?? null,
    planTitle,
    isMcp,
    kind: asString(raw.kind) ?? null,
    input: asObject(raw.rawInput ?? raw.args),
  };
}

export function convertAntigravityToolUse(
  timestamp: string,
  call: AntigravityToolCall,
): ToolUseChatMessage {
  const { toolCallId: id, input } = call;
  const mcpServer = asString(input.server);
  const mcpTool = asString(input.tool);
  if (mcpServer && mcpTool) {
    return new McpToolUseMessage(timestamp, id, mcpServer, mcpTool, antigravityMcpArguments(input) ?? {});
  }
  const name = antigravityToolName(call);
  switch (call.isMcp && name !== 'call_mcp_tool' ? null : name) {
    case 'run_command': {
      const command = stringField(input, 'CommandLine', 'command_line', 'commandLine', 'command');
      if (command === undefined) break;
      return new BashToolUseMessage(timestamp, id, command, stringField(input, 'toolSummary'));
    }
    case 'read_file':
    case 'view_file': {
      const path = stringField(input, 'Path', 'path', 'AbsolutePath', 'file_path');
      if (path === undefined) break;
      return new ReadToolUseMessage(
        timestamp,
        id,
        path,
        lineField(input, 'StartLine', 'start_line'),
        undefined,
        lineField(input, 'EndLine', 'end_line'),
      );
    }
    case 'write_file':
    case 'write_to_file': {
      const path = stringField(input, 'Path', 'path', 'TargetFile', 'file_path');
      if (path === undefined) break;
      return new WriteToolUseMessage(timestamp, id, path, stringField(input, 'Content', 'content', 'CodeContent'));
    }
    case 'edit_file':
    case 'replace_file_content': {
      const path = stringField(input, 'Path', 'path', 'TargetFile', 'file_path');
      if (path === undefined) break;
      return new EditToolUseMessage(
        timestamp,
        id,
        path,
        stringField(input, 'Target', 'target', 'TargetContent'),
        stringField(input, 'Replacement', 'replacement', 'ReplacementContent'),
      );
    }
    case 'multi_replace_file_content': {
      const path = stringField(input, 'TargetFile', 'target_file', 'Path', 'path', 'file_path');
      if (path === undefined) break;
      // Each chunk replaces one region; the regions render as one combined edit.
      const rawChunks = field(input, 'ReplacementChunks', 'replacement_chunks');
      const chunks = Array.isArray(rawChunks) ? rawChunks.map(asObject) : [];
      const join = (...names: string[]) => {
        const parts = chunks.map((chunk) => stringField(chunk, ...names));
        return parts.every((part) => part !== undefined) && parts.length > 0 ? parts.join('\n\n') : undefined;
      };
      return new EditToolUseMessage(
        timestamp,
        id,
        path,
        join('TargetContent', 'target_content'),
        join('ReplacementContent', 'replacement_content'),
      );
    }
    case 'grep_search': {
      const pattern = stringField(input, 'Query', 'query', 'Pattern');
      if (pattern === undefined) break;
      return new GrepToolUseMessage(timestamp, id, pattern, stringField(input, 'SearchPath', 'SearchDirectory', 'path'));
    }
    case 'find_by_name': {
      const pattern = stringField(input, 'Pattern', 'pattern');
      if (pattern === undefined) break;
      return new GlobToolUseMessage(timestamp, id, pattern, stringField(input, 'SearchDirectory', 'path'));
    }
    case 'list_dir':
      return new ListToolUseMessage(timestamp, id, stringField(input, 'DirectoryPath', 'Path', 'path'));
    case 'read_url_content': {
      const url = stringField(input, 'Url', 'url');
      if (url === undefined) break;
      return new WebFetchToolUseMessage(timestamp, id, url);
    }
    case 'search_web': {
      const query = stringField(input, 'query', 'Query');
      if (query === undefined) break;
      return new WebSearchToolUseMessage(timestamp, id, query);
    }
    case 'schedule': {
      const delaySeconds = field(input, 'DurationSeconds', 'duration_seconds');
      const expression = field(input, 'CronExpression', 'cron_expression');
      const prompt = field(input, 'Prompt', 'prompt');
      const timerCondition = field(input, 'TimerCondition', 'timer_condition');
      const daemon = field(input, 'IsDaemon', 'is_daemon');
      const maxIterations = field(input, 'MaxIterations', 'max_iterations');
      const exactTiming = field(input, 'ExactTiming', 'exact_timing');
      if (typeof delaySeconds === 'number' && Number.isInteger(delaySeconds) && delaySeconds > 0
        && expression === undefined && daemon === undefined && maxIterations === undefined && exactTiming === undefined) {
        const row = ScheduleToolUseMessage.fromRequest(timestamp, id, { action: 'wakeup', delaySeconds, prompt, timerCondition });
        if (row) return row;
      }
      if (expression !== undefined && delaySeconds === undefined && timerCondition === undefined) {
        const row = ScheduleToolUseMessage.fromRequest(timestamp, id, { action: 'cron', expression, prompt, daemon, maxIterations, exactTiming });
        if (row) return row;
      }
      break;
    }
    case 'enter_plan_mode': {
      const reason = stringField(input, 'Reason', 'reason');
      if (reason !== undefined) return new AntigravityEnterPlanModeToolUseMessage(timestamp, id, reason);
      break;
    }
    case 'exit_plan_mode': {
      const plan = stringField(input, 'Plan', 'plan');
      if (plan !== undefined) return new AntigravityExitPlanModeToolUseMessage(timestamp, id, plan);
      break;
    }
    case 'update_steps': {
      const steps = antigravityPlanSteps(input.steps);
      if (steps) return new UpdatePlanToolUseMessage(timestamp, id, steps);
      break;
    }
    case 'manage_task': {
      const action = field(input, 'Action', 'action');
      if (action === 'stop') break; // The native stop action is named kill.
      const row = BackgroundTaskToolUseMessage.fromFields(timestamp, id, action === 'kill' ? 'stop' : action,
        field(input, 'TaskId', 'task_id'), field(input, 'Input', 'input'));
      if (row) return row;
      break;
    }
    case 'send_message': {
      const row = AgentMessageToolUseMessage.fromFields(timestamp, id,
        field(input, 'Recipient', 'recipient'), field(input, 'Message', 'message'));
      if (row) return row;
      break;
    }
    case 'invoke_subagent': {
      const role = stringField(input, 'Role', 'role');
      return new TaskToolUseMessage(
        timestamp,
        id,
        stringField(input, 'TypeName', 'type_name') ?? role,
        role,
        stringField(input, 'Prompt', 'prompt'),
        stringField(input, 'Model', 'model'),
      );
    }
    case 'call_mcp_tool': {
      const server = stringField(input, 'ServerName', 'server_name');
      const tool = stringField(input, 'ToolName', 'tool_name');
      if (server && tool) return new McpToolUseMessage(timestamp, id, server, tool, antigravityMcpArguments(input) ?? {});
      break;
    }
  }
  // Every named tool comes from agy's own registry, so tools without a shared
  // counterpart render as named provider tools; only an unnamed call is unknown.
  if (name !== null) return new ExternalToolUseMessage(timestamp, id, name, input, ANTIGRAVITY_TOOL_NAMESPACE);
  return new UnknownToolUseMessage(timestamp, id, call.kind ?? 'unknown', input);
}

// Command results lead with `Created At:`/`Completed At:` timestamps that carry
// no information for the transcript.
export function antigravityToolResultText(name: string, text: string): string {
  if (name !== 'run_command') return text;
  return text.replace(/^Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?/, '');
}
