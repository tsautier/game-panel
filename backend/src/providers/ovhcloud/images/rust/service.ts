import { getOvhcloudRustMetadata } from '../../../serverMetadata.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GameServerRow } from '../../../../types/gameServer.js';
import * as dockerUtils from '../../../../utils/docker.js';
import { ensureServerMountDirs } from '../../../../utils/storage.js';
import type { NormalizedMount } from '../../../../utils/mounts.js';
import { getServerFsRoot } from '../../../../services/fileExplorer.js';
import { assertCanModifyFrameworks } from '../../../../services/serverActionPolicy.js';
import { getRuntimeOwnership, hasStoredMount, parseStoredMounts } from '../../../runtimeConfig.js';

type GameServerWithContainer = GameServerRow & {
    docker_container_id: string;
};

export type RustFrameworkStatus = {
    oxideInstalled: boolean;
};

export type RustFrameworkScriptResult = {
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
};

type RustFrameworkScript = 'install-oxide';

type ScriptOptions = {
    version?: string | null;
};

function hasDataMount(mounts: NormalizedMount[]): boolean {
    return hasStoredMount(mounts, 'data', '/data');
}

function assertRustServer(server: GameServerRow): void {
    getOvhcloudRustMetadata(server);
}

function assertDataMount(server: GameServerRow): NormalizedMount[] {
    const mounts = parseStoredMounts(server);
    if (!hasDataMount(mounts)) {
        throw Object.assign(new Error('OVHcloud Rust requires a data -> /data mount'), { statusCode: 409 });
    }

    return mounts;
}

function normalizeOptionalArg(value: string | null | undefined, fieldName: string): string | null {
    if (value === undefined || value === null) return null;
    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > 120 || /[\0\r\n]/.test(normalized)) {
        throw Object.assign(new Error(`${fieldName} is invalid`), { statusCode: 400 });
    }

    return normalized;
}

function scriptPath(script: RustFrameworkScript): string {
    switch (script) {
        case 'install-oxide':
            return '/app/install-oxide.sh';
    }
}

function buildScriptCommand(script: RustFrameworkScript, options: ScriptOptions): string[] {
    const command = [scriptPath(script)];
    const version = normalizeOptionalArg(options.version, 'version');

    if (version) {
        command.push(version);
    }

    return command;
}

async function runOneShot(
    server: GameServerWithContainer,
    params: {
        namePrefix: string;
        cmd: string[];
    }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const mounts = assertDataMount(server);
    const resolvedMounts = await ensureServerMountDirs(server.id, mounts, getRuntimeOwnership(server));

    return dockerUtils.runOneShotContainer({
        image: server.docker_image_digest?.trim() || server.docker_image,
        namePrefix: params.namePrefix,
        cmd: params.cmd,
        mounts: resolvedMounts,
        user: 'gameserver',
        workdir: '/app',
        labels: {
            'gamepanel.serverId': String(server.id),
            'gamepanel.job': params.namePrefix,
        },
    });
}

export async function inspectRustFrameworks(
    server: GameServerWithContainer
): Promise<RustFrameworkStatus> {
    assertRustServer(server);
    assertDataMount(server);

    const { rootDir } = await getServerFsRoot({ serverId: server.id, root: 'data' });
    const oxideMarker = path.join(rootDir, 'server', 'RustDedicated_Data', 'Managed', 'Oxide.Rust.dll');

    const oxideInstalled = await fs.stat(oxideMarker)
        .then((stat) => stat.isFile())
        .catch(() => false);

    return { oxideInstalled };
}

export async function runRustFrameworkScript(
    server: GameServerWithContainer,
    script: RustFrameworkScript,
    options: ScriptOptions = {}
): Promise<RustFrameworkScriptResult> {
    assertRustServer(server);
    assertCanModifyFrameworks(server);
    assertDataMount(server);

    const result = await runOneShot(server, {
        namePrefix: `gamepanel-rust-${script}-${server.id}`,
        cmd: buildScriptCommand(script, options),
    });

    return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}
