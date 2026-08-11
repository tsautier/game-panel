#!/bin/sh
set -eu

RUNTIME_DIR="${RUNTIME_DIR:-/run/rust}"
LOG_PREFIX="[rust-health]"

HEALTHCHECK_PORT="${HEALTHCHECK_PORT:-${RUST_SERVER_PORT:-28015}}"
HEALTHCHECK_REQUIRE_BIND="${HEALTHCHECK_REQUIRE_BIND:-true}"

. /app/common.sh

if ! is_rust_server_running; then
  die "Rust server process is not running."
fi

if is_truthy "${HEALTHCHECK_REQUIRE_BIND}"; then
  if ! ss -H -u -l -n "sport = :${HEALTHCHECK_PORT}" 2>/dev/null | grep -q .; then
    die "Rust game port ${HEALTHCHECK_PORT}/udp is not bound yet."
  fi
fi
