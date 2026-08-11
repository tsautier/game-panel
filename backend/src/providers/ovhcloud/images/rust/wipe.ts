import { promises as fs } from 'node:fs';
import type { GameServerRow } from '../../../../types/gameServer.js';
import { resolveServerPath } from '../../../../services/fileExplorer.js';
import { resolveRustIdentity } from '../rust.js';

const RUST_SOFT_WIPE_KEEP = new Set(['cfg', 'companion.id']);

export async function resolveRustSoftWipeTargets(server: GameServerRow): Promise<string[]> {
    const identity = resolveRustIdentity(server);
    const saveApiPath = `/server/server/${identity}`;

    const { absPath } = await resolveServerPath({ serverId: server.id, root: 'data', path: saveApiPath });

    let entries;
    try {
        entries = await fs.readdir(absPath, { withFileTypes: true });
    } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return [];
        throw error;
    }

    return entries
        .filter((entry) => !RUST_SOFT_WIPE_KEEP.has(entry.name))
        .map((entry) => `${saveApiPath}/${entry.name}`);
}
