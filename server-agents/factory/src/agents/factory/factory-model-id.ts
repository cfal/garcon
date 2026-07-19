// Droid reports BYOK model entries with `custom:` and accepts the same IDs at runtime.
export function isFactoryCustomModel(model: string): boolean {
  return model.startsWith('custom:');
}

export function inferFactoryModelSupportsImages(model: string): boolean {
  return /^(claude-|gpt-|kimi-k2\.5|custom:)/.test(model);
}
