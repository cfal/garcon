import type { AcpSessionConfigOption } from '../../acp/protocol.js';
import { createLogger } from '../../lib/log.js';
import type { AcpSessionConfigurationContext } from '../shared/acp-agent-runtime.js';

const logger = createLogger('agents:cursor:acp-model-config');

const FAST_SUFFIX = '-fast';
const GPT_REASONING_VALUES = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'extra-high']);
const CLAUDE_EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

type CursorConfigFamily = 'gpt-reasoning' | 'claude-effort' | 'plain';
export type CursorAcpSessionMode = 'agent' | 'plan' | 'ask';

export interface CursorAcpConfigSelection {
  model: string;
  context?: string;
  reasoning?: string;
  effort?: string;
  thinking?: string;
  fast?: string;
}

export interface CursorAcpConfigAssignment {
  configId: string;
  value: string;
}

export interface ConfigureCursorAcpSessionOptions {
  client: AcpSessionConfigurationContext['client'];
  sessionId: string;
  model: string;
  mode: CursorAcpSessionMode;
  configOptions?: AcpSessionConfigOption[];
}

interface CursorModelPattern {
  prefix: string;
  model: string;
  family: CursorConfigFamily;
  contextForVariant?: string;
  defaultContext?: string;
  defaultReasoning?: string;
  fastCapable?: boolean;
}

const CURSOR_MODEL_PATTERNS: CursorModelPattern[] = [
  { prefix: 'claude-opus-4-8', model: 'claude-opus-4-8', family: 'claude-effort', contextForVariant: '1m', fastCapable: true },
  { prefix: 'claude-opus-4-7', model: 'claude-opus-4-7', family: 'claude-effort', contextForVariant: '1m', fastCapable: true },
  { prefix: 'claude-opus-4-6', model: 'claude-opus-4-6', family: 'claude-effort', contextForVariant: '1m', fastCapable: true },
  { prefix: 'claude-opus-4-5', model: 'claude-opus-4-5', family: 'claude-effort' },
  { prefix: 'claude-4.6-sonnet', model: 'claude-sonnet-4-6', family: 'claude-effort', contextForVariant: '1m' },
  { prefix: 'claude-4.6-opus', model: 'claude-opus-4-6', family: 'claude-effort', contextForVariant: '1m', fastCapable: true },
  { prefix: 'claude-4.5-opus', model: 'claude-opus-4-5', family: 'claude-effort' },
  { prefix: 'claude-4.5-sonnet', model: 'claude-sonnet-4-5', family: 'claude-effort' },
  { prefix: 'claude-4-sonnet', model: 'claude-sonnet-4', family: 'claude-effort' },
  { prefix: 'claude-fable-5', model: 'claude-fable-5', family: 'claude-effort', contextForVariant: '1m' },
  { prefix: 'gpt-5.1-codex-max', model: 'gpt-5.1-codex-max', family: 'gpt-reasoning', defaultReasoning: 'medium', fastCapable: true },
  { prefix: 'gpt-5.1-codex-mini', model: 'gpt-5.1-codex-mini', family: 'gpt-reasoning', defaultReasoning: 'medium' },
  { prefix: 'gpt-5.3-codex', model: 'gpt-5.3-codex', family: 'gpt-reasoning', defaultReasoning: 'medium', fastCapable: true },
  { prefix: 'gpt-5.2-codex', model: 'gpt-5.2-codex', family: 'gpt-reasoning', defaultReasoning: 'medium', fastCapable: true },
  { prefix: 'gpt-5.4-mini', model: 'gpt-5.4-mini', family: 'gpt-reasoning', defaultReasoning: 'medium' },
  { prefix: 'gpt-5.4-nano', model: 'gpt-5.4-nano', family: 'gpt-reasoning', defaultReasoning: 'medium' },
  { prefix: 'composer-2.5', model: 'composer-2.5', family: 'plain', fastCapable: true },
  { prefix: 'gpt-5.5', model: 'gpt-5.5', family: 'gpt-reasoning', contextForVariant: '1m', defaultContext: '272k', defaultReasoning: 'medium', fastCapable: true },
  { prefix: 'gpt-5.4', model: 'gpt-5.4', family: 'gpt-reasoning', contextForVariant: '1m', defaultContext: '272k', defaultReasoning: 'medium', fastCapable: true },
  { prefix: 'gpt-5.2', model: 'gpt-5.2', family: 'gpt-reasoning', defaultReasoning: 'medium', fastCapable: true },
  { prefix: 'gpt-5.1', model: 'gpt-5.1', family: 'gpt-reasoning', defaultReasoning: 'medium' },
].sort((left, right) => right.prefix.length - left.prefix.length);

