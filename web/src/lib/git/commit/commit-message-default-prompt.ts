export const DEFAULT_COMMIT_MESSAGE_PROMPT = `Write a high-quality Conventional Commit message based on the staged changes.

Strict output rules:
- Return plain text only. Do not include markdown, code fences, labels, or commentary.
- First line must follow: type(scope): subject
- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject must be imperative, specific, and 50 characters or fewer
- Add a body only when it improves clarity; wrap body lines to 72 characters or fewer

Content guidance:
- Prioritize user-visible behavior changes
- Include critical technical context when behavior changes depend on it
- Reflect both additions and removals when relevant
- Avoid vague subjects such as "update files" or "misc changes"

Changed files:
{{files}}

Diff excerpt:
{{diff}}

Return only the commit message now.`;
