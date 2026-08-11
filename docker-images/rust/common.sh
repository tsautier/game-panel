#!/bin/sh

LOG_PREFIX="${LOG_PREFIX:-[app]}"

log() {
  printf '%s %s\n' "${LOG_PREFIX}" "$*"
}

die() {
  printf '%s ERROR: %s\n' "${LOG_PREFIX}" "$*" >&2
  exit 1
}

is_truthy() {
  case "$1" in
    1|[Tt][Rr][Uu][Ee]|[Yy]|[Yy][Ee][Ss]|[Oo][Nn])
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

assert_safe_data_dir() {
  case "${DATA_DIR:-}" in
    ""|"/")
      die "Refusing to operate on unsafe DATA_DIR='${DATA_DIR:-}'."
      ;;
  esac
}

assert_writable_dir() {
  TARGET_DIR="$1"
  TEST_FILE="${TARGET_DIR}/.writable-check-$$"

  if ! mkdir -p "${TARGET_DIR}" 2>/dev/null; then
    die "Directory '${TARGET_DIR}' cannot be created or accessed by user '$(id -un)' (uid=$(id -u), gid=$(id -g))."
  fi

  if ! : > "${TEST_FILE}" 2>/dev/null; then
    die "Directory '${TARGET_DIR}' is not writable by user '$(id -un)' (uid=$(id -u), gid=$(id -g))."
  fi

  rm -f "${TEST_FILE}"
}

rust_pid_file_path() {
  printf '%s/server.pid\n' "${RUNTIME_DIR:-/run/rust}"
}

read_rust_pid() {
  RUST_PID_FILE="$(rust_pid_file_path)"

  [ -f "${RUST_PID_FILE}" ] || return 1

  RUST_PID="$(cat "${RUST_PID_FILE}" 2>/dev/null || true)"
  case "${RUST_PID}" in
    ""|*[!0-9]*)
      return 1
      ;;
  esac

  printf '%s\n' "${RUST_PID}"
}

is_rust_server_running() {
  RUNNING_PID="$(read_rust_pid)" || return 1
  kill -0 "${RUNNING_PID}" 2>/dev/null
}

assert_rust_server_stopped() {
  if RUNNING_PID="$(read_rust_pid)" && kill -0 "${RUNNING_PID}" 2>/dev/null; then
    die "Rust server is still running with PID ${RUNNING_PID}. Stop the server before running this operation."
  fi
}

rust_rcon_password_file() {
  printf '%s/rcon.password\n' "${RUNTIME_DIR:-/run/rust}"
}

rust_rcon_port_file() {
  printf '%s/rcon.port\n' "${RUNTIME_DIR:-/run/rust}"
}

generate_rcon_password() {
  tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24
}

rust_rcon_send() {
  RCON_CMD="$*"
  RCON_PW_FILE="$(rust_rcon_password_file)"
  RCON_PORT_FILE="$(rust_rcon_port_file)"

  [ -f "${RCON_PW_FILE}" ] || return 1
  RCON_PASSWORD="$(cat "${RCON_PW_FILE}" 2>/dev/null || true)"
  [ -n "${RCON_PASSWORD}" ] || return 1

  RCON_PORT="$(cat "${RCON_PORT_FILE}" 2>/dev/null || true)"
  RCON_PORT="${RCON_PORT:-28016}"

  RCON_PAYLOAD="$(jq -nc --arg m "${RCON_CMD}" '{Identifier: 1, Message: $m, Name: "WebRcon"}')"

  RCON_RC=0
  printf '%s\n' "${RCON_PAYLOAD}" \
    | timeout "${RCON_TIMEOUT_SECONDS:-2}" websocat -n -t "ws://127.0.0.1:${RCON_PORT}/${RCON_PASSWORD}" \
    || RCON_RC=$?

  if [ "${RCON_RC}" -ne 0 ] && [ "${RCON_RC}" -ne 124 ]; then
    return "${RCON_RC}"
  fi

  return 0
}

rust_rcon_save_and_wait() {
  RCON_PW_FILE="$(rust_rcon_password_file)"
  RCON_PORT_FILE="$(rust_rcon_port_file)"

  [ -f "${RCON_PW_FILE}" ] || return 1
  RCON_PASSWORD="$(cat "${RCON_PW_FILE}" 2>/dev/null || true)"
  [ -n "${RCON_PASSWORD}" ] || return 1
  RCON_PORT="$(cat "${RCON_PORT_FILE}" 2>/dev/null || true)"
  RCON_PORT="${RCON_PORT:-28016}"

  SAVE_MAX="${RCON_SAVE_TIMEOUT_SECONDS:-60}"
  SAVE_PAYLOAD="$(jq -nc '{Identifier: 1, Message: "save", Name: "WebRcon"}')"
  SAVE_OUT="$(mktemp)"

  printf '%s\n' "${SAVE_PAYLOAD}" \
    | timeout "${SAVE_MAX}" websocat -n -t "ws://127.0.0.1:${RCON_PORT}/${RCON_PASSWORD}" \
    > "${SAVE_OUT}" 2>/dev/null &
  SAVE_WS_PID=$!

  SAVE_DEADLINE=$(( $(date +%s) + SAVE_MAX ))
  SAVE_DONE="false"
  while [ "$(date +%s)" -lt "${SAVE_DEADLINE}" ]; do
    if grep -q "Saving complete" "${SAVE_OUT}" 2>/dev/null; then
      SAVE_DONE="true"
      break
    fi
    kill -0 "${SAVE_WS_PID}" 2>/dev/null || break
    sleep 1
  done

  kill "${SAVE_WS_PID}" 2>/dev/null || true
  wait "${SAVE_WS_PID}" 2>/dev/null || true
  rm -f "${SAVE_OUT}"

  [ "${SAVE_DONE}" = "true" ]
}

download_to_file() {
  DOWNLOAD_URL="$1"
  DOWNLOAD_DEST="$2"
  DOWNLOAD_DEST_DIR="$(dirname "${DOWNLOAD_DEST}")"

  mkdir -p "${DOWNLOAD_DEST_DIR}"
  DOWNLOAD_TMP="$(mktemp "${DOWNLOAD_DEST_DIR}/.download.XXXXXX")"

  if ! curl -fsSL \
    --retry "${CURL_RETRY_COUNT:-3}" \
    --retry-delay "${CURL_RETRY_DELAY_SECONDS:-2}" \
    --connect-timeout "${CURL_CONNECT_TIMEOUT_SECONDS:-15}" \
    --max-time "${CURL_MAX_TIME_SECONDS:-300}" \
    -o "${DOWNLOAD_TMP}" \
    "${DOWNLOAD_URL}"; then
    rm -f "${DOWNLOAD_TMP}"
    return 1
  fi

  mv "${DOWNLOAD_TMP}" "${DOWNLOAD_DEST}"
}

overlay_directory_contents() {
  SOURCE_DIR="$1"
  TARGET_DIR="$2"

  mkdir -p "${TARGET_DIR}"
  cp -a "${SOURCE_DIR}/." "${TARGET_DIR}/"
}

oxide_is_installed() {
  OXIDE_MARKER="${RUST_INSTALL_DIR:-${DATA_DIR:-/data}/server}/RustDedicated_Data/Managed/Oxide.Rust.dll"
  [ -f "${OXIDE_MARKER}" ]
}
