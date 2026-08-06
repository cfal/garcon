import type {
	CompletionSoundMode,
	CompletionSoundVisibility,
} from '$lib/stores/local-settings.svelte.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence.js';

const DATABASE_NAME = 'garcon-local-media';
const DATABASE_VERSION = 1;
const STORE_NAME = 'completion-sounds';
const CUSTOM_SOUND_KEY = 'custom';

export const MAX_CUSTOM_COMPLETION_SOUND_BYTES = 10 * 1024 * 1024;
export const CUSTOM_COMPLETION_SOUND_ACCEPT = '.mp3,.wav,.ogg,audio/mpeg,audio/wav,audio/ogg';

const ALLOWED_CUSTOM_SOUND_TYPES = new Set([
	'audio/mpeg',
	'audio/wav',
	'audio/wave',
	'audio/x-wav',
	'audio/ogg',
]);
const ALLOWED_CUSTOM_SOUND_EXTENSIONS = ['.mp3', '.wav', '.ogg'];

export interface CompletionSoundPreferences {
	mode: CompletionSoundMode;
	volume: number;
	visibility: CompletionSoundVisibility;
}

interface StoredCompletionSound {
	blob: Blob;
	name: string;
	type: string;
}

let audioContext: AudioContext | null = null;
let customBuffer: AudioBuffer | null = null;
let customBufferLoading: Promise<AudioBuffer | null> | null = null;

function extensionAllowed(name: string): boolean {
	const lower = name.toLowerCase();
	return ALLOWED_CUSTOM_SOUND_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function validateCustomCompletionSound(
	file: Pick<File, 'name' | 'size' | 'type'>,
): string | null {
	if (file.size <= 0) return 'empty';
	if (file.size > MAX_CUSTOM_COMPLETION_SOUND_BYTES) return 'too-large';
	if (file.type && !ALLOWED_CUSTOM_SOUND_TYPES.has(file.type)) return 'unsupported-type';
	if (!file.type && !extensionAllowed(file.name)) return 'unsupported-type';
	return null;
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error('IndexedDB transaction failed'));
	});
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Could not open sound storage'));
	});
}

async function runStoreRequest<T>(
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	const database = await openDatabase();
	try {
		const transaction = database.transaction(STORE_NAME, mode);
		const completion = transactionCompletion(transaction);
		const request = operation(transaction.objectStore(STORE_NAME));
		const [result] = await Promise.all([
			new Promise<T>((resolve, reject) => {
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error ?? new Error('Sound storage request failed'));
			}),
			completion,
		]);
		return result;
	} finally {
		database.close();
	}
}

export async function storeCustomCompletionSound(file: File): Promise<void> {
	const validationError = validateCustomCompletionSound(file);
	if (validationError) throw new Error(validationError);
	const decoded = await decodeCustomBlob(file);
	const record: StoredCompletionSound = { blob: file, name: file.name, type: file.type };
	await runStoreRequest('readwrite', (store) => store.put(record, CUSTOM_SOUND_KEY));
	customBuffer = decoded;
	customBufferLoading = null;
}

export async function removeCustomCompletionSound(): Promise<void> {
	await runStoreRequest('readwrite', (store) => store.delete(CUSTOM_SOUND_KEY));
	customBuffer = null;
	customBufferLoading = null;
}

async function readCustomCompletionSound(): Promise<StoredCompletionSound | null> {
	const record = await runStoreRequest<StoredCompletionSound | undefined>('readonly', (store) =>
		store.get(CUSTOM_SOUND_KEY),
	);
	return record ?? null;
}

function getAudioContext(): AudioContext | null {
	if (audioContext) return audioContext;
	if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return null;
	audioContext = new window.AudioContext();
	return audioContext;
}

async function resumeAudioContext(context: AudioContext): Promise<boolean> {
	try {
		if (context.state === 'suspended') await context.resume();
		return context.state === 'running';
	} catch {
		return false;
	}
}

export async function unlockCompletionSound(): Promise<void> {
	const context = getAudioContext();
	if (context) await resumeAudioContext(context);
}

