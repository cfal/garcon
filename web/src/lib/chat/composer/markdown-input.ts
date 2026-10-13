import { literalInputFormat, type InputFormatByModel } from '$shared/input-format';

interface MarkdownInputAgent {
	executionPolicy: 'conversation' | 'literal';
	inputFormatByModel: InputFormatByModel;
}

/**
 * Reports whether a draft for this agent and model may be edited as formatted Markdown.
 * Literal input reaches its target verbatim and formatted editing rewrites Markdown-looking
 * text such as `_name_`, so a literal model must declare Markdown input.
 */
export function acceptsMarkdownInput(
	agent: MarkdownInputAgent | null | undefined,
	model: string,
): boolean {
	if (!agent) return false;
	return (
		agent.executionPolicy !== 'literal' ||
		literalInputFormat(agent.inputFormatByModel, model) === 'markdown'
	);
}
