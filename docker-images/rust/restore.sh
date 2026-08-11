#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
RUST_INSTALL_DIR="${RUST_INSTALL_DIR:-${DATA_DIR}/server}"
RUST_SERVER_IDENTITY="${RUST_SERVER_IDENTITY:-rust-server}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RUNTIME_DIR="${RUNTIME_DIR:-/run/rust}"
RESTORE_BACKUP="${RESTORE_BACKUP:-${1:-}}"
LOG_PREFIX="[rust-restore]"

. /app/common.sh

SAVE_DIR="${RUST_INSTALL_DIR}/server/${RUST_SERVER_IDENTITY}"
RESTORE_LOCK_DIR="${RESTORE_LOCK_DIR:-${SAVE_DIR}/.restore.lock}"

LOCK_ACQUIRED="false"
RESTORE_SUCCESS="false"
DATA_MOVED="false"
WORK_DIR=""

cleanup() {
  if [ "${RESTORE_SUCCESS}" != "true" ] && [ "${DATA_MOVED}" = "true" ] && [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}/old" ]; then
    log "Restore failed before completion, rolling back the previous data..."
    for OLD in "${WORK_DIR}/old"/* "${WORK_DIR}/old"/.*; do
      [ -e "${OLD}" ] || continue
      NAME="$(basename "${OLD}")"
      case "${NAME}" in .|..) continue ;; esac
      rm -rf "${SAVE_DIR}/${NAME}" 2>/dev/null || true
      mv "${OLD}" "${SAVE_DIR}/${NAME}" 2>/dev/null || true
    done
    DATA_MOVED="false"
  fi

  if [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}" ]; then
    rm -rf "${WORK_DIR}" 2>/dev/null || true
  fi

  if [ "${LOCK_ACQUIRED}" = "true" ]; then
    rmdir "${RESTORE_LOCK_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM HUP

if [ -z "${RESTORE_BACKUP}" ]; then
  die "Usage: /app/restore.sh <backup-archive-name> (e.g. rust-20260724T120000Z.tar.gz)"
fi

case "${RESTORE_BACKUP}" in
  */*|..|.)
    die "Invalid backup name (path separators are not allowed): ${RESTORE_BACKUP}"
    ;;
esac

ARCHIVE_PATH="${BACKUP_DIR}/${RESTORE_BACKUP}"

assert_safe_data_dir
mkdir -p "${SAVE_DIR}"
assert_writable_dir "${SAVE_DIR}"

if [ ! -f "${ARCHIVE_PATH}" ]; then
  die "Backup archive not found: ${ARCHIVE_PATH}"
fi

assert_rust_server_stopped

if ! mkdir "${RESTORE_LOCK_DIR}" 2>/dev/null; then
  die "Another restore is already running."
fi
LOCK_ACQUIRED="true"

log "Starting restore from ${RESTORE_BACKUP}..."

WORK_DIR="$(mktemp -d "${SAVE_DIR}/.restore-work.XXXXXX")"
mkdir -p "${WORK_DIR}/new" "${WORK_DIR}/old"

log "Extracting archive to staging..."
tar -xzf "${ARCHIVE_PATH}" -C "${WORK_DIR}/new"

if ! ls "${WORK_DIR}/new"/*.sav >/dev/null 2>&1; then
  die "Archive does not contain a Rust world save (.sav); aborting."
fi

log "Swapping in restored data..."
DATA_MOVED="true"
for NEW in "${WORK_DIR}/new"/* "${WORK_DIR}/new"/.*; do
  [ -e "${NEW}" ] || continue
  NAME="$(basename "${NEW}")"
  case "${NAME}" in .|..) continue ;; esac
  if [ -e "${SAVE_DIR}/${NAME}" ]; then
    mv "${SAVE_DIR}/${NAME}" "${WORK_DIR}/old/${NAME}"
  fi
  mv "${NEW}" "${SAVE_DIR}/${NAME}"
done

reconcile_map_cache() {
  LIVE_SAV="$(ls "${SAVE_DIR}"/*.sav 2>/dev/null | head -n 1)"
  [ -n "${LIVE_SAV}" ] || return 0
  PREFIX="$(basename "${LIVE_SAV}" .sav)"

  for CACHE in "${SAVE_DIR}"/*.map "${SAVE_DIR}"/*_occlusion_*.dat; do
    [ -e "${CACHE}" ] || continue
    CACHE_NAME="$(basename "${CACHE}")"
    case "${CACHE_NAME}" in
      "${PREFIX}.map"|"${PREFIX}"_occlusion_*.dat)
        :
        ;;
      *)
        log "Dropping stale map cache (Rust will regenerate it): ${CACHE_NAME}"
        rm -f "${CACHE}" 2>/dev/null || true
        ;;
    esac
  done
}
reconcile_map_cache

RESTORE_SUCCESS="true"
log "Restore completed successfully."