export function installCompletionSoundUnlockListeners(): () => void {
	if (typeof window === 'undefined') return () => undefined;
	const unlock = () => {
		void unlockCompletionSound();
		window.removeEventListener('pointerdown', unlock);
		document.removeEventListener('keydown', unlock);
	};
	const invalidateCustomSound = (event: StorageEvent) => {
		if (event.key === LOCAL_STORAGE_KEYS.localSettings) {
			customBuffer = null;
			customBufferLoading = null;
		}
	};
	window.addEventListener('pointerdown', unlock, { once: true });
	document.addEventListener('keydown', unlock, { once: true });
	window.addEventListener('storage', invalidateCustomSound);
	return () => {
		window.removeEventListener('pointerdown', unlock);
		document.removeEventListener('keydown', unlock);
		window.removeEventListener('storage', invalidateCustomSound);
	};
}

function playDefaultChime(context: AudioContext, volume: number): void {
	const now = context.currentTime;
	const master = context.createGain();
	master.gain.setValueAtTime(volume, now);
	master.connect(context.destination);

	for (const [index, frequency] of [659.25, 880].entries()) {
		const start = now + index * 0.11;
		const oscillator = context.createOscillator();
		const envelope = context.createGain();
		oscillator.type = 'sine';
		oscillator.frequency.setValueAtTime(frequency, start);
		envelope.gain.setValueAtTime(0.0001, start);
		envelope.gain.exponentialRampToValueAtTime(0.35, start + 0.015);
		envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
		oscillator.connect(envelope);
		envelope.connect(master);
		oscillator.start(start);
		oscillator.stop(start + 0.25);
	}
}

async function decodeCustomBlob(blob: Blob): Promise<AudioBuffer> {
	const context = getAudioContext();
	if (!context) throw new Error('AudioContext is unavailable');
	return context.decodeAudioData(await blob.arrayBuffer());
}

async function loadCustomBuffer(context: AudioContext): Promise<AudioBuffer | null> {
	if (customBuffer) return customBuffer;
	if (!customBufferLoading) {
		customBufferLoading = (async () => {
			const record = await readCustomCompletionSound();
			if (!record) return null;
			const decoded = await context.decodeAudioData(await record.blob.arrayBuffer());
			customBuffer = decoded;
			return decoded;
		})().finally(() => {
			customBufferLoading = null;
		});
	}
	return customBufferLoading;
}

async function playCustomSound(context: AudioContext, volume: number): Promise<boolean> {
	const buffer = await loadCustomBuffer(context);
	if (!buffer) return false;
	const source = context.createBufferSource();
	const gain = context.createGain();
	source.buffer = buffer;
	gain.gain.setValueAtTime(volume, context.currentTime);
	source.connect(gain);
	gain.connect(context.destination);
	source.start();
	return true;
}

export function shouldPlayCompletionSound(
	preferences: CompletionSoundPreferences,
	visibilityState: DocumentVisibilityState,
	pageFocused: boolean,
	force = false,
): boolean {
	if (force) return true;
	if (preferences.mode === 'off') return false;
	return preferences.visibility !== 'unfocused' || visibilityState !== 'visible' || !pageFocused;
}

export async function playCompletionSound(
	preferences: CompletionSoundPreferences,
	options: { force?: boolean } = {},
): Promise<void> {
	const visibilityState = typeof document === 'undefined' ? 'hidden' : document.visibilityState;
	const pageFocused = typeof document === 'undefined' ? false : document.hasFocus();
	if (!shouldPlayCompletionSound(preferences, visibilityState, pageFocused, options.force)) return;

	const context = getAudioContext();
	if (!context || !(await resumeAudioContext(context))) return;
	const volume = Math.min(1, Math.max(0, preferences.volume));
	if (volume === 0) return;

	try {
		if (preferences.mode === 'custom') {
			try {
				if (await playCustomSound(context, volume)) return;
			} catch (error) {
				console.warn('[completion-sound] Custom sound failed; using the default', error);
			}
		}
		playDefaultChime(context, volume);
	} catch (error) {
		console.warn('[completion-sound] Playback failed', error);
	}
}