export function cursorAcpModeForPermissionMode(permissionMode: string): CursorAcpSessionMode {
  return permissionMode === 'plan' ? 'plan' : 'agent';
}

export function cursorConfigSelectionForModel(model: string): CursorAcpConfigSelection | null {
  if (!model || model === 'default' || model === 'auto') {
    return { model: 'default' };
  }

  const fast = model.endsWith(FAST_SUFFIX) ? 'true' : undefined;
  const withoutFast = fast ? model.slice(0, -FAST_SUFFIX.length) : model;
  const matched = CURSOR_MODEL_PATTERNS.find((pattern) =>
    withoutFast === pattern.prefix || withoutFast.startsWith(`${pattern.prefix}-`));

  if (!matched) {
    return fast ? { model: withoutFast, fast } : { model: withoutFast };
  }

  const suffix = withoutFast === matched.prefix ? '' : withoutFast.slice(matched.prefix.length + 1);
  if (!suffix) {
    return {
      model: matched.model,
      ...(matched.defaultContext ? { context: matched.defaultContext } : {}),
      ...(matched.defaultReasoning ? { reasoning: matched.defaultReasoning } : {}),
      ...(fast || matched.fastCapable ? { fast: fast ?? 'false' } : {}),
    };
  }

  if (matched.family === 'gpt-reasoning') {
    if (!GPT_REASONING_VALUES.has(suffix)) return null;
    return {
      model: matched.model,
      ...(matched.contextForVariant ? { context: matched.contextForVariant } : {}),
      reasoning: normalizeGptReasoning(suffix),
      ...(fast || matched.fastCapable ? { fast: fast ?? 'false' } : {}),
    };
  }

  if (matched.family === 'claude-effort') {
    const parsed = parseClaudeSuffix(suffix);
    if (!parsed) return null;
    return {
      model: matched.model,
      ...(matched.contextForVariant ? { context: matched.contextForVariant } : {}),
      ...parsed,
      ...(fast || matched.fastCapable ? { fast: fast ?? 'false' } : {}),
    };
  }

  return fast ? { model: matched.model, fast } : { model: matched.model };
}

export function assignmentsForCursorModel(model: string, mode?: CursorAcpSessionMode): CursorAcpConfigAssignment[] {
  const selection = cursorConfigSelectionForModel(model);
  if (!selection) {
    throw new Error(`Cursor model is not supported by ACP config mapping: ${model}`);
  }
  return assignmentsForSelection(selection, mode);
}

export async function configureCursorAcpSession(
  context: AcpSessionConfigurationContext,
): Promise<AcpSessionConfigOption[]> {
  return configureCursorAcpSessionOptions({
    client: context.client,
    sessionId: context.sessionId,
    model: context.request.model,
    mode: cursorAcpModeForPermissionMode(context.request.permissionMode),
    configOptions: context.configOptions,
  });
}

