---
"@zucker-framework/ai-access": patch
---

Add `AnthropicClaudeCliSubscriptionProvider` (`anthropic-claude-cli`), a text inference adapter for an installed, logged-in Claude Code CLI (`claude -p`). The prompt is sent on stdin and the system prompt through a private temporary file; calls run without built-in tools, MCP servers, slash commands, user/project settings, hooks, plugins, CLAUDE.md discovery or session persistence. Requests with `onTextDelta` use `stream-json` partial messages; others parse the single `json` result. Results report the stop reason, the resolved model and token usage including the prompt-cache split. API keys cannot be injected into the subscription environment. `AIAccessResult` gains optional `model` and `tokenUsage.cacheReadInput` / `cacheCreationInput` fields.
