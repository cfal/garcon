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
	blue: 'border-tag-blue-border bg-tag-blue text-tag-blue-foreground',
	green: 'border-tag-green-border bg-tag-green text-tag-green-foreground',
	amber: 'border-tag-amber-border bg-tag-amber text-tag-amber-foreground',
	purple: 'border-tag-purple-border bg-tag-purple text-tag-purple-foreground',
	rose: 'border-tag-rose-border bg-tag-rose text-tag-rose-foreground',
	teal: 'border-tag-teal-border bg-tag-teal text-tag-teal-foreground',
	indigo: 'border-tag-indigo-border bg-tag-indigo text-tag-indigo-foreground',
	orange: 'border-tag-orange-border bg-tag-orange text-tag-orange-foreground',
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
