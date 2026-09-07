import { normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';
import { isRecord } from '@garcon/common/json';

export function claudeToolResultContent(
  content: unknown,
  toolUseResult: unknown,
): Record<string, unknown> {
  const normalized = normalizeToolResultContent(content);
  return isRecord(toolUseResult)
    ? { ...normalized, toolUseResult }
    : normalized;
}
