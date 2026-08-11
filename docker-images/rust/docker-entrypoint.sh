#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
RUST_INSTALL_DIR="${RUST_INSTALL_DIR:-${DATA_DIR}/server}"
RUNTIME_DIR="${RUNTIME_DIR:-/run/rust}"
STEAMCMD_DIR="${STEAMCMD_DIR:-/opt/steamcmd}"
RUST_STEAM_APP_ID="${RUST_STEAM_APP_ID:-258550}"
RUST_UPDATE_ON_START="${RUST_UPDATE_ON_START:-false}"
RUST_VALIDATE_ON_START="${RUST_VALIDATE_ON_START:-false}"
RUST_RCON_ENABLED="${RUST_RCON_ENABLED:-true}"
RUST_RCON_PASSWORD="${RUST_RCON_PASSWORD:-}"

LOG_PREFIX="[rust]"

. /app/common.sh

RUST_BINARY="${RUST_BINARY:-${RUST_INSTALL_DIR}/RustDedicated}"
STEAMCMD_BIN="${STEAMCMD_DIR}/steamcmd.sh"

log "Starting bootstrap..."

if [ "$#" -gt 0 ]; then
  log "Custom command requested, bypassing server bootstrap."
  exec "$@"
fi

assert_safe_data_dir
assert_writable_dir "${DATA_DIR}"
assert_writable_dir "${RUNTIME_DIR}"
assert_writable_dir "${RUST_INSTALL_DIR}"

if is_truthy "${RUST_RCON_ENABLED}" && [ -z "${RUST_RCON_PASSWORD}" ]; then
  RUST_RCON_PASSWORD="$(generate_rcon_password)"
  log "RUST_RCON_PASSWORD was not provided; generated one for this server."
fi

if is_truthy "${RUST_RCON_ENABLED}" && [ "$(printf '%s' "${RUST_RCON_PASSWORD}" | wc -c)" -lt 8 ]; then
  die "RUST_RCON_PASSWORD must be at least 8 characters (Rust disables RCON below that, breaking console commands)."
fi

export RUST_RCON_ENABLED
export RUST_RCON_PASSWORD

if [ ! -x "${STEAMCMD_BIN}" ]; then
  die "SteamCMD executable not found: ${STEAMCMD_BIN}"
fi

setup_steam_runtime_paths() {
  mkdir -p "${HOME}/.steam/sdk64" "${HOME}/.steam/sdk32"

  if [ -f "${STEAMCMD_DIR}/linux64/steamclient.so" ]; then
    ln -sf "${STEAMCMD_DIR}/linux64/steamclient.so" "${HOME}/.steam/sdk64/steamclient.so"
  fi

  if [ -f "${STEAMCMD_DIR}/linux32/steamclient.so" ]; then
    ln -sf "${STEAMCMD_DIR}/linux32/steamclient.so" "${HOME}/.steam/sdk32/steamclient.so"
  fi
}

install_or_update_rust() {
  UPDATE_REASON=""
  VALIDATE_APP="false"

  if [ ! -x "${RUST_BINARY}" ]; then
    UPDATE_REASON="server files are missing"
    VALIDATE_APP="true"
  elif is_truthy "${RUST_UPDATE_ON_START}"; then
    UPDATE_REASON="RUST_UPDATE_ON_START is enabled"
  fi

  if is_truthy "${RUST_VALIDATE_ON_START}"; then
    VALIDATE_APP="true"
  fi

  if [ -z "${UPDATE_REASON}" ] && [ "${VALIDATE_APP}" != "true" ]; then
    log "Found existing Rust installation, skipping SteamCMD update."
    return 0
  fi

  if [ -n "${UPDATE_REASON}" ]; then
    log "Running SteamCMD update because ${UPDATE_REASON}."
  else
    log "Running SteamCMD validation."
  fi

  set -- "${STEAMCMD_BIN}" \
    +force_install_dir "${RUST_INSTALL_DIR}" \
    +login anonymous \
    +app_update "${RUST_STEAM_APP_ID}"

  if [ "${VALIDATE_APP}" = "true" ]; then
    set -- "$@" validate
  fi

  set -- "$@" +quit

  STEAMCMD_MAX_ATTEMPTS="${STEAMCMD_MAX_ATTEMPTS:-5}"
  STEAMCMD_RETRY_DELAY_SECONDS="${STEAMCMD_RETRY_DELAY_SECONDS:-10}"
  ATTEMPT=1
  STEAMCMD_OUTPUT="$(mktemp "${RUNTIME_DIR}/steamcmd-output.XXXXXX")"
  STEAMCMD_EXIT_CODE_FILE="${STEAMCMD_OUTPUT}.exit-code"

  while :; do
    : > "${STEAMCMD_OUTPUT}"
    rm -f "${STEAMCMD_EXIT_CODE_FILE}"

    (
      set +e
      "$@"
      printf '%s\n' "$?" > "${STEAMCMD_EXIT_CODE_FILE}"
    ) 2>&1 | tee "${STEAMCMD_OUTPUT}"

    if [ ! -f "${STEAMCMD_EXIT_CODE_FILE}" ]; then
      rm -f "${STEAMCMD_OUTPUT}"
      die "SteamCMD exit code could not be determined."
    fi

    STEAMCMD_EXIT_CODE="$(cat "${STEAMCMD_EXIT_CODE_FILE}")"

    if [ "${STEAMCMD_EXIT_CODE}" -eq 0 ]; then
      rm -f "${STEAMCMD_OUTPUT}" "${STEAMCMD_EXIT_CODE_FILE}"
      break
    fi

    if ! grep -Fq "Failed to install app '${RUST_STEAM_APP_ID}' (Missing configuration)" "${STEAMCMD_OUTPUT}"; then
      rm -f "${STEAMCMD_OUTPUT}" "${STEAMCMD_EXIT_CODE_FILE}"
      die "SteamCMD failed with exit code ${STEAMCMD_EXIT_CODE}."
    fi

    if [ "${ATTEMPT}" -ge "${STEAMCMD_MAX_ATTEMPTS}" ]; then
      rm -f "${STEAMCMD_OUTPUT}" "${STEAMCMD_EXIT_CODE_FILE}"
      die "SteamCMD failed after ${ATTEMPT} attempt(s) with the known transient 'Missing configuration' error."
    fi

    log "SteamCMD attempt ${ATTEMPT}/${STEAMCMD_MAX_ATTEMPTS} failed with the known transient 'Missing configuration' error; retrying in ${STEAMCMD_RETRY_DELAY_SECONDS}s..."
    ATTEMPT=$((ATTEMPT + 1))
    sleep "${STEAMCMD_RETRY_DELAY_SECONDS}"
  done
}

install_or_update_rust

setup_steam_runtime_paths

if [ ! -x "${RUST_BINARY}" ]; then
  die "RustDedicated binary is not executable after install/update: ${RUST_BINARY}"
fi

export DATA_DIR
export RUST_INSTALL_DIR
export RUST_BINARY
export RUNTIME_DIR

log "Bootstrap complete, handing over to launcher..."
exec /app/launcher.sh
