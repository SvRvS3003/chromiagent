#!/bin/zsh -i
# Chromiagent agent launcher, by SvRvS.
# Chrome-only: Claude Code's own shell/file tools are off. The agent gets the quick tab tools and
# TypeScript code mode (Playwright MCP + tab tools as typed APIs, sandboxed) on the user's real Chrome.
dir=${0:A:h}
node=$(command -v node)
mcp="{\"mcpServers\":{
  \"chrome\":{\"command\":\"$node\",\"args\":[\"$dir/mcp.js\"]},
  \"codemode\":{\"command\":\"$dir/sandbox.sh\"}}}"
claude --tools "" --strict-mcp-config --mcp-config "$mcp" \
  --append-system-prompt "$(<"$dir/agent-prompt.md")" "$@"
