import { isRecord } from '$shared/json';
import { isUsageWindowDays, type UsageWindowDays } from '$shared/usage';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence.js';
import type { UsageMetric } from './usage-report.js';

// The executor selection is deliberately not persisted: it is an executor reference,
// and the surface falls back to Local on every load.
export interface UsagePreferences {
	readonly windowDays: UsageWindowDays;
	readonly metric: UsageMetric;
}

export interface UsagePreferencesPersistence {
	read(): string | null;
	write(value: string): void;
}

export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = { windowDays: 30, metric: 'cost' };

const browserPersistence: UsagePreferencesPersistence = {
	read: () => getLocalStorageItem(LOCAL_STORAGE_KEYS.usagePreferences),
	write: (value) => setLocalStorageItem(LOCAL_STORAGE_KEYS.usagePreferences, value),
};

export function readUsagePreferences(
	persistence: UsagePreferencesPersistence = browserPersistence,
): UsagePreferences {
	let value: unknown;
	try {
		value = JSON.parse(persistence.read() ?? 'null');
	} catch {
		return DEFAULT_USAGE_PREFERENCES;
	}
	if (!isRecord(value)) return DEFAULT_USAGE_PREFERENCES;
	return {
		windowDays: isUsageWindowDays(value.windowDays)
			? value.windowDays
			: DEFAULT_USAGE_PREFERENCES.windowDays,
		metric:
			value.metric === 'cost' || value.metric === 'tokens'
				? value.metric
				: DEFAULT_USAGE_PREFERENCES.metric,
	};
}

export function saveUsagePreferences(
	preferences: UsagePreferences,
	persistence: UsagePreferencesPersistence = browserPersistence,
): void {
	persistence.write(JSON.stringify(preferences));
}
