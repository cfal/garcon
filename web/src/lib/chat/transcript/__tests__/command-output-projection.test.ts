import { describe, expect, it } from 'vitest';
import { CommandOutputMessage, CommandResultMessage, TranscriptNoticeMessage } from '$shared/chat-types';
import { projectCommandOutput } from '../command-output-projection';

const context = { executorId: 'local', projectPath: '/workspace' };
const at = '2026-01-01T00:00:00.000Z';
const terminal = new CommandResultMessage(at, 'command-1', {
	outcome: 'finished', exitCode: 0, signal: null, capture: 'complete',
	cwd: { kind: 'reported', path: '/workspace' },
});
function stdout(content: string, offset = 0) {
	return new CommandOutputMessage(at, 'command-1', 'stdout', 'markdown', content, context, offset);
}

describe('command Markdown documents', () => {
	it('does not promote a delivered prefix when a gap precedes the complete native result', () => {
		const gap = new TranscriptNoticeMessage(at, 'Reload native history.', { type: 'publication-gap' }, 'Output not delivered');
		expect(projectCommandOutput([stdout('```text\nprefix'), gap, terminal]).get(0)?.message.format).toBe('plain');
		expect(projectCommandOutput([gap, stdout('# complete'), terminal]).get(1)?.message.format).toBe('markdown');
		expect(projectCommandOutput([stdout('# complete'), terminal, gap]).get(0)?.message.format).toBe('markdown');
	});
	it('keeps stdout one document across stderr and the former 256 KiB boundary', () => {
		const first = '```text\n' + 'x'.repeat(300 * 1024);
		const last = '\n# still code\n```';
		const result = projectCommandOutput([
			stdout(first), new CommandOutputMessage(at, 'command-1', 'stderr', 'plain', 'diagnostic', context),
			stdout(last, first.length), terminal,
		]);
		expect(result.get(0)?.message.content).toBe(first + last);
		expect(result.get(2)?.parentIndex).toBe(0);
		expect(result.get(1)?.message.format).toBe('plain');
		expect(result.get(0)?.message.format).toBe('markdown');
	});
	it('renders a partial paged prefix or an output gap literally', () => {
		for (const chunks of [[stdout('# inside fence', 10)], [stdout('```'), stdout('# gap', 20)]]) {
			const result = projectCommandOutput(chunks);
			for (const [index, projection] of result) {
				expect(projection.parentIndex).toBe(index);
				expect(projection.message.format).toBe('plain');
				expect(projection.message.content).toBe(chunks[index].content);
			}
		}
	});
});
