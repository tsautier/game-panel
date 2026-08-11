#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
RUST_INSTALL_DIR="${RUST_INSTALL_DIR:-${DATA_DIR}/server}"
RUST_SERVER_IDENTITY="${RUST_SERVER_IDENTITY:-rust-server}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-rust}"
RUNTIME_DIR="${RUNTIME_DIR:-/run/rust}"
BACKUP_LOCK_DIR="${BACKUP_LOCK_DIR:-${BACKUP_DIR}/.backup.lock}"
LOG_PREFIX="[rust-backup]"

. /app/common.sh

SAVE_DIR="${RUST_INSTALL_DIR}/server/${RUST_SERVER_IDENTITY}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_NAME="${BACKUP_PREFIX}-${TIMESTAMP}.tar.gz"
TMP_ARCHIVE="${BACKUP_DIR}/.${ARCHIVE_NAME}.tmp"
FINAL_ARCHIVE="${BACKUP_DIR}/${ARCHIVE_NAME}"

LOCK_ACQUIRED="false"

assert_safe_data_dir
mkdir -p "${BACKUP_DIR}" "${RUNTIME_DIR}"
assert_writable_dir "${BACKUP_DIR}"

cleanup() {
  rm -f "${TMP_ARCHIVE}" 2>/dev/null || true

  if [ "${LOCK_ACQUIRED}" = "true" ]; then
    rmdir "${BACKUP_LOCK_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM HUP

if ! mkdir "${BACKUP_LOCK_DIR}" 2>/dev/null; then
  die "Another backup is already running."
fi
LOCK_ACQUIRED="true"

if [ ! -d "${SAVE_DIR}" ]; then
  die "Rust save directory not found: ${SAVE_DIR} (has the world been created yet?)."
fi

create_archive() {
  RC=0
  tar -czf "${TMP_ARCHIVE}" -C "${SAVE_DIR}" \
    --exclude='*.map' \
    --exclude='*_occlusion_*.dat' \
    --exclude='*.sav.[0-9]*' \
    --exclude='Log.EAC.txt' \
    --exclude='command_history' \
    --exclude='serveremoji' \
    --exclude='relay_cfg.json' \
    . || RC=$?

  if [ "${RC}" -ne 0 ] && [ "${RC}" -ne 1 ]; then
    die "tar failed with exit code ${RC}."
  fi
}

log "Backup file: ${FINAL_ARCHIVE}"

if is_rust_server_running; then
  log "Server is running: hot backup (flushing world with 'save')..."
  if ! rust_rcon_save_and_wait; then
    log "WARNING: could not confirm 'Saving complete'; continuing best-effort."
  fi
  create_archive
else
  log "Server is not running: cold backup."
  create_archive
fi

mv "${TMP_ARCHIVE}" "${FINAL_ARCHIVE}"
log "Backup completed: ${FINAL_ARCHIVE}"
