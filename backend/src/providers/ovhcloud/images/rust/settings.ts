import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GameServerRow } from '../../../../types/gameServer.js';
import { resolveServerPath } from '../../../../services/fileExplorer.js';
import { getRuntimeOwnership } from '../../../runtimeConfig.js';
import { assertOvhcloudRustServer, resolveRustIdentity } from '../rust.js';

type RustSettingType = 'boolean' | 'integer' | 'float' | 'string' | 'select';
type RustSelectOption = { value: string; label: string };
type RustSettingValue = string | number | boolean;

type RustSettingDefinition = {
    key: string;
    label: string;
    description: string;
    type: RustSettingType;
    options?: RustSelectOption[];
    min?: number;
    max?: number;
    default: RustSettingValue;
};

export type RustSetting = RustSettingDefinition & {
    value: RustSettingValue;
};

const MAX_STRING_SETTING_LENGTH = 2048;

export const RUST_SETTING_DEFINITIONS: RustSettingDefinition[] = [
    // --- branding ---
    { key: 'server.hostname', type: 'string', default: '', label: 'Server name', description: 'Name shown in the in-game server browser.' },
    { key: 'server.description', type: 'string', default: '', label: 'Server description', description: 'Description shown on the server details / connection screen.' },
    { key: 'server.url', type: 'string', default: '', label: 'Website URL', description: 'Link opened from the server browser (website or Discord).' },
    { key: 'server.headerimage', type: 'string', default: '', label: 'Header image URL', description: 'Banner shown in the server browser. Must be a 512x256 image URL.' },
    { key: 'server.logoimage', type: 'string', default: '', label: 'Logo image URL', description: 'Server logo shown in the in-game menu. Publicly hosted image URL.' },
    { key: 'server.tags', type: 'string', default: '', label: 'Browser tags', description: 'Comma-separated discovery tags shown in the browser (e.g. "weekly,vanilla,EU").' },

    // --- world ---
    { key: 'server.maxplayers', type: 'integer', default: 100, min: 1, label: 'Maximum players', description: 'Maximum concurrent players. Higher values need more CPU/RAM.' },

    // --- gameplay ---
    { key: 'server.pve', type: 'boolean', default: false, label: 'PvE mode', description: 'Disable player-versus-player damage (players cannot hurt each other).' },
    { key: 'server.radiation', type: 'boolean', default: true, label: 'Radiation', description: 'Enable radiation zones around monuments.' },
    { key: 'server.stability', type: 'boolean', default: true, label: 'Building stability', description: 'Enable building stability (structures can collapse). Disabling it reduces server load.' },
    { key: 'server.globalchat', type: 'boolean', default: true, label: 'Global chat', description: 'Enable server-wide chat (disable for proximity-only chat).' },
    { key: 'craft.instant', type: 'boolean', default: false, label: 'Instant crafting', description: 'Items are crafted instantly with no wait time.' },
    { key: 'decay.scale', type: 'float', default: 1, min: 0, label: 'Decay scale', description: 'Building decay speed multiplier (1 = normal, 0.5 = slower, 0 = disabled).' },
    { key: 'decay.upkeep', type: 'boolean', default: true, label: 'Upkeep', description: 'Require resources in the tool cupboard to prevent building decay.' },
    { key: 'relationshipmanager.maxteamsize', type: 'integer', default: 8, min: 0, label: 'Maximum team size', description: 'Maximum members per team (0 = teams disabled / solo only).' },

    // --- server behaviour ---
    { key: 'server.saveinterval', type: 'integer', default: 300, min: 60, max: 3600, label: 'Save interval (seconds)', description: 'Seconds between automatic world saves.' },
];

const DEFINITIONS_BY_KEY = new Map(RUST_SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

const RUST_SERVER_CFG_RELATIVE_PATH = 'cfg/server.cfg';

function invalidInput(message: string): never {
    throw Object.assign(new Error(message), { statusCode: 400 });
}

function serverCfgApiPath(server: GameServerRow): string {
    // /data/server/server/<identity>/cfg/server.cfg
    return `/server/server/${resolveRustIdentity(server)}/${RUST_SERVER_CFG_RELATIVE_PATH}`;
}

async function readServerCfg(server: GameServerRow): Promise<string | null> {
    const resolved = await resolveServerPath({ serverId: server.id, root: 'data', path: serverCfgApiPath(server) });
    try {
        return await fs.readFile(resolved.absPath, 'utf8');
    } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return null;
        throw error;
    }
}

