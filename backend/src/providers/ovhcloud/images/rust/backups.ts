import { getOvhcloudRustMetadata } from '../../../serverMetadata.js';
import { resolveRustIdentity } from '../rust.js';
import type { GameServerRow } from '../../../../types/gameServer.js';
import * as dockerUtils from '../../../../utils/docker.js';
import type { NormalizedMount } from '../../../../utils/mounts.js';
import { ensureServerMountDirs } from '../../../../utils/storage.js';
import { getBasenameFromApiPath } from '../../../../utils/fsBrowser.js';
import { getRuntimeOwnership, hasStoredMount, parseStoredMounts } from '../../../runtimeConfig.js';
import { OVHCLOUD_DOCKER_STOP_TIMEOUT_SECONDS } from '../../adapters/common.js';
import type {
    OvhcloudBackupCreateResult,
    OvhcloudBackupRestoreInput,
    OvhcloudBackupRestoreResult,
} from '../../adapters/types.js';

export const RUST_BACKUP_EXTENSIONS = ['.tar.gz'];

function hasBackupsMount(mounts: NormalizedMount[]): boolean {
    return hasStoredMount(mounts, 'backup', '/backups');
}

function resolveServerImage(server: GameServerRow): string {
    return server.docker_image_digest?.trim() || server.docker_image;
}

export async function createRustBackup(
    server: GameServerRow & { docker_container_id: string },
    _options: Record<string, unknown> = {}
): Promise<OvhcloudBackupCreateResult> {
    getOvhcloudRustMetadata(server);

    const mounts = parseStoredMounts(server);
    if (!hasBackupsMount(mounts)) {
        throw Object.assign(new Error('OVHcloud Rust backups require a backup -> /backups mount'), { statusCode: 409 });
    }

    const status = await dockerUtils.checkContainerStatus(server.docker_container_id);

    if (status === 'running') {
        const result = await dockerUtils.execInContainer(
            server.docker_container_id,
            ['/app/backup.sh'],
            { user: 'gameserver', workdir: '/app' }
        );

        return {
            ok: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            mode: 'hot',
        };
    }

    if (status !== 'created' && status !== 'exited' && status !== 'dead') {
        throw Object.assign(new Error(`Cannot run cold backup while container status is ${status}`), { statusCode: 409 });
    }

    const resolvedMounts = await ensureServerMountDirs(server.id, mounts, getRuntimeOwnership(server));
    const result = await dockerUtils.runOneShotContainer({
        image: resolveServerImage(server),
        namePrefix: `gamepanel-rust-backup-${server.id}`,
        cmd: ['/app/backup.sh'],
        env: [`RUST_SERVER_IDENTITY=${resolveRustIdentity(server)}`],
        mounts: resolvedMounts,
        user: 'gameserver',
        workdir: '/app',
        labels: {
            'gamepanel.serverId': String(server.id),
            'gamepanel.job': 'rust-backup',
        },
    });

    return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        mode: 'cold',
    };
}

export async function restoreRustBackup(
    server: GameServerRow & { docker_container_id: string },
    input: OvhcloudBackupRestoreInput
): Promise<OvhcloudBackupRestoreResult> {
    getOvhcloudRustMetadata(server);

    const mounts = parseStoredMounts(server);
    if (!hasBackupsMount(mounts)) {
        throw Object.assign(new Error('OVHcloud Rust restore requires a backup -> /backups mount'), { statusCode: 409 });
    }

    const status = await dockerUtils.checkContainerStatus(server.docker_container_id);
    if (status !== 'running' && status !== 'created' && status !== 'exited' && status !== 'dead') {
        throw Object.assign(new Error(`Cannot restore while container status is ${status}`), { statusCode: 409 });
    }

    const shouldRestart = status === 'running';
    if (shouldRestart) {
        await dockerUtils.stopContainer(server.docker_container_id, OVHCLOUD_DOCKER_STOP_TIMEOUT_SECONDS);
    }

    const backupName = getBasenameFromApiPath(input.apiPath);
    const resolvedMounts = await ensureServerMountDirs(server.id, mounts, getRuntimeOwnership(server));
    const result = await dockerUtils.runOneShotContainer({
        image: resolveServerImage(server),
        namePrefix: `gamepanel-rust-restore-${server.id}`,
        cmd: ['/app/restore.sh', backupName],
        env: [`RUST_SERVER_IDENTITY=${resolveRustIdentity(server)}`],
        mounts: resolvedMounts,
        user: 'gameserver',
        workdir: '/app',
        labels: {
            'gamepanel.serverId': String(server.id),
            'gamepanel.job': 'rust-restore',
        },
    });

    const ok = result.exitCode === 0;
    let restarted = false;
    if (ok && shouldRestart) {
        await dockerUtils.startContainer(server.docker_container_id);
        restarted = true;
    }

    return {
        ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        restarted,
    };
}
