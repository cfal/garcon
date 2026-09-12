import { expect, mock, test } from 'bun:test';
import { localProviderMetadata } from '../local-provider-metadata.js';

function fixture(profile: string) {
  const unexpected = mock((): never => { throw new Error('Metadata invoked executable provider code'); });
  const defaults = { ownerId: 'synthetic', schemaVersion: 1, values: { nested: { profile } } };
  const source = {
    descriptor: { id: 'synthetic', label: profile, icon: null,
      supportedPermissionModes: ['default'], supportedThinkingModes: ['none'], supportsImages: false,
      supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: [], configuration: [{ key: 'SYNTHETIC_CREDENTIAL', source: 'environment', description: 'Credential variable' }] },
    settings: { defaults: () => defaults, describe: () => [], parse: unexpected, applyPatch: unexpected, migrate: unexpected },
    catalog: { snapshot: unexpected }, execution: { start: unexpected, resume: unexpected, abort: unexpected, runningSessions: unexpected },
    attachments: { fileMimeTypes: ['text/plain'] },
    auth: { status: unexpected, launchLogin: unexpected },
    commands: null, compaction: null, forking: null, steering: null, goals: null, endpoints: null,
    singleQuery: null, textGeneration: null, legacyHistoryImport: null, nativeHistoryImport: null,
    nativeActivity: null, nativeSessions: null, sessionConfiguration: null, projectPathUpdates: null,
  } satisfies Parameters<typeof localProviderMetadata>[0];
  return { source, defaults, unexpected };
}

test('local metadata snapshots the exact instance without invoking its executable facets or validators', () => {
  const first = fixture('primary'); const second = fixture('secondary');
  const metadata = localProviderMetadata(second.source);
  expect(metadata.descriptor.label).toBe('secondary');
  expect(metadata.defaultSettings.values).toEqual({ nested: { profile: 'secondary' } });
  expect(metadata.facets.execution).toBe(true); expect(metadata.facets.goals).toBeNull();
  expect(metadata.authCapabilities).toEqual({ launchLogin: true, completeLogin: false });
  expect(metadata.fileAttachmentMimeTypes).toEqual(['text/plain']);
  second.source.descriptor.label = 'changed'; second.defaults.values.nested.profile = 'changed';
  second.source.attachments.fileMimeTypes.push('application/pdf');
  expect(metadata.descriptor.label).toBe('secondary');
  expect(metadata.defaultSettings.values).toEqual({ nested: { profile: 'secondary' } });
  expect(metadata.fileAttachmentMimeTypes).toEqual(['text/plain']);
  expect(first.unexpected).not.toHaveBeenCalled(); expect(second.unexpected).not.toHaveBeenCalled();
});

test('local metadata preserves independent login capabilities and explicit facet absence', () => {
  const f = fixture('primary');
  const metadata = localProviderMetadata({ ...f.source, attachments: null, auth: { status: f.unexpected, completeLogin: f.unexpected } });
  expect(metadata.authCapabilities).toEqual({ launchLogin: false, completeLogin: true });
  expect(metadata.facets.attachments).toBeNull(); expect(metadata.fileAttachmentMimeTypes).toEqual([]);
  expect(localProviderMetadata({ ...f.source, auth: null }).authCapabilities).toEqual({ launchLogin: false, completeLogin: false });
  expect(f.unexpected).not.toHaveBeenCalled();
});