export async function configureCursorAcpSessionOptions(
  context: ConfigureCursorAcpSessionOptions,
): Promise<AcpSessionConfigOption[]> {
  let options = context.configOptions ?? [];
  const assignments = assignmentsForCursorModel(context.model, context.mode);

  try {
    for (const assignment of assignments) {
      assertOptionAllowsValue(options, assignment, context.model);
      const result = await context.client.setSessionConfigOption({
        sessionId: context.sessionId,
        configId: assignment.configId,
        value: assignment.value,
      });
      options = result.configOptions ?? [];
      assertCurrentValue(options, assignment, context.model);
    }
    logger.info(`cursor: configured ACP model for ${context.sessionId}: ${formatAssignments(assignments)}`);
    return options;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`cursor: failed to configure ACP model ${context.model}: ${message}`);
    throw error;
  }
}

function assignmentsForSelection(
  selection: CursorAcpConfigSelection,
  mode?: CursorAcpSessionMode,
): CursorAcpConfigAssignment[] {
  return [
    ...(mode ? [{ configId: 'mode', value: mode }] : []),
    { configId: 'model', value: selection.model },
    ...optionalAssignment('context', selection.context),
    ...optionalAssignment('reasoning', selection.reasoning),
    ...optionalAssignment('effort', selection.effort),
    ...optionalAssignment('thinking', selection.thinking),
    ...optionalAssignment('fast', selection.fast),
  ];
}

function optionalAssignment(configId: string, value: string | undefined): CursorAcpConfigAssignment[] {
  return value ? [{ configId, value }] : [];
}

function normalizeGptReasoning(value: string): string {
  return value === 'xhigh' ? 'extra-high' : value;
}

function parseClaudeSuffix(suffix: string): Pick<CursorAcpConfigSelection, 'effort' | 'thinking'> | null {
  if (suffix === 'thinking') return { thinking: 'true' };
  if (suffix.startsWith('thinking-')) {
    const effort = suffix.slice('thinking-'.length);
    return CLAUDE_EFFORT_VALUES.has(effort) ? { thinking: 'true', effort } : null;
  }
  if (suffix.endsWith('-thinking')) {
    const effort = suffix.slice(0, -'-thinking'.length);
    return CLAUDE_EFFORT_VALUES.has(effort) ? { thinking: 'true', effort } : null;
  }
  return CLAUDE_EFFORT_VALUES.has(suffix) ? { effort: suffix } : null;
}

function findOption(options: AcpSessionConfigOption[], configId: string): AcpSessionConfigOption | null {
  return options.find((option) => option.id === configId) ?? null;
}

function optionValues(option: AcpSessionConfigOption): string[] {
  return Array.isArray(option.options)
    ? option.options
      .map((entry) => entry.value)
      .filter((value): value is string => typeof value === 'string')
    : [];
}

function assertOptionAllowsValue(
  options: AcpSessionConfigOption[],
  assignment: CursorAcpConfigAssignment,
  requestedModel: string,
): void {
  const option = findOption(options, assignment.configId);
  if (!option) {
    throw new Error(`Cursor did not expose ${assignment.configId} while selecting ${requestedModel}`);
  }
  const values = optionValues(option);
  if (!values.includes(assignment.value)) {
    throw new Error(
      `Cursor model ${requestedModel} requires ${assignment.configId}=${assignment.value}, ` +
      `but Cursor only offered ${values.join(', ') || 'no values'}`,
    );
  }
}

function assertCurrentValue(
  options: AcpSessionConfigOption[],
  assignment: CursorAcpConfigAssignment,
  requestedModel: string,
): void {
  const option = findOption(options, assignment.configId);
  if (option?.currentValue !== assignment.value) {
    throw new Error(
      `Cursor did not apply requested model ${requestedModel}. ` +
      `Expected ${assignment.configId}=${assignment.value}, got ${option?.currentValue ?? 'missing'}.`,
    );
  }
}

function formatAssignments(assignments: CursorAcpConfigAssignment[]): string {
  return assignments.map((entry) => `${entry.configId}=${entry.value}`).join(', ');
}
