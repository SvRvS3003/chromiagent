#!/bin/zsh
# Chromiagent, by SvRvS: starts code mode (host/codemode.js) inside a macOS sandbox.
# Code mode and the Playwright MCP it starts cannot read or write the user's home folder
# (except Chromiagent itself), so scripts the agent writes stay inside the browser.
dir=${0:A:h:h}
out=/private/tmp/chromiagent-playwright
mkdir -p $out && cd $out
home=$HOME
# Playwright keeps registry/cache under HOME, which is blocked: give it the scratch folder as HOME.
HOME=$out CHROMIAGENT_OUT=$out exec sandbox-exec -p "(version 1)
(allow default)
(deny file-read* file-write* (subpath \"$home\"))
(allow file-read-metadata (literal \"$home\"))
(allow file-read* (subpath \"$dir\"))
(allow file-read* file-write* (subpath \"$out\"))" \
  "$(command -v node)" --disable-warning=ExperimentalWarning "$dir/host/codemode.js"
