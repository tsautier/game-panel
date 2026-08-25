import { promises as fs } from 'node:fs';
import type { GameServerRow } from '../types/gameServer.js';
import { getOvhcloudServerAdapter } from '../providers/ovhcloud/adapters/registry.js';
import { rowToOvhcloudInstallSpec } from '../providers/ovhcloud/installSpec.js';
import { serverRepository } from '../database/index.js';
import { removeServerDataDir } from '../utils/storage.js';
import { resolveServerPath } from './fileExplorer.js';
import { installServerAsync } from './servers.js';
import * as dockerUtils from '../utils/docker.js';

export type ServerWipeResult = { removed: string[] };

export function getServerWipeModes(server: GameServerRow): string[] {
    if (server.provider !== 'ovhcloud') return [];

    let wipe;
    try {
        wipe = getOvhcloudServerAdapter(server).wipe;
    } catch {
        return [];
    }

    const modes: string[] = [];
    if (wipe?.soft) modes.push('soft');
    if (wipe?.hard) modes.push('hard');
    return modes;
}

export async function wipeServer(
    server: GameServerRow & { docker_container_id: string },
    mode: string
): Promise<ServerWipeResult & { mode: string }> {
    if (server.provider !== 'ovhcloud') {
        throw Object.assign(new Error('Wipe is only available for OVHcloud servers'), { statusCode: 501 });
    }

    const wipe = getOvhcloudServerAdapter(server).wipe;

    if (mode === 'soft') {
        if (!wipe?.soft) {
            throw Object.assign(new Error('Soft wipe is not supported for this game'), { statusCode: 501 });
        }
        await assertServerStoppedForWipe(server);
        const targets = await wipe.soft(server);
        const result = await wipeServerDataPaths(server, targets);
        return { ...result, mode };
    }

    throw Object.assign(new Error(`Unsupported wipe mode: ${mode}`), { statusCode: 400 });
}

export async function hardWipeServer(
    server: GameServerRow & { docker_container_id: string },
    actor?: string
): Promise<{ mode: 'hard'; reinstalling: true }> {
    if (server.provider !== 'ovhcloud') {
        throw Object.assign(new Error('Hard wipe is only available for OVHcloud servers'), { statusCode: 501 });
    }

    const wipe = getOvhcloudServerAdapter(server).wipe;
    if (!wipe?.hard) {
        throw Object.assign(new Error('Hard wipe is not supported for this game'), { statusCode: 501 });
    }

    await assertServerStoppedForWipe(server);

    await dockerUtils.removeContainer(server.docker_container_id).catch(() => undefined);

    await removeServerDataDir(server.id);

    const spec = rowToOvhcloudInstallSpec(server);
    await serverRepository.updateStatus(server.id, 'creating');
    void installServerAsync(server.id, server.name, spec, actor, { skipTelemetry: true });

    return { mode: 'hard', reinstalling: true };
}

export async function assertServerStoppedForWipe(
    server: GameServerRow & { docker_container_id: string }
): Promise<void> {
    const status = await dockerUtils.checkContainerStatus(server.docker_container_id);
    if (status === 'running') {
        throw Object.assign(
            new Error('Stop the server before wiping: this deletes save data and the server would overwrite it on shutdown.'),
            { statusCode: 409 }
        );
    }
}

export async function wipeServerDataPaths(
    server: GameServerRow,
    apiPaths: string[]
): Promise<ServerWipeResult> {
    const removed: string[] = [];
    for (const apiPath of apiPaths) {
        const { absPath } = await resolveServerPath({ serverId: server.id, root: 'data', path: apiPath });
        try {
            await fs.rm(absPath, { recursive: true, force: true });
        } catch (error) {
            throw Object.assign(
                new Error(`Failed to wipe ${apiPath}: ${(error as Error).message}`),
                { statusCode: 500 }
            );
        }
        removed.push(apiPath);
    }
    return { removed };
}
