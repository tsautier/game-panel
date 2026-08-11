#!/bin/sh
set -eu

RUNTIME_DIR="${RUNTIME_DIR:-/run/rust}"
LOG_PREFIX="[rust-cmd]"

. /app/common.sh

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <rust console command>"
  exit 1
fi

COMMAND="$*"

if ! is_rust_server_running; then
  die "Rust server is not running."
fi

if [ ! -f "$(rust_rcon_password_file)" ]; then
  die "RCON is disabled; console commands are unavailable. Enable RCON to use this feature."
fi

rust_rcon_send "${COMMAND}" || die "Failed to send command over RCON: ${COMMAND}"
