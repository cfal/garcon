import {
	BashToolUseMessage,
	PermissionCancelledMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	ToolResultMessage,
} from '$shared/chat-types'
import type { ChatMessage } from '$shared/chat-types'

export type ConversationFeedRenderItem =
	| {
			kind: 'message'
			id: string
			message: ChatMessage
			index: number
			prevMessage: ChatMessage | null
	  }
	| {
			kind: 'bash-group'
			id: string
			messages: BashToolUseMessage[]
			index: number
			prevMessage: ChatMessage | null
	  }

function shouldSkipStandaloneMessage(message: ChatMessage): boolean {
	return (
		message instanceof ToolResultMessage ||
		message instanceof PermissionResolvedMessage ||
		message instanceof PermissionCancelledMessage ||
		(message instanceof PermissionRequestMessage && message.requestedTool.type === 'exit-plan-mode-tool-use')
	)
}

function bashGroupId(messages: BashToolUseMessage[]): string {
	return `bash-group-${messages.map((message) => message.toolId).join('-')}`
}

export function buildConversationFeedRenderItems(messages: ChatMessage[]): ConversationFeedRenderItem[] {
	const items: ConversationFeedRenderItem[] = []
	let previousRenderable: ChatMessage | null = null
	let index = 0

	while (index < messages.length) {
		const message = messages[index]

		if (shouldSkipStandaloneMessage(message)) {
			index += 1
			continue
		}

		if (message instanceof BashToolUseMessage) {
			const group: BashToolUseMessage[] = []
			const prevMessage = previousRenderable
			const firstIndex = index

			while (index < messages.length) {
				const candidate = messages[index]
				if (candidate instanceof ToolResultMessage) {
					index += 1
					continue
				}
				if (!(candidate instanceof BashToolUseMessage)) break
				group.push(candidate)
				previousRenderable = candidate
				index += 1
			}

			if (group.length > 1) {
				items.push({
					kind: 'bash-group',
					id: bashGroupId(group),
					messages: group,
					index: firstIndex,
					prevMessage,
				})
			} else {
				items.push({
					kind: 'message',
					id: group[0].toolId,
					message: group[0],
					index: firstIndex,
					prevMessage,
				})
			}
			continue
		}

		items.push({
			kind: 'message',
			id: `${message.type}-${index}`,
			message,
			index,
			prevMessage: previousRenderable,
		})
		previousRenderable = message
		index += 1
	}

	return items
}
