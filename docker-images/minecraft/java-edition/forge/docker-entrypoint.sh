#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
SERVER_JAR="${SERVER_JAR:-${DATA_DIR}/server.jar}"
RUNTIME_DIR="${RUNTIME_DIR:-/run/minecraft}"
FORGE_MAVEN_BASE="${FORGE_MAVEN_BASE:-https://maven.minecraftforge.net}"
SERVER_STARTER_JAR_URL="${SERVER_STARTER_JAR_URL:-https://github.com/neoforged/ServerStarterJar/releases/latest/download/server.jar}"
SERVER_STARTER_JAR_SHA256="${SERVER_STARTER_JAR_SHA256:-}"
LOG_PREFIX="[mc-forge]"

. /app/common.sh

META_FILE="$(gameserver_meta_file)"

mkdir -p "${DATA_DIR}" "${RUNTIME_DIR}"

log "Starting bootstrap..."

if [ "$#" -gt 0 ]; then
  log "Custom command requested, bypassing server bootstrap: $*"
  exec "$@"
fi

assert_writable_dir "${DATA_DIR}"
assert_writable_dir "${BACKUP_DIR}"

if [ "${EULA:-}" != "TRUE" ]; then
  die "You must accept the Minecraft EULA. Set environment variable: EULA=TRUE"
fi

echo "eula=true" > "${DATA_DIR}/eula.txt"

REQUESTED_VERSION="${MC_VERSION:-}"
REQUESTED_FORGE_VERSION="${FORGE_VERSION:-}"

if [ -z "${REQUESTED_VERSION}" ]; then
  die "MC_VERSION is required."
fi

if [ -z "${REQUESTED_FORGE_VERSION}" ]; then
  die "FORGE_VERSION is required."
fi

log "Requested Minecraft version: ${REQUESTED_VERSION}"
log "Requested Forge version: ${REQUESTED_FORGE_VERSION}"

LOCAL_VERSION=""
LOCAL_SERVER_TYPE=""
LOCAL_FORGE_VERSION=""
LOCAL_SERVER_STARTER_JAR_URL=""
LOCAL_ARTIFACT=""

if [ -f "${META_FILE}" ]; then
  LOCAL_VERSION="$(metadata_value_from_file "${META_FILE}" '.minecraftVersion' || true)"
  LOCAL_SERVER_TYPE="$(metadata_value_from_file "${META_FILE}" '.serverType' || true)"
  LOCAL_FORGE_VERSION="$(metadata_value_from_file "${META_FILE}" '.forgeVersion' || true)"
  LOCAL_SERVER_STARTER_JAR_URL="$(metadata_value_from_file "${META_FILE}" '.serverStarterJarUrl' || true)"
  LOCAL_ARTIFACT="$(resolve_server_artifact_from_metadata || true)"
fi

LOCAL_INSTALL_IS_MODERN="false"

if [ -f "${DATA_DIR}/run.sh" ]; then
  LOCAL_INSTALL_IS_MODERN="true"
fi

LEGACY_LAUNCH_JAR=""

