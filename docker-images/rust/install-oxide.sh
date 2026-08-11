#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
RUST_INSTALL_DIR="${RUST_INSTALL_DIR:-${DATA_DIR}/server}"
RUNTIME_DIR="${RUNTIME_DIR:-/run/rust}"
OXIDE_VERSION_INPUT="${1:-${OXIDE_VERSION:-latest}}"
OXIDE_REPOSITORY="${OXIDE_REPOSITORY:-OxideMod/Oxide.Rust}"
OXIDE_ASSET="${OXIDE_ASSET:-Oxide.Rust-linux.zip}"
OXIDE_RELEASES_BASE="${OXIDE_RELEASES_BASE:-https://github.com/${OXIDE_REPOSITORY}/releases}"
LOG_PREFIX="[rust-oxide]"

. /app/common.sh

RUST_BINARY="${RUST_BINARY:-${RUST_INSTALL_DIR}/RustDedicated}"
OXIDE_PLUGINS_DIR="${OXIDE_PLUGINS_DIR:-${RUST_INSTALL_DIR}/oxide/plugins}"

WORK_DIR=""

cleanup() {
  if [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}" ]; then
    rm -rf "${WORK_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM HUP

resolve_download_url() {
  if [ "${OXIDE_VERSION_INPUT}" = "latest" ]; then
    printf '%s\n' "${OXIDE_RELEASES_BASE}/latest/download/${OXIDE_ASSET}"
  else
    printf '%s\n' "${OXIDE_RELEASES_BASE}/download/${OXIDE_VERSION_INPUT}/${OXIDE_ASSET}"
  fi
}

assert_safe_data_dir

if [ ! -x "${RUST_BINARY}" ]; then
  die "Rust is not installed yet (${RUST_BINARY} missing). Install the game before Oxide."
fi

assert_writable_dir "${RUST_INSTALL_DIR}"
mkdir -p "${RUNTIME_DIR}"

if is_rust_server_running; then
  die "Rust server is running in this container. Stop it before installing Oxide."
fi

DOWNLOAD_URL="$(resolve_download_url)"

log "Installing Oxide/uMod for Rust."
log "Requested version: ${OXIDE_VERSION_INPUT}"
log "Download URL: ${DOWNLOAD_URL}"

if oxide_is_installed; then
  log "Existing Oxide installation detected. Applying overlay update."
else
  log "No Oxide installation detected. Installing fresh files."
fi

WORK_DIR="$(mktemp -d "${RUNTIME_DIR}/oxide-install.XXXXXX")"
ARCHIVE_PATH="${WORK_DIR}/oxide.zip"
STAGE_DIR="${WORK_DIR}/stage"

download_to_file "${DOWNLOAD_URL}" "${ARCHIVE_PATH}" \
  || die "Failed to download Oxide from ${DOWNLOAD_URL}."

mkdir -p "${STAGE_DIR}"
unzip -oq "${ARCHIVE_PATH}" -d "${STAGE_DIR}"

[ -f "${STAGE_DIR}/RustDedicated_Data/Managed/Oxide.Rust.dll" ] \
  || die "Downloaded archive is missing RustDedicated_Data/Managed/Oxide.Rust.dll (unexpected asset?)."

overlay_directory_contents "${STAGE_DIR}" "${RUST_INSTALL_DIR}"

if ! oxide_is_installed; then
  die "Oxide files were copied, but ${RUST_INSTALL_DIR}/RustDedicated_Data/Managed/Oxide.Rust.dll is still missing after install."
fi

assert_writable_dir "${OXIDE_PLUGINS_DIR}"

log "Oxide installation completed successfully."
log "Drop plugin .cs files there, then restart the server to load Oxide and its plugins."
