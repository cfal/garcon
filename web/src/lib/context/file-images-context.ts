import { createContext } from 'svelte';
import type { FileImageCache } from '$lib/files/images/file-image-cache.svelte.js';

export const [getFileImages, setFileImages, hasFileImages] = createContext<FileImageCache>();
