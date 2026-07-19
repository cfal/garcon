// Shared compatibility rules between agents and API provider endpoints.

const ENDPOINT_MODEL_VALUE_SEPARATOR = ':';

export function endpointModelOptionValue(endpointId: string, rawModel: string): string {
  return `${endpointId}${ENDPOINT_MODEL_VALUE_SEPARATOR}${rawModel}`;
}

export function rawModelFromEndpointOptionValue(endpointId: string, selectedModel: string): string {
  const prefix = `${endpointId}${ENDPOINT_MODEL_VALUE_SEPARATOR}`;
  return selectedModel.startsWith(prefix) ? selectedModel.slice(prefix.length) : selectedModel;
}