async function writeServerCfg(server: GameServerRow, content: string): Promise<void> {
    const resolved = await resolveServerPath({ serverId: server.id, root: 'data', path: serverCfgApiPath(server) });
    await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });
    await fs.writeFile(resolved.absPath, content, 'utf8');

    const ownership = getRuntimeOwnership(server);
    if (ownership) {
        await fs.chown(path.dirname(resolved.absPath), ownership.uid, ownership.gid).catch(() => undefined);
        await fs.chown(resolved.absPath, ownership.uid, ownership.gid).catch(() => undefined);
    }
}

// --- server.cfg parsing (flat "convar value" / "convar \"value\"" lines) ---

function unquote(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function getCfgRawValue(content: string, key: string): string | null {
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;

        const separator = line.search(/\s/);
        if (separator < 0) continue;
        if (line.slice(0, separator) !== key) continue;

        return line.slice(separator + 1).trim();
    }
    return null;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setCfgRawValue(content: string, key: string, rawValue: string): string {
    const lines = content.split('\n');
    const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s`);

    for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
            lines[i] = `${key} ${rawValue}`;
            return lines.join('\n');
        }
    }

    const body = content.length === 0 ? '' : content.endsWith('\n') ? content : `${content}\n`;
    return `${body}${key} ${rawValue}\n`;
}

// --- value conversion ---

function convertRawValue(definition: RustSettingDefinition, raw: string): RustSettingValue | null {
    switch (definition.type) {
        case 'boolean': {
            const normalized = unquote(raw).toLowerCase();
            if (normalized === 'true' || normalized === '1') return true;
            if (normalized === 'false' || normalized === '0') return false;
            return null;
        }
        case 'integer': {
            const parsed = Number(unquote(raw));
            return Number.isInteger(parsed) ? parsed : null;
        }
        case 'float': {
            const parsed = Number(unquote(raw));
            return Number.isFinite(parsed) ? parsed : null;
        }
        case 'select':
        case 'string':
            return unquote(raw);
    }
}

function serializeValue(definition: RustSettingDefinition, value: unknown): string {
    switch (definition.type) {
        case 'boolean': {
            if (typeof value !== 'boolean') invalidInput(`${definition.key} must be a boolean`);
            return value ? 'true' : 'false';
        }
        case 'integer':
        case 'float': {
            const numeric = typeof value === 'number'
                ? value
                : typeof value === 'string' && value.trim() !== ''
                    ? Number(value)
                    : Number.NaN;

            if (!Number.isFinite(numeric)) invalidInput(`${definition.key} must be a number`);
            if (definition.type === 'integer' && !Number.isInteger(numeric)) invalidInput(`${definition.key} must be an integer`);
            if (definition.min !== undefined && numeric < definition.min) invalidInput(`${definition.key} must be >= ${definition.min}`);
            if (definition.max !== undefined && numeric > definition.max) invalidInput(`${definition.key} must be <= ${definition.max}`);
            return String(numeric);
        }
        case 'select': {
            if (typeof value !== 'string') invalidInput(`${definition.key} must be a string`);
            if (!definition.options?.some((option) => option.value === value)) {
                invalidInput(`${definition.key} must be one of: ${definition.options?.map((option) => option.value || '(default)').join(', ')}`);
            }
            return `"${value}"`;
        }
        case 'string': {
            if (typeof value !== 'string') invalidInput(`${definition.key} must be a string`);
            if (value.length > MAX_STRING_SETTING_LENGTH || /["\0\r\n]/.test(value)) {
                invalidInput(`${definition.key} contains invalid characters`);
            }
            return `"${value}"`;
        }
    }
}

export async function listRustSettings(server: GameServerRow): Promise<RustSetting[]> {
    assertOvhcloudRustServer(server);

    const content = await readServerCfg(server);

    return RUST_SETTING_DEFINITIONS.map((definition) => {
        if (content !== null) {
            const raw = getCfgRawValue(content, definition.key);
            if (raw !== null) {
                const value = convertRawValue(definition, raw);
                if (value !== null) return { ...definition, value };
            }
        }
        return { ...definition, value: definition.default };
    });
}

export async function patchRustSettings(
    server: GameServerRow,
    updates: Record<string, unknown>
): Promise<{ updated: string[]; settings: RustSetting[] }> {
    assertOvhcloudRustServer(server);

    const entries = Object.entries(updates);
    if (entries.length === 0) invalidInput('settings must contain at least one value');

    let content = await readServerCfg(server) ?? '';
    const updated: string[] = [];

    for (const [key, value] of entries) {
        const definition = DEFINITIONS_BY_KEY.get(key);
        if (!definition) invalidInput(`Unsupported Rust setting: ${key}`);

        const rawValue = serializeValue(definition, value);
        content = setCfgRawValue(content, definition.key, rawValue);
        updated.push(key);
    }

    await writeServerCfg(server, content);

    return {
        updated,
        settings: await listRustSettings(server),
    };
}
