// Converts OpenCode permission.asked event payloads into canonical
// ToolUseMessage subclasses. Unlike tool-use events, permission events
// carry minimal structured input, so most map to UnknownToolUseMessage
// with a canonical tool name and the provider metadata preserved.

import {
  EnterPlanModeToolUseMessage,
  TodoReadToolUseMessage,
  UnknownToolUseMessage,
} from '../../../common/chat-types.js';

function canonicalize(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

function canonicalNameForPermission(rawName) {
  switch (canonicalize(rawName)) {
    case 'bash':
    case 'shellcommand':
    case 'execcommand':
      return 'Bash';
    case 'read':
      return 'Read';
    case 'edit':
      return 'Edit';
    case 'write':
      return 'Write';
    case 'applypatch':
      return 'ApplyPatch';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'websearch':
      return 'WebSearch';
    case 'webfetch':
      return 'WebFetch';
    case 'todowrite':
      return 'TodoWrite';
    case 'todoread':
      return 'TodoRead';
    case 'task':
      return 'Task';
    case 'updateplan':
      return 'UpdatePlan';
    case 'writestdin':
      return 'WriteStdin';
    case 'enterplanmode':
    case 'planenter':
      return 'EnterPlanMode';
    case 'exitplanmode':
    case 'exitplan':
    case 'planexit':
      return 'ExitPlanMode';
    case 'list':
      return 'List';
    case 'skill':
      return 'Skill';
    case 'lsp':
      return 'Lsp';
    case 'codesearch':
      return 'CodeSearch';
    case 'externaldirectory':
      return 'ExternalDirectory';
    case 'doomloop':
      return 'DoomLoop';
    case 'question':
      return 'Question';
    default:
      return typeof rawName === 'string' && rawName.trim() ? rawName : 'Unknown';
  }
}

/**
 * Converts an OpenCode permission event into a canonical ToolUseChatMessage.
 * OpenCode permission events carry a permission key and metadata rather than
 * full tool input, so most map to UnknownToolUseMessage with the permission
 * context preserved in the input record.
 */
export function convertOpencodePermissionTool(ts, toolId, permission) {
  const providerPermission = permission && typeof permission === 'object' ? permission : {};
  const providerTool = providerPermission.tool && typeof providerPermission.tool === 'object'
    ? providerPermission.tool
    : null;
  const rawName = typeof providerPermission.permission === 'string'
    ? providerPermission.permission
    : typeof providerTool?.name === 'string'
      ? providerTool.name
      : 'Unknown';
  const canonicalName = canonicalNameForPermission(rawName);

  switch (canonicalName) {
    case 'TodoRead':
      return new TodoReadToolUseMessage(ts, toolId);
    case 'EnterPlanMode':
      return new EnterPlanModeToolUseMessage(ts, toolId);
    default:
      return new UnknownToolUseMessage(ts, toolId, canonicalName, {
        permission: providerPermission.permission ?? null,
        patterns: Array.isArray(providerPermission.patterns) ? providerPermission.patterns : [],
        metadata: providerPermission.metadata ?? {},
        always: Array.isArray(providerPermission.always) ? providerPermission.always : [],
        tool: providerPermission.tool ?? null,
      });
  }
}
