#!/bin/zsh -i
# Chromiagent agent launcher, by SvRvS.
# Chrome-only: Claude Code's own shell/file tools are off, only the Chrome tools stay on.
dir=${0:A:h}
mcp="{\"mcpServers\":{\"chrome\":{\"command\":\"$(command -v node)\",\"args\":[\"$dir/mcp.js\"]}}}"
claude --chrome --tools "" --disallowedTools mcp__claude-in-chrome__file_upload \
  --strict-mcp-config --mcp-config "$mcp" \
  --append-system-prompt "$(<"$dir/agent-prompt.md")" "$@"
