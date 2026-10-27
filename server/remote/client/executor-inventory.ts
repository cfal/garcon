import { parseAgentSettingsEnvelope, isAgentSettingLabelKey, isAgentSettingOptionLabelKey, isAgentSettingOptionDescriptionKey } from '../../../common/agent-integration.js';
import { isPermissionMode, isThinkingMode } from '../../../common/chat-modes.js';
import { isInputFormatByModel } from '../../../common/input-format.js';
import { isRecord } from '../../../common/json.js';
import { ANY_FILE_ATTACHMENT_MIME_TYPE } from '../../../common/attachments.js';
import { NULLABLE_AGENT_FACETS, type IntegrationManifest } from '../transport/rpc-protocol.js';

export function validateManifest(value: IntegrationManifest): void {
  const descriptor = value?.descriptor;
  const settings = value?.settings;
  const defaults = parseAgentSettingsEnvelope(settings?.defaults);
  if (!isRecord(descriptor) || typeof descriptor.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(descriptor.id)
    || typeof descriptor.label !== 'string' || !descriptor.label.trim()
    || !(descriptor.icon === null || typeof descriptor.icon === 'string')
    || !list(descriptor.supportedPermissionModes, isPermissionMode)
    || !list(descriptor.supportedThinkingModes, isThinkingMode)
    || !list(descriptor.supportedEndpointProtocols, protocol => protocol === 'anthropic-messages' || protocol === 'openai-compatible')
    || !booleans(descriptor, ['supportsImages', 'supportsProjectPathUpdate', 'requiresNativePathForProjectPathUpdate'])
    || !Array.isArray(descriptor.configuration) || !descriptor.configuration.every(entry => isRecord(entry)
      && typeof entry.key === 'string' && entry.key.trim() && entry.source === 'environment' && typeof entry.description === 'string')
    || !isRecord(value.scope) || value.scope.integrationId !== descriptor.id
    || !defaults || defaults.ownerId !== descriptor.id
    || !Array.isArray(settings.descriptors) || !settings.descriptors.every(setting)
    || new Set(settings.descriptors.map(entry => entry.key)).size !== settings.descriptors.length
    || !booleans(value.capabilities, NULLABLE_AGENT_FACETS)
    || !booleans(value.authMethods, ['launchLogin', 'completeLogin', 'loginStatus'])
    || typeof value.singleQueryRunsToolsWithoutPermission !== 'boolean'
    || !(value.attachments === null || isRecord(value.attachments)
      && (value.attachments.fileMimeTypes === ANY_FILE_ATTACHMENT_MIME_TYPE || list(value.attachments.fileMimeTypes, item => typeof item === 'string'))
      && (value.attachments.inlineTextMaxBytes === null || Number.isSafeInteger(value.attachments.inlineTextMaxBytes) && value.attachments.inlineTextMaxBytes >= 0))
    || !(value.literalExecution === null || isRecord(value.literalExecution)
      && typeof value.literalExecution.selectionLabel === 'string' && value.literalExecution.selectionLabel.length > 0
      && isInputFormatByModel(value.literalExecution.inputFormatByModel)
      && !value.capabilities.singleQuery && !value.capabilities.compaction && !value.capabilities.steering)) {
    throw new Error('Executor integration manifest is invalid');
  }
}

function booleans(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every(key => typeof value[key] === 'boolean');
}

function list(value: unknown, accepts: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(accepts) && new Set(value).size === value.length;
}

function setting(value: unknown): boolean {
  if (!isRecord(value) || typeof value.key !== 'string' || !value.key || typeof value.label !== 'string'
    || value.labelKey !== undefined && !isAgentSettingLabelKey(value.labelKey)) return false;
  switch (value.type) {
    case 'boolean': case 'string': return true;
    case 'credential-ref': return typeof value.credentialKind === 'string';
    case 'number': return typeof value.min === 'number' && Number.isFinite(value.min)
      && typeof value.max === 'number' && Number.isFinite(value.max) && value.min <= value.max
      && typeof value.step === 'number' && Number.isFinite(value.step) && value.step > 0;
    case 'enum': return Array.isArray(value.options) && value.options.every(option => isRecord(option)
      && typeof option.value === 'string' && typeof option.label === 'string'
      && (option.description === undefined || typeof option.description === 'string')
      && (option.labelKey === undefined || isAgentSettingOptionLabelKey(option.labelKey))
      && (option.descriptionKey === undefined || isAgentSettingOptionDescriptionKey(option.descriptionKey)));
    default: return false;
  }
}

// Only received JSON metadata is frozen; live service objects retain their own lifecycle.
export function freezeInventory<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const child of Object.values(current)) pending.push(child);
  }
  return value;
}
