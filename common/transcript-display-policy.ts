import { isToolUseMessage, type ChatMessage, type ToolUseChatMessage } from './chat-types.js';
import { isCleanCommandSuccess } from './command-output.js';

export const DISPLAY_POLICY_REVISION = 1;
export const HIDEABLE_TOOL_GROUPS = [
  { id: 'bash', toolTypes: ['bash-tool-use', 'write-stdin-tool-use', 'claude-monitor-tool-use'] },
  { id: 'exec', toolTypes: ['exec-tool-use', 'wait-tool-use'] },
  { id: 'file-reads', toolTypes: ['read-tool-use', 'list-tool-use', 'grep-tool-use', 'glob-tool-use'] },
  { id: 'file-changes', toolTypes: ['edit-tool-use', 'write-tool-use', 'apply-patch-tool-use'] },
  { id: 'web', toolTypes: ['web-search-tool-use', 'web-fetch-tool-use'] },
  { id: 'tasks', toolTypes: ['todo-write-tool-use', 'todo-read-tool-use', 'task-tool-use',
    'codex-subagent-tool-use', 'update-plan-tool-use', 'enter-plan-mode-tool-use',
    'cursor-create-plan-tool-use', 'amp-task-list-tool-use', 'amp-handoff-tool-use'] },
  { id: 'provider', toolTypes: ['amp-finder-tool-use', 'amp-oracle-tool-use', 'amp-librarian-tool-use',
    'amp-skill-tool-use', 'amp-mermaid-tool-use', 'amp-look-at-tool-use', 'amp-find-thread-tool-use',
    'amp-read-thread-tool-use', 'external-tool-use', 'mcp-tool-use', 'pi-tool-search-tool-use',
    'claude-tool-search-tool-use'] },
] as const satisfies readonly { id: string; toolTypes: readonly ToolUseChatMessage['type'][] }[];

export type HiddenToolGroup = (typeof HIDEABLE_TOOL_GROUPS)[number]['id'];
export type HideableToolType = (typeof HIDEABLE_TOOL_GROUPS)[number]['toolTypes'][number];
export type SummaryCategory = 'commands' | 'fileReads' | 'fileEdits' | 'other';
export const SUMMARY_CATEGORIES: readonly SummaryCategory[] = ['commands', 'fileReads', 'fileEdits', 'other'];
export type DisplayRole = 'hidden' | 'member' | 'breaker';
export type ToolType = ToolUseChatMessage['type'];

export interface ToolStructure {
  readonly input: { readonly mode: 'inline' | 'collapsible' | 'hidden' };
  readonly result: {
    readonly mode?: 'inline' | 'collapsible' | 'special';
    readonly hidden?: boolean;
    readonly hideOnSuccess?: boolean;
  };
}

const inlineHidden = { input: { mode: 'inline' }, result: { hidden: true } } as const;
const hidden = { input: { mode: 'hidden' }, result: { hidden: true } } as const;
const inlineResult = { input: { mode: 'inline' }, result: { mode: 'collapsible' } } as const;
const collapsibleResult = { input: { mode: 'collapsible' }, result: { mode: 'collapsible' } } as const;
const collapsibleSuppressed = { input: { mode: 'collapsible' }, result: { hideOnSuccess: true } } as const;

