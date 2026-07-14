export const FONT_SIZE_OPTIONS = ['10', '11', '12', '13', '14', '15', '16', '18', '20'] as const;

export type FontSizeOption = (typeof FONT_SIZE_OPTIONS)[number];

export function isFontSizeOption(value: unknown): value is FontSizeOption {
	return typeof value === 'string' && FONT_SIZE_OPTIONS.includes(value as FontSizeOption);
}

export function parseFontSizeOption(value: unknown, fallback: FontSizeOption): FontSizeOption {
	return isFontSizeOption(value) ? value : fallback;
}
