#!/usr/bin/env bash
# Shared install/start preflight. Resolve trusted helper paths in the parent shell
# so the same binaries are used after worker environments have been filtered.
PI_SCIENCE_SANDBOX_CHECK_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-linux-sandbox.mjs"
pi_science_check_linux_sandbox() {
  [ "$(uname -s)" = Linux ] || return 0
  if [ "${PI_SCIENCE_EXECUTION_MODE:-required}" = trusted-host ]; then
    echo "  Linux sandbox preflight skipped: operator explicitly selected trusted-host mode"
    return 0
  fi
  local node_command="$1" helper
  echo "==> Checking Linux sandbox prerequisites..."
  helper="$("$node_command" "$PI_SCIENCE_SANDBOX_CHECK_SCRIPT" --tool rg)" || return 1
  export PI_SCIENCE_SANDBOX_RIPGREP="$helper"
  helper="$("$node_command" "$PI_SCIENCE_SANDBOX_CHECK_SCRIPT" --tool socat)" || return 1
  export PI_SCIENCE_SANDBOX_SOCAT="$helper"
  helper="$("$node_command" "$PI_SCIENCE_SANDBOX_CHECK_SCRIPT" --tool bwrap)" || return 1
  export PI_SCIENCE_SANDBOX_BWRAP="$helper"
  "$node_command" "$PI_SCIENCE_SANDBOX_CHECK_SCRIPT" --probe || return 1
}
