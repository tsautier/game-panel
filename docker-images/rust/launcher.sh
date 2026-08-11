#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
RUST_INSTALL_DIR="${RUST_INSTALL_DIR:-${DATA_DIR}/server}"
RUST_BINARY="${RUST_BINARY:-${RUST_INSTALL_DIR}/RustDedicated}"
RUNTIME_DIR="${RUNTIME_DIR:-/run/rust}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-300}"

RUST_SERVER_IDENTITY="${RUST_SERVER_IDENTITY:-rust-server}"

RUST_SERVER_PORT="${RUST_SERVER_PORT:-28015}"
RUST_QUERY_PORT="${RUST_QUERY_PORT:-28017}"
RUST_RCON_PORT="${RUST_RCON_PORT:-28016}"
RUST_APP_PORT="${RUST_APP_PORT:-28082}"

RUST_RCON_ENABLED="${RUST_RCON_ENABLED:-true}"
RUST_RCON_PASSWORD="${RUST_RCON_PASSWORD:-}"
RUST_RUSTPLUS_ENABLED="${RUST_RUSTPLUS_ENABLED:-true}"

RUST_START_PARAMS="${RUST_START_PARAMS:-}"

LOG_PREFIX="[rust]"

. /app/common.sh

PID_FILE="$(rust_pid_file_path)"
RCON_PW_FILE="$(rust_rcon_password_file)"
RCON_PORT_FILE="$(rust_rcon_port_file)"

STOP_REQUESTED="false"

mkdir -p "${RUNTIME_DIR}"

cleanup() {
  rm -f "${PID_FILE}" "${RCON_PW_FILE}" "${RCON_PORT_FILE}"
}
trap cleanup EXIT

graceful_stop() {
  if [ "${STOP_REQUESTED}" = "true" ]; then
    return 0
  fi

  STOP_REQUESTED="true"

  if is_rust_server_running; then
    RUNNING_PID="$(read_rust_pid)"

    if is_truthy "${RUST_RCON_ENABLED}"; then
      log "Shutdown requested, sending 'quit' over RCON (saves the world and exits)..."
      rust_rcon_send "quit" >/dev/null 2>&1 || log "Could not reach RCON; falling back to signals."
    else
      log "Shutdown requested (RCON disabled); sending SIGTERM..."
      kill -TERM "${RUNNING_PID}" 2>/dev/null || true
    fi

    DEADLINE=$(( $(date +%s) + STOP_TIMEOUT_SECONDS ))

    while kill -0 "${RUNNING_PID}" 2>/dev/null; do
      if [ "$(date +%s)" -ge "${DEADLINE}" ]; then
        log "Rust did not stop in time, killing process..."
        kill -TERM "${RUNNING_PID}" 2>/dev/null || true
        sleep 2
        kill -KILL "${RUNNING_PID}" 2>/dev/null || true
        break
      fi

      sleep 1
    done
  fi
}

trap graceful_stop TERM INT

if [ ! -x "${RUST_BINARY}" ]; then
  die "RustDedicated binary not found: ${RUST_BINARY}"
fi

rm -f "${RCON_PW_FILE}" "${RCON_PORT_FILE}"
if is_truthy "${RUST_RCON_ENABLED}"; then
  ( umask 077; printf '%s' "${RUST_RCON_PASSWORD}" > "${RCON_PW_FILE}" )
  printf '%s' "${RUST_RCON_PORT}" > "${RCON_PORT_FILE}"
fi

cd "${RUST_INSTALL_DIR}"

export LD_LIBRARY_PATH="${RUST_INSTALL_DIR}:${RUST_INSTALL_DIR}/RustDedicated_Data/Plugins/x86_64:${LD_LIBRARY_PATH:-}"

set -- "${RUST_BINARY}" \
  -batchmode \
  +server.identity "${RUST_SERVER_IDENTITY}" \
  +server.port "${RUST_SERVER_PORT}" \
  +server.queryport "${RUST_QUERY_PORT}"

if is_truthy "${RUST_RCON_ENABLED}"; then
  set -- "$@" \
    +rcon.web 1 \
    +rcon.port "${RUST_RCON_PORT}" \
    +rcon.password "${RUST_RCON_PASSWORD}"
fi

if is_truthy "${RUST_RUSTPLUS_ENABLED}"; then
  set -- "$@" +app.port "${RUST_APP_PORT}"
fi

if [ -n "${RUST_START_PARAMS}" ]; then
  set -f
  set -- "$@" ${RUST_START_PARAMS}
  set +f
fi

"$@" < /dev/null &
RUST_PID=$!

echo "${RUST_PID}" > "${PID_FILE}"
log "Server PID: ${RUST_PID}"
log "Launching Rust dedicated server (identity: ${RUST_SERVER_IDENTITY}, port: ${RUST_SERVER_PORT}/udp)..."

EXIT_CODE=0

while :; do
  if wait "${RUST_PID}"; then
    EXIT_CODE=0
    break
  fi

  EXIT_CODE=$?

  if kill -0 "${RUST_PID}" 2>/dev/null; then
    continue
  fi

  break
done

log "Rust server exited with code ${EXIT_CODE}"
exit "${EXIT_CODE}"