resolve_legacy_launch_jar() {
  LEGACY_LAUNCH_JAR=""

  for LEGACY_CANDIDATE in "${DATA_DIR}"/*.jar; do
    [ -f "${LEGACY_CANDIDATE}" ] || continue

    case "$(basename "${LEGACY_CANDIDATE}")" in
      minecraft_server*.jar)
        continue
        ;;
    esac

    if [ -n "${LEGACY_LAUNCH_JAR}" ]; then
      die "Found several candidate Forge launch jars in ${DATA_DIR} ($(basename "${LEGACY_LAUNCH_JAR}"), $(basename "${LEGACY_CANDIDATE}")); cannot decide which one to run."
    fi

    LEGACY_LAUNCH_JAR="${LEGACY_CANDIDATE}"
  done

  [ -n "${LEGACY_LAUNCH_JAR}" ]
}

clear_previous_forge_layout() {
  rm -f "${DATA_DIR}/run.sh" "${DATA_DIR}/run.bat" "${DATA_DIR}/user_jvm_args.txt"

  if [ -n "${LOCAL_ARTIFACT}" ]; then
    rm -f "${LOCAL_ARTIFACT}"
  fi
}

install_forge_artifact() {
  INSTALL_VERSION="$1"
  INSTALL_FORGE_VERSION="$2"
  INSTALL_COORDINATE="${INSTALL_VERSION}-${INSTALL_FORGE_VERSION}"

  INSTALLER_NAME="forge-${INSTALL_COORDINATE}-installer.jar"
  INSTALLER_URL="${FORGE_MAVEN_BASE}/net/minecraftforge/forge/${INSTALL_COORDINATE}/${INSTALLER_NAME}"
  INSTALLER_SHA256_URL="${INSTALLER_URL}.sha256"
  INSTALLER_PATH="${RUNTIME_DIR}/${INSTALLER_NAME}"

  log "Downloading Forge installer ${INSTALL_COORDINATE}..."
  INSTALLER_SHA256="$(curl_to_stdout "${INSTALLER_SHA256_URL}" | awk '{print $1}')"

  if [ -z "${INSTALLER_SHA256}" ]; then
    die "No SHA256 checksum available for Forge installer ${INSTALL_COORDINATE}."
  fi

  download_to_file "${INSTALLER_URL}" "${INSTALLER_PATH}" "${INSTALLER_SHA256}" "sha256"

  clear_previous_forge_layout

  log "Running Forge installer ${INSTALL_COORDINATE}..."
  (
    cd "${DATA_DIR}"
    java -jar "${INSTALLER_PATH}" --installServer
  )

  if [ -f "${DATA_DIR}/run.sh" ]; then
    log "Forge installer created run scripts; downloading NeoForged ServerStarterJar..."
    download_to_file "${SERVER_STARTER_JAR_URL}" "${SERVER_JAR}" "${SERVER_STARTER_JAR_SHA256}" "sha256"

    write_gameserver_metadata "forge" "${INSTALL_VERSION}" "" "" "${SERVER_STARTER_JAR_SHA256}" "" "" "" "${SERVER_STARTER_JAR_URL}" "${INSTALLER_SHA256}" "${INSTALL_FORGE_VERSION}"
    return 0
  fi

  if resolve_legacy_launch_jar; then
    SERVER_JAR="${LEGACY_LAUNCH_JAR}"
    log "Forge installer created a self-contained launch jar: ${SERVER_JAR}"

    write_gameserver_metadata "forge" "${INSTALL_VERSION}" "" "" "" "" "" "" "" "${INSTALLER_SHA256}" "${INSTALL_FORGE_VERSION}"
    return 0
  fi

  die "Forge installer completed, but neither run.sh nor a launch jar was created."
}

FORGE_INSTALL_IS_CURRENT="false"

if [ -n "${LOCAL_ARTIFACT}" ] \
  && [ -f "${LOCAL_ARTIFACT}" ] \
  && [ "${LOCAL_SERVER_TYPE}" = "forge" ] \
  && [ "${LOCAL_VERSION}" = "${REQUESTED_VERSION}" ] \
  && [ "${LOCAL_FORGE_VERSION}" = "${REQUESTED_FORGE_VERSION}" ]; then
  if [ "${LOCAL_INSTALL_IS_MODERN}" = "true" ]; then
    if [ "${LOCAL_SERVER_STARTER_JAR_URL}" = "${SERVER_STARTER_JAR_URL}" ]; then
      FORGE_INSTALL_IS_CURRENT="true"
    fi
  else
    FORGE_INSTALL_IS_CURRENT="true"
  fi
fi

if [ "${FORGE_INSTALL_IS_CURRENT}" = "true" ]; then
  SERVER_JAR="${LOCAL_ARTIFACT}"
  log "Found existing Forge installation ${REQUESTED_VERSION}-${REQUESTED_FORGE_VERSION}; skipping install."
else
  if [ -n "${LOCAL_SERVER_TYPE}" ] && [ "${LOCAL_SERVER_TYPE}" != "forge" ]; then
    log "Installed server type ${LOCAL_SERVER_TYPE} differs from requested type forge; replacing server artifact."
  elif [ -n "${LOCAL_VERSION}" ] && [ "${LOCAL_VERSION}" != "${REQUESTED_VERSION}" ]; then
    log "Installed Minecraft version ${LOCAL_VERSION} differs from requested version ${REQUESTED_VERSION}; reinstalling."
  elif [ -n "${LOCAL_FORGE_VERSION}" ] && [ "${LOCAL_FORGE_VERSION}" != "${REQUESTED_FORGE_VERSION}" ]; then
    log "Installed Forge ${LOCAL_FORGE_VERSION} differs from requested Forge ${REQUESTED_FORGE_VERSION}; reinstalling."
  elif [ -n "${LOCAL_ARTIFACT}" ] && [ ! -f "${LOCAL_ARTIFACT}" ]; then
    log "Recorded Forge launch artifact ${LOCAL_ARTIFACT} is missing; reinstalling."
  elif [ "${LOCAL_INSTALL_IS_MODERN}" = "true" ] && [ "${LOCAL_SERVER_STARTER_JAR_URL}" != "${SERVER_STARTER_JAR_URL}" ]; then
    log "ServerStarterJar source changed; reinstalling wrapper."
  elif [ -n "${LOCAL_SERVER_TYPE}" ]; then
    log "Found server artifact without complete Forge metadata; reinstalling."
  else
    log "No local Forge installation found. Installing requested version."
  fi

  install_forge_artifact "${REQUESTED_VERSION}" "${REQUESTED_FORGE_VERSION}"
fi

export DATA_DIR
export SERVER_JAR
export RUNTIME_DIR

log "Bootstrap complete, handing over to launcher..."
exec /app/launcher.sh
