import type { JsonObject } from '@garcon/common/json';
import type {
  AgentMigration,
  AgentSettings,
} from '@garcon/server-agent-interface';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';

export function createVersion1RecordMigration(options: {
  readonly settings: AgentSettings;
  readonly nativeSessions: PathNativeSessionCodec;
}): AgentMigration {
  return {
    async translateLegacyNativeSession(request) {
      return options.nativeSessions.encode({
        path: request.legacyNativePath,
        agentSessionId: request.agentSessionId,
        modelEndpointId: typeof request.legacyValues.modelEndpointId === 'string'
          ? request.legacyValues.modelEndpointId
          : null,
      });
    },
    async translateLegacySettings({ legacyValues }) {
      const defaults = options.settings.defaults();
      const known = Object.fromEntries(
        options.settings.describe().flatMap((descriptor) => (
          Object.hasOwn(legacyValues, descriptor.key)
            ? [[descriptor.key, legacyValues[descriptor.key]]]
            : []
        )),
      ) as JsonObject;
      if (Object.keys(defaults.values).length === 0 && Object.keys(known).length === 0) {
        return null;
      }
      return options.settings.applyPatch(defaults, known);
    },
  };
}
