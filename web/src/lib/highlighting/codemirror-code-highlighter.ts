import { tagHighlighter, tags } from '@lezer/highlight';

export const codeTagHighlighter = tagHighlighter([
	{
		tag: [
			tags.keyword,
			tags.operatorKeyword,
			tags.controlKeyword,
			tags.definitionKeyword,
			tags.moduleKeyword,
			tags.modifier,
			tags.self,
			tags.null,
		],
		class: 'cm-code-keyword',
	},
	{
		tag: [
			tags.className,
			tags.definition(tags.variableName),
			tags.definition(tags.propertyName),
			tags.function(tags.variableName),
			tags.function(tags.propertyName),
			tags.macroName,
		],
		class: 'cm-code-title',
	},
	{
		tag: [
			tags.number,
			tags.bool,
			tags.literal,
			tags.operator,
			tags.variableName,
			tags.labelName,
			tags.namespace,
			tags.annotation,
			tags.attributeName,
		],
		class: 'cm-code-meta',
	},
	{
		tag: [
			tags.string,
			tags.docString,
			tags.character,
			tags.attributeValue,
			tags.regexp,
			tags.escape,
			tags.special(tags.string),
		],
		class: 'cm-code-string',
	},
	{
		tag: [tags.atom, tags.unit, tags.color, tags.url, tags.standard(tags.variableName)],
		class: 'cm-code-symbol',
	},
	{
		tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
		class: 'cm-code-comment',
	},
	{
		tag: [
			tags.name,
			tags.typeName,
			tags.tagName,
			tags.propertyName,
			tags.attributeName,
			tags.processingInstruction,
		],
		class: 'cm-code-name',
	},
	{
		tag: [tags.heading, tags.contentSeparator, tags.list, tags.quote],
		class: 'cm-code-section',
	},
	{ tag: tags.inserted, class: 'cm-code-addition' },
	{ tag: tags.deleted, class: 'cm-code-deletion' },
	{ tag: tags.invalid, class: 'cm-code-invalid' },
]);
