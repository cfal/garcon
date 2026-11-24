import { parseRemoveProjectPathRequest, type RemoveProjectPathResponse } from '../../../common/project-path-preferences.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { buildRemoteSettingsSnapshot } from '../settings/remote-snapshot.js';
import type { SettingsStore } from '../settings/store.js';

type ProjectPathPreferencesOptions = Parameters<typeof buildRemoteSettingsSnapshot>[0] & {
  settings: Pick<SettingsStore, 'getRemoteSettingsSnapshotSource' | 'removeProjectPathFromList'>;
};

export function createProjectPathPreferenceRoutes(options: ProjectPathPreferencesOptions): RouteMap {
  return {
    '/api/v1/app/settings/project-path': {
      DELETE: withJsonBody(async (body: unknown) => {
        const input = parseRemoveProjectPathRequest(body);
        if (!input) return jsonError('Invalid project path removal.', 400, 'INVALID_PROJECT_PATH_REMOVAL', false);
        try {
          await options.settings.removeProjectPathFromList(input);
          const response: RemoveProjectPathResponse = {
            success: true,
            settings: await buildRemoteSettingsSnapshot(options),
          };
          return Response.json(response);
        } catch (error) {
          return jsonErrorFromUnknown(error);
        }
      }),
    },
  };
}
