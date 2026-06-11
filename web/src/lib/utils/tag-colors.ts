export type TagColorVariant =
	| 'blue'
	| 'green'
	| 'amber'
	| 'purple'
	| 'rose'
	| 'teal'
	| 'indigo'
	| 'orange';

const VARIANTS: TagColorVariant[] = [
	'blue',
	'green',
	'amber',
	'purple',
	'rose',
	'teal',
	'indigo',
	'orange',
];

const COLOR_CLASSES: Record<TagColorVariant, string> = {
	blue: 'border-blue-300/50 bg-blue-100/50 text-blue-700 dark:border-blue-600/40 dark:bg-blue-900/30 dark:text-blue-300',
	green:
		'border-green-300/50 bg-green-100/50 text-green-700 dark:border-green-600/40 dark:bg-green-900/30 dark:text-green-300',
	amber:
		'border-amber-300/50 bg-amber-100/50 text-amber-700 dark:border-amber-600/40 dark:bg-amber-900/30 dark:text-amber-300',
	purple:
		'border-purple-300/50 bg-purple-100/50 text-purple-700 dark:border-purple-600/40 dark:bg-purple-900/30 dark:text-purple-300',
	rose: 'border-rose-300/50 bg-rose-100/50 text-rose-700 dark:border-rose-600/40 dark:bg-rose-900/30 dark:text-rose-300',
	teal: 'border-teal-300/50 bg-teal-100/50 text-teal-700 dark:border-teal-600/40 dark:bg-teal-900/30 dark:text-teal-300',
	indigo:
		'border-indigo-300/50 bg-indigo-100/50 text-indigo-700 dark:border-indigo-600/40 dark:bg-indigo-900/30 dark:text-indigo-300',
	orange:
		'border-orange-300/50 bg-orange-100/50 text-orange-700 dark:border-orange-600/40 dark:bg-orange-900/30 dark:text-orange-300',
};

function hashTag(tag: string): number {
	let sum = 0;
	for (let i = 0; i < tag.length; i++) {
		sum += tag.charCodeAt(i);
	}
	return sum % VARIANTS.length;
}

export function getTagColorVariant(tag: string): TagColorVariant {
	return VARIANTS[hashTag(tag)];
}

export function getTagColorClasses(tag: string): string {
	return COLOR_CLASSES[getTagColorVariant(tag)];
}
