import { randomBytes } from 'node:crypto';
import type { GameServerRow } from '../../../types/gameServer.js';
import { getOvhcloudRustMetadata } from '../../serverMetadata.js';
import { normalizeEnvPayload } from '../../installPayload.js';
import { parseStoredEnv } from '../../runtimeConfig.js';

export const RUST_IMAGE_ID = 'rust';

export const RUST_DEFAULT_SERVER_IDENTITY = 'rust-server';

export type OvhcloudRustImage = {
    imageId: typeof RUST_IMAGE_ID;
};

export function getOvhcloudRustImage(imageId: string): OvhcloudRustImage | null {
    return imageId === RUST_IMAGE_ID
        ? { imageId: RUST_IMAGE_ID }
        : null;
}

function generateRconPassword(): string {
    return randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
}

export function normalizeRustEnv(payload: unknown): string[] {
    let env = normalizeEnvPayload(payload);

    if (!env.some((entry) => /^RUST_RCON_PASSWORD=.+/.test(entry))) {
        env = env.filter((entry) => !entry.startsWith('RUST_RCON_PASSWORD='));
        env.push(`RUST_RCON_PASSWORD=${generateRconPassword()}`);
    }

    if (!env.some((entry) => /^RUST_SERVER_IDENTITY=.+/.test(entry))) {
        env = env.filter((entry) => !entry.startsWith('RUST_SERVER_IDENTITY='));
        env.push(`RUST_SERVER_IDENTITY=${RUST_DEFAULT_SERVER_IDENTITY}`);
    }

    return env;
}

export function resolveRustIdentity(server: GameServerRow): string {
    const prefix = 'RUST_SERVER_IDENTITY=';
    let value = RUST_DEFAULT_SERVER_IDENTITY;
    for (const entry of parseStoredEnv(server)) {
        if (entry.startsWith(prefix)) value = entry.slice(prefix.length);
    }

    value = value.trim();
    if (!value || value === '.' || value === '..' || /[/\\\0]/.test(value)) {
        return RUST_DEFAULT_SERVER_IDENTITY;
    }

    return value;
}

export function buildRustProviderMetadata(
    image: OvhcloudRustImage
): Record<string, unknown> {
    return {
        imageId: image.imageId,
        family: 'rust',
        serverType: 'rust',
        capabilities: {
            backup: {
                type: 'archive',
                script: '/app/backup.sh',
            },
            restore: {
                type: 'script',
                script: '/app/restore.sh',
            },
            consoleCommand: {
                type: 'script',
                script: '/app/send-command.sh',
            },
            mods: {
                type: 'oxide',
            },
        },
    };
}

export function assertOvhcloudRustServer(server: GameServerRow): void {
    getOvhcloudRustMetadata(server);
}
