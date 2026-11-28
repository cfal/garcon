import { isRecord } from '../../../../../common/json.ts';

export function agentSettingDescriptor(value: unknown): boolean {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.label !== 'string') return false;
  switch (value.type) {
    case 'boolean':
    case 'string':
      return true;
    case 'enum':
      return Array.isArray(value.options) && value.options.every((option) =>
        isRecord(option) && typeof option.value === 'string' && typeof option.label === 'string');
    case 'number':
      return typeof value.min === 'number' && typeof value.max === 'number' && typeof value.step === 'number';
    case 'credential-ref':
      return typeof value.credentialKind === 'string';
    default:
      return false;
  }
}