export const TOOL_STRUCTURE = {
  'bash-tool-use': { input: { mode: 'inline' }, result: { hideOnSuccess: true, mode: 'special' } },
  'exec-tool-use': { input: { mode: 'inline' }, result: { mode: 'special' } },
  'wait-tool-use': hidden,
  'read-tool-use': inlineHidden,
  'list-tool-use': { input: { mode: 'inline' }, result: { hideOnSuccess: true } },
  'edit-tool-use': collapsibleSuppressed,
  'write-tool-use': collapsibleSuppressed,
  'apply-patch-tool-use': collapsibleSuppressed,
  'grep-tool-use': inlineResult,
  'glob-tool-use': inlineResult,
  'web-search-tool-use': inlineResult,
  'web-fetch-tool-use': inlineResult,
  'todo-write-tool-use': collapsibleResult,
  'todo-read-tool-use': inlineResult,
  'task-tool-use': collapsibleResult,
  'codex-subagent-tool-use': collapsibleResult,
  'update-plan-tool-use': collapsibleResult,
  'write-stdin-tool-use': hidden,
  'enter-plan-mode-tool-use': hidden,
  'exit-plan-mode-tool-use': { input: { mode: 'collapsible' }, result: { hidden: true } },
  'ask-user-question-tool-use': hidden,
  'cursor-create-plan-tool-use': hidden,
  'amp-finder-tool-use': inlineResult,
  'amp-oracle-tool-use': collapsibleResult,
  'amp-librarian-tool-use': collapsibleResult,
  'amp-skill-tool-use': inlineHidden,
  'amp-mermaid-tool-use': inlineHidden,
  'amp-handoff-tool-use': inlineHidden,
  'amp-look-at-tool-use': inlineHidden,
  'amp-find-thread-tool-use': inlineResult,
  'amp-read-thread-tool-use': inlineResult,
  'amp-task-list-tool-use': inlineResult,
  'pi-tool-search-tool-use': inlineResult,
  'claude-tool-search-tool-use': inlineResult,
  'claude-monitor-tool-use': collapsibleResult,
  'external-tool-use': collapsibleResult,
  'mcp-tool-use': collapsibleResult,
  'request-permissions-tool-use': { input: { mode: 'collapsible' }, result: { hidden: true } },
  'unknown-tool-use': collapsibleResult,
  default: collapsibleResult,
} as const satisfies Record<ToolType | 'default', ToolStructure>;

const hideGroupByType = new Map<string, HiddenToolGroup>(
  HIDEABLE_TOOL_GROUPS.flatMap(group => group.toolTypes.map(type => [type, group.id] as const)),
);

export function toolHideGroup(type: string): HiddenToolGroup | null {
  return hideGroupByType.get(type) ?? null;
}

export function toolSummaryCategory(type: ToolType): SummaryCategory {
  switch (type) {
    case 'bash-tool-use': case 'exec-tool-use': return 'commands';
    case 'read-tool-use': case 'list-tool-use': case 'grep-tool-use': case 'glob-tool-use': return 'fileReads';
    case 'edit-tool-use': case 'write-tool-use': case 'apply-patch-tool-use': return 'fileEdits';
    default: return 'other';
  }
}

export function toolSummaryWeight(message: ToolUseChatMessage): number {
  return message.type === 'edit-tool-use' && message.changes?.length ? message.changes.length : 1;
}

export function hasEmptyRequiredInput(tool: ToolUseChatMessage | undefined): boolean {
  switch (tool?.type) {
    case 'bash-tool-use': return tool.command === '';
    case 'claude-tool-search-tool-use': return tool.query === '';
    case 'claude-monitor-tool-use': return tool.description === '';
    case 'exec-tool-use': return tool.code === '';
    case 'read-tool-use': case 'write-tool-use': case 'edit-tool-use': return tool.filePath === '';
    default: return false;
  }
}

export function toolResultVisible(type: ToolType, isError: boolean, emptyRequiredInput: boolean): boolean {
  if (isError && emptyRequiredInput) return true;
  const result: ToolStructure['result'] = TOOL_STRUCTURE[type].result;
  return !result.hidden && (!result.hideOnSuccess || isError)
    && (result.mode === 'inline' || result.mode === 'collapsible');
}

export function intrinsicDisplayRole(message: ChatMessage): DisplayRole {
  if (message.type === 'tool-result') throw new TypeError('Tool results require occurrence evidence');
  if (message.type === 'permission-resolved' || message.type === 'permission-cancelled'
    || message.type === 'permission-expired') return 'hidden';
  if (message.type === 'command-result' && isCleanCommandSuccess(message.result)) return 'hidden';
  if (!isToolUseMessage(message)) return 'breaker';
  if (message.type === 'enter-plan-mode-tool-use' || message.type === 'exit-plan-mode-tool-use') return 'breaker';
  return TOOL_STRUCTURE[message.type].input.mode === 'hidden' ? 'hidden' : 'member';
}
