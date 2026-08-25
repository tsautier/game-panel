import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GameServerRow } from '../../../../types/gameServer.js';
import { resolveServerPath } from '../../../../services/fileExplorer.js';
import { logWarn } from '../../../../utils/logger.js';
import { getRuntimeOwnership } from '../../../runtimeConfig.js';
import {
    encodeJsonParam,
    modrinthRequest,
    resolveMinecraftAddonContext,
    type MinecraftAddonContext,
    type MinecraftAddonSearchResult,
} from './addonsCatalog.js';
import { invalidInput } from './shared.js';

const MANIFEST_API_PATH = '/.gamepanel/minecraft-addons.json';
const MANIFEST_SCHEMA_VERSION = 1;

const ADDON_FILE_EXTENSION = '.jar';
const DISABLED_SUFFIX = '.disabled';

const HASH_BULK_CHUNK_SIZE = 100;
const HASH_CACHE_MAX_ENTRIES = 4_000;
const RESOLUTION_CACHE_TTL_MS = 60 * 60 * 1000;

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ADDON_FILE_BYTES = 250 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOST = process.env.MODRINTH_CDN_HOST || 'cdn.modrinth.com';

export type InstalledAddonSource = 'panel' | 'detected' | 'unknown';

export type InstalledMinecraftAddon = {
    fileName: string;
    fileSize: number;
    fileSha1: string;
    modifiedAt: string;
    enabled: boolean;
    source: InstalledAddonSource;
    projectId: string | null;
    slug: string | null;
    title: string | null;
    iconUrl: string | null;
    versionId: string | null;
    versionNumber: string | null;
    gameVersions: string[];
    installedAt: string | null;
    compatible: boolean | null;
    updateAvailable: boolean;
    latestVersionId: string | null;
    latestVersionNumber: string | null;
};

export type InstalledMinecraftAddonsResult = {
    context: MinecraftAddonContext;
    catalogAvailable: boolean;
    updateCheckAvailable: boolean;
    addons: InstalledMinecraftAddon[];
};

export type MinecraftAddonInstallResult = {
    addon: InstalledMinecraftAddon;
    replacedFileName: string | null;
    replacedVersionId: string | null;
    restartRequired: true;
};

export type MinecraftAddonManifestEntry = {
    projectId: string;
    versionId: string;
    slug: string | null;
    title: string | null;
    iconUrl: string | null;
    versionNumber: string | null;
    gameVersions: string[];
    fileName: string;
    fileSha1: string;
    fileSize: number;
    installedAt: string;
};

type AddonFile = {
    fileName: string;
    baseFileName: string;
    enabled: boolean;
    absPath: string;
    size: number;
    mtimeMs: number;
    modifiedAt: string;
};

type ResolvedVersion = {
    projectId: string;
    versionId: string;
    versionNumber: string | null;
    gameVersions: string[];
};

type AddonRecord = AddonFile & {
    sha1: string;
    manifestEntry: MinecraftAddonManifestEntry | null;
    resolved: ResolvedVersion | null;
};

type AddonRecords = {
    records: AddonRecord[];
    catalogAvailable: boolean;
};

type CachedResolution = {
    fetchedAt: number;
    value: ResolvedVersion | null;
};

type InstallTarget = {
    projectId: string;
    versionId: string;
    versionNumber: string | null;
    versionType: string;
    gameVersions: string[];
    loaders: string[];
    fileName: string;
    fileSize: number;
    fileSha1: string;
    downloadUrl: string;
};

const hashCache = new Map<string, string>();
const resolutionCache = new Map<string, CachedResolution>();

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

function notFound(message: string): never {
    throw Object.assign(new Error(message), { statusCode: 404 });
}

function upstreamFailure(message: string): never {
    throw Object.assign(new Error(message), { statusCode: 502 });
}

function toBaseFileName(fileName: string): string {
    return fileName.toLowerCase().endsWith(DISABLED_SUFFIX)
        ? fileName.slice(0, -DISABLED_SUFFIX.length)
        : fileName;
}

function isAddonFileName(fileName: string): boolean {
    return toBaseFileName(fileName).toLowerCase().endsWith(ADDON_FILE_EXTENSION);
}

function assertSafeFileName(fileName: string): string {
    const name = String(fileName ?? '').trim();

    if (!name || name === '.' || name === '..') invalidInput('Invalid addon file name');
    if (name.includes('/') || name.includes('\\')) invalidInput('Invalid addon file name');
    for (const char of name) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) invalidInput('Invalid addon file name');
    }
    if (!isAddonFileName(name)) invalidInput(`Addon files must end with ${ADDON_FILE_EXTENSION}`);

    return name;
}

async function hashFile(absPath: string, size: number, mtimeMs: number): Promise<string> {
    const cacheKey = `${absPath}:${size}:${mtimeMs}`;
    const cached = hashCache.get(cacheKey);
    if (cached) return cached;

    const sha1 = await new Promise<string>((resolve, reject) => {
        const hash = createHash('sha1');
        const stream = createReadStream(absPath);
        stream.on('error', reject);
        stream.on('data', (chunkData) => hash.update(chunkData));
        stream.on('end', () => resolve(hash.digest('hex')));
    });

    if (hashCache.size >= HASH_CACHE_MAX_ENTRIES) hashCache.clear();
    hashCache.set(cacheKey, sha1);
    return sha1;
}

async function resolveAddonDirectory(serverId: number, directory: string): Promise<string> {
    const resolved = await resolveServerPath({ serverId, root: 'data', path: directory });
    return resolved.absPath;
}

async function listAddonFiles(serverId: number, directory: string): Promise<AddonFile[]> {
    const dirPath = await resolveAddonDirectory(serverId, directory);

    let entries: Dirent[];
    try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return [];
        throw error;
    }

    const files: AddonFile[] = [];

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!isAddonFileName(entry.name)) continue;

        const absPath = path.join(dirPath, entry.name);
        const stats = await fs.stat(absPath);

        files.push({
            fileName: entry.name,
            baseFileName: toBaseFileName(entry.name),
            enabled: !entry.name.toLowerCase().endsWith(DISABLED_SUFFIX),
            absPath,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            modifiedAt: new Date(stats.mtimeMs).toISOString(),
        });
    }

    return files.sort((left, right) => left.baseFileName.localeCompare(right.baseFileName));
}

function sanitizeManifestEntry(raw: unknown): MinecraftAddonManifestEntry | null {
    const record = raw as Record<string, unknown>;
    const projectId = asString(record?.projectId);
    const versionId = asString(record?.versionId);
    const fileName = asString(record?.fileName);
    const fileSha1 = asString(record?.fileSha1);

    if (!projectId || !versionId || !fileName || !fileSha1) return null;
    if (fileName.includes('/') || fileName.includes('\\')) return null;

    return {
        projectId,
        versionId,
        slug: asString(record.slug),
        title: asString(record.title),
        iconUrl: asString(record.iconUrl),
        versionNumber: asString(record.versionNumber),
        gameVersions: asStringArray(record.gameVersions),
        fileName,
        fileSha1,
        fileSize: typeof record.fileSize === 'number' ? record.fileSize : 0,
        installedAt: asString(record.installedAt) ?? new Date(0).toISOString(),
    };
}

export async function readAddonManifest(serverId: number): Promise<MinecraftAddonManifestEntry[]> {
    const resolved = await resolveServerPath({ serverId, root: 'data', path: MANIFEST_API_PATH });

    let raw: string;
    try {
        raw = await fs.readFile(resolved.absPath, 'utf8');
    } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return [];
        throw error;
    }

    let parsed: { addons?: unknown };
    try {
        parsed = JSON.parse(raw) as { addons?: unknown };
    } catch {
        logWarn('MINECRAFT:ADDONS_INSTALLED', 'Ignoring unreadable addon manifest', { serverId });
        return [];
    }

    return Array.isArray(parsed.addons)
        ? parsed.addons
            .map(sanitizeManifestEntry)
            .filter((entry): entry is MinecraftAddonManifestEntry => entry !== null)
        : [];
}

async function writeAddonManifest(server: GameServerRow, entries: MinecraftAddonManifestEntry[]): Promise<void> {
    const resolved = await resolveServerPath({ serverId: server.id, root: 'data', path: MANIFEST_API_PATH });
    const payload = { schemaVersion: MANIFEST_SCHEMA_VERSION, addons: entries };

    await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });
    await fs.writeFile(resolved.absPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    const ownership = getRuntimeOwnership(server);
    if (ownership) {
        await fs.chown(path.dirname(resolved.absPath), ownership.uid, ownership.gid).catch(() => undefined);
        await fs.chown(resolved.absPath, ownership.uid, ownership.gid).catch(() => undefined);
    }
}

function mapResolvedVersion(raw: unknown): ResolvedVersion | null {
    const record = raw as Record<string, unknown>;
    const projectId = asString(record?.project_id);
    const versionId = asString(record?.id);
    if (!projectId || !versionId) return null;

    return {
        projectId,
        versionId,
        versionNumber: asString(record.version_number),
        gameVersions: asStringArray(record.game_versions),
    };
}

async function resolveVersionsByHash(hashes: string[]): Promise<Map<string, ResolvedVersion | null>> {
    const results = new Map<string, ResolvedVersion | null>();
    const missing: string[] = [];
    const now = Date.now();

    for (const hash of hashes) {
        const cached = resolutionCache.get(hash);
        if (cached && now - cached.fetchedAt < RESOLUTION_CACHE_TTL_MS) {
            results.set(hash, cached.value);
        } else if (!missing.includes(hash)) {
            missing.push(hash);
        }
    }

    for (const batch of chunk(missing, HASH_BULK_CHUNK_SIZE)) {
        const raw = await modrinthRequest('/version_files', {
            method: 'POST',
            body: JSON.stringify({ hashes: batch, algorithm: 'sha1' }),
        }) as Record<string, unknown>;

        for (const hash of batch) {
            const value = raw && typeof raw === 'object' ? mapResolvedVersion(raw[hash]) : null;
            resolutionCache.set(hash, { fetchedAt: Date.now(), value });
            results.set(hash, value);
        }
    }

    return results;
}

async function fetchLatestVersions(
    hashes: string[],
    context: MinecraftAddonContext
): Promise<Map<string, { versionId: string; versionNumber: string | null }>> {
    const latest = new Map<string, { versionId: string; versionNumber: string | null }>();
    if (hashes.length === 0 || !context.versionFilterAvailable) return latest;

    for (const batch of chunk(hashes, HASH_BULK_CHUNK_SIZE)) {
        const raw = await modrinthRequest('/version_files/update', {
            method: 'POST',
            body: JSON.stringify({
                hashes: batch,
                algorithm: 'sha1',
                loaders: [context.loader],
                game_versions: [context.minecraftVersion],
                version_types: ['release'],
            }),
        }) as Record<string, unknown>;

        if (!raw || typeof raw !== 'object') continue;

        for (const hash of batch) {
            const record = raw[hash] as Record<string, unknown> | undefined;
            const versionId = asString(record?.id);
            if (versionId) latest.set(hash, { versionId, versionNumber: asString(record?.version_number) });
        }
    }

    return latest;
}

async function fetchProjectSummaries(
    projectIds: string[]
): Promise<Map<string, { slug: string | null; title: string | null; iconUrl: string | null }>> {
    const summaries = new Map<string, { slug: string | null; title: string | null; iconUrl: string | null }>();
    if (projectIds.length === 0) return summaries;

    for (const batch of chunk(projectIds, HASH_BULK_CHUNK_SIZE)) {
        let raw: unknown;
        try {
            raw = await modrinthRequest(`/projects?ids=${encodeJsonParam(batch)}`);
        } catch {
            continue;
        }

        if (!Array.isArray(raw)) continue;

        for (const entry of raw) {
            const record = entry as Record<string, unknown>;
            const id = asString(record?.id);
            if (!id) continue;
            summaries.set(id, {
                slug: asString(record.slug),
                title: asString(record.title),
                iconUrl: asString(record.icon_url),
            });
        }
    }

    return summaries;
}

async function buildAddonRecords(server: GameServerRow, context: MinecraftAddonContext): Promise<AddonRecords> {
    const [files, manifest] = await Promise.all([
        listAddonFiles(server.id, context.directory),
        readAddonManifest(server.id),
    ]);

    if (files.length === 0) return { records: [], catalogAvailable: context.catalogAvailable };

    const manifestByFileName = new Map(manifest.map((entry) => [entry.fileName, entry]));

    const hashed = await Promise.all(files.map(async (file) => ({
        ...file,
        sha1: await hashFile(file.absPath, file.size, file.mtimeMs),
        manifestEntry: null as MinecraftAddonManifestEntry | null,
    })));

    for (const record of hashed) {
        const entry = manifestByFileName.get(record.baseFileName) ?? null;
        record.manifestEntry = entry && entry.fileSha1 === record.sha1 ? entry : null;
    }

    const unmanagedHashes = hashed.filter((record) => record.manifestEntry === null).map((record) => record.sha1);

    let resolutions = new Map<string, ResolvedVersion | null>();
    let catalogAvailable = context.catalogAvailable;

    if (catalogAvailable && unmanagedHashes.length > 0) {
        try {
            resolutions = await resolveVersionsByHash(unmanagedHashes);
        } catch {
            catalogAvailable = false;
        }
    }

    return {
        records: hashed.map((record) => ({
            ...record,
            resolved: record.manifestEntry ? null : resolutions.get(record.sha1) ?? null,
        })),
        catalogAvailable,
    };
}

function recordProjectId(record: AddonRecord): string | null {
    return record.manifestEntry?.projectId ?? record.resolved?.projectId ?? null;
}

function recordVersionId(record: AddonRecord): string | null {
    return record.manifestEntry?.versionId ?? record.resolved?.versionId ?? null;
}

function toInstalledAddon(
    record: AddonRecord,
    context: MinecraftAddonContext,
    summaries: Map<string, { slug: string | null; title: string | null; iconUrl: string | null }>,
    latestVersions: Map<string, { versionId: string; versionNumber: string | null }>
): InstalledMinecraftAddon {
    const versionId = recordVersionId(record);
    const summary = record.resolved ? summaries.get(record.resolved.projectId) : undefined;
    const gameVersions = record.manifestEntry?.gameVersions ?? record.resolved?.gameVersions ?? [];
    const latest = latestVersions.get(record.sha1) ?? null;

    return {
        fileName: record.fileName,
        fileSize: record.size,
        fileSha1: record.sha1,
        modifiedAt: record.modifiedAt,
        enabled: record.enabled,
        source: record.manifestEntry ? 'panel' : record.resolved ? 'detected' : 'unknown',
        projectId: recordProjectId(record),
        slug: record.manifestEntry?.slug ?? summary?.slug ?? null,
        title: record.manifestEntry?.title ?? summary?.title ?? null,
        iconUrl: record.manifestEntry?.iconUrl ?? summary?.iconUrl ?? null,
        versionId,
        versionNumber: record.manifestEntry?.versionNumber ?? record.resolved?.versionNumber ?? null,
        gameVersions,
        installedAt: record.manifestEntry?.installedAt ?? null,
        compatible: context.minecraftVersion && gameVersions.length > 0
            ? gameVersions.includes(context.minecraftVersion)
            : null,
        updateAvailable: Boolean(latest && versionId && latest.versionId !== versionId),
        latestVersionId: latest?.versionId ?? null,
        latestVersionNumber: latest?.versionNumber ?? null,
    };
}

export async function listInstalledMinecraftAddons(server: GameServerRow): Promise<InstalledMinecraftAddonsResult> {
    const context = await resolveMinecraftAddonContext(server, { requireCatalog: false });
    const { records, catalogAvailable } = await buildAddonRecords(server, context);

    const identifiedHashes = records.filter((record) => recordVersionId(record) !== null).map((record) => record.sha1);
    const detectedProjectIds = records
        .filter((record) => record.manifestEntry === null && record.resolved !== null)
        .map((record) => record.resolved!.projectId);

    let latestVersions = new Map<string, { versionId: string; versionNumber: string | null }>();
    let summaries = new Map<string, { slug: string | null; title: string | null; iconUrl: string | null }>();
    let updateCheckAvailable = catalogAvailable && context.versionFilterAvailable;

    if (catalogAvailable) {
        try {
            [latestVersions, summaries] = await Promise.all([
                fetchLatestVersions(identifiedHashes, context),
                fetchProjectSummaries([...new Set(detectedProjectIds)]),
            ]);
        } catch {
            updateCheckAvailable = false;
        }
    }

    return {
        context,
        catalogAvailable,
        updateCheckAvailable,
        addons: records.map((record) => toInstalledAddon(record, context, summaries, latestVersions)),
    };
}

export async function annotateSearchHitsWithInstalledState(
    server: GameServerRow,
    result: MinecraftAddonSearchResult
): Promise<MinecraftAddonSearchResult> {
    if (result.hits.length === 0) return result;

    const { records } = await buildAddonRecords(server, result.context);
    const installed = new Map<string, string | null>();

    for (const record of records) {
        const projectId = recordProjectId(record);
        if (projectId && !installed.has(projectId)) installed.set(projectId, recordVersionId(record));
    }

    return {
        ...result,
        hits: result.hits.map((hit) => ({
            ...hit,
            installed: installed.has(hit.projectId),
            installedVersionId: installed.get(hit.projectId) ?? null,
        })),
    };
}

function mapInstallTarget(raw: unknown): InstallTarget | null {
    const record = raw as Record<string, unknown>;
    const projectId = asString(record?.project_id);
    const versionId = asString(record?.id);
    if (!projectId || !versionId) return null;

    const files = Array.isArray(record.files) ? record.files : [];
    const primary = (files.find((file) => (file as Record<string, unknown>)?.primary === true) ?? files[0]) as
        | Record<string, unknown>
        | undefined;
    const hashes = primary?.hashes as Record<string, unknown> | undefined;

    const fileName = asString(primary?.filename);
    const downloadUrl = asString(primary?.url);
    const fileSha1 = asString(hashes?.sha1);

    if (!fileName || !downloadUrl || !fileSha1) return null;

    return {
        projectId,
        versionId,
        versionNumber: asString(record.version_number),
        versionType: asString(record.version_type) ?? 'release',
        gameVersions: asStringArray(record.game_versions),
        loaders: asStringArray(record.loaders),
        fileName,
        fileSize: typeof primary?.size === 'number' ? primary.size : 0,
        fileSha1,
        downloadUrl,
    };
}

async function resolveInstallTarget(
    context: MinecraftAddonContext,
    projectRef: string,
    versionId: string | null
): Promise<InstallTarget> {
    if (versionId) {
        const raw = await modrinthRequest(`/version/${encodeURIComponent(versionId)}`);
        const target = mapInstallTarget(raw);
        if (!target) notFound('This Modrinth version has no downloadable file');
        if (!target.loaders.includes(context.loader)) {
            invalidInput(`This version does not support ${context.loader}`);
        }
        if (/^[A-Za-z0-9]{8}$/.test(projectRef) && target.projectId !== projectRef) {
            invalidInput('This version belongs to a different Modrinth project');
        }
        return target;
    }

    const query = new URLSearchParams();
    query.set('loaders', JSON.stringify([context.loader]));
    if (context.versionFilterAvailable) query.set('game_versions', JSON.stringify([context.minecraftVersion]));

    const raw = await modrinthRequest(`/project/${encodeURIComponent(projectRef)}/version?${query.toString()}`);
    const candidates = (Array.isArray(raw) ? raw : [])
        .map(mapInstallTarget)
        .filter((entry): entry is InstallTarget => entry !== null);

    const target = candidates.find((entry) => entry.versionType === 'release') ?? candidates[0];

    if (!target) {
        throw Object.assign(
            new Error(`No ${context.loader} version of this addon is available${context.versionFilterAvailable ? ` for Minecraft ${context.minecraftVersion}` : ''}`),
            { statusCode: 409 }
        );
    }

    return target;
}

async function downloadAddonFile(target: InstallTarget, destination: string): Promise<void> {
    let url: URL;
    try {
        url = new URL(target.downloadUrl);
    } catch {
        upstreamFailure('Modrinth returned an invalid download URL');
    }

    if (url.protocol !== 'https:' || url.host !== ALLOWED_DOWNLOAD_HOST) {
        upstreamFailure(`Refusing to download an addon from ${url.host}`);
    }

    if (target.fileSize > MAX_ADDON_FILE_BYTES) {
        invalidInput(`Addon file is larger than ${Math.floor(MAX_ADDON_FILE_BYTES / (1024 * 1024))} MB`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
        let response: Response;
        try {
            response = await fetch(url, { signal: controller.signal });
        } catch {
            upstreamFailure('Unable to download the addon from Modrinth');
        }

        if (!response.ok || !response.body) {
            upstreamFailure(`Modrinth download failed (HTTP ${response.status})`);
        }

        const hash = createHash('sha1');
        let bytes = 0;

        const meter = new Transform({
            transform(chunkData: Buffer, _encoding, callback) {
                bytes += chunkData.length;
                if (bytes > MAX_ADDON_FILE_BYTES) {
                    callback(new Error('Addon file exceeds the maximum allowed size'));
                    return;
                }
                hash.update(chunkData);
                callback(null, chunkData);
            },
        });

        await pipeline(
            Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
            meter,
            createWriteStream(destination)
        );

        const digest = hash.digest('hex');
        if (digest !== target.fileSha1) {
            upstreamFailure('Downloaded addon does not match the checksum published by Modrinth');
        }
    } finally {
        clearTimeout(timeout);
    }
}

export async function installMinecraftAddon(
    server: GameServerRow,
    projectRef: string,
    options?: { versionId?: string | null }
): Promise<MinecraftAddonInstallResult> {
    const context = await resolveMinecraftAddonContext(server);
    const ref = String(projectRef ?? '').trim();
    if (!/^[A-Za-z0-9._+-]{1,64}$/.test(ref)) invalidInput('Invalid Modrinth project id');

    const requestedVersionId = options?.versionId ? String(options.versionId).trim() : null;
    if (requestedVersionId && !/^[A-Za-z0-9]{1,32}$/.test(requestedVersionId)) {
        invalidInput('Invalid Modrinth version id');
    }

    const target = await resolveInstallTarget(context, ref, requestedVersionId);
    const targetFileName = assertSafeFileName(target.fileName);

    const { records } = await buildAddonRecords(server, context);
    const previousRecords = records.filter((record) => recordProjectId(record) === target.projectId);

    const keepDisabled = previousRecords.length > 0 && previousRecords.every((record) => !record.enabled);
    const finalFileName = keepDisabled ? `${targetFileName}${DISABLED_SUFFIX}` : targetFileName;

    const dirPath = await resolveAddonDirectory(server.id, context.directory);
    await fs.mkdir(dirPath, { recursive: true });

    const tempPath = path.join(dirPath, `.gamepanel-${randomUUID()}.part`);

    try {
        await downloadAddonFile(target, tempPath);
        await fs.rename(tempPath, path.join(dirPath, finalFileName));
    } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }

    const ownership = getRuntimeOwnership(server);
    if (ownership) {
        await fs.chown(path.join(dirPath, finalFileName), ownership.uid, ownership.gid).catch(() => undefined);
    }

    const replaced = previousRecords.filter((record) => record.fileName !== finalFileName);
    for (const record of replaced) {
        await fs.rm(record.absPath, { force: true }).catch(() => undefined);
    }

    const manifestEntry: MinecraftAddonManifestEntry = {
        projectId: target.projectId,
        versionId: target.versionId,
        slug: null,
        title: null,
        iconUrl: null,
        versionNumber: target.versionNumber,
        gameVersions: target.gameVersions,
        fileName: targetFileName,
        fileSha1: target.fileSha1,
        fileSize: target.fileSize,
        installedAt: new Date().toISOString(),
    };

    const summaries = await fetchProjectSummaries([target.projectId]);
    const summary = summaries.get(target.projectId);
    manifestEntry.slug = summary?.slug ?? null;
    manifestEntry.title = summary?.title ?? null;
    manifestEntry.iconUrl = summary?.iconUrl ?? null;

    await persistManifestEntry(server, context, manifestEntry);

    const stats = await fs.stat(path.join(dirPath, finalFileName));

    return {
        addon: toInstalledAddon(
            {
                fileName: finalFileName,
                baseFileName: targetFileName,
                enabled: !keepDisabled,
                absPath: path.join(dirPath, finalFileName),
                size: stats.size,
                mtimeMs: stats.mtimeMs,
                modifiedAt: new Date(stats.mtimeMs).toISOString(),
                sha1: target.fileSha1,
                manifestEntry,
                resolved: null,
            },
            context,
            new Map(),
            new Map()
        ),
        replacedFileName: replaced[0]?.fileName ?? null,
        replacedVersionId: previousRecords[0] ? recordVersionId(previousRecords[0]) : null,
        restartRequired: true,
    };
}

async function persistManifestEntry(
    server: GameServerRow,
    context: MinecraftAddonContext,
    entry: MinecraftAddonManifestEntry
): Promise<void> {
    const [manifest, files] = await Promise.all([
        readAddonManifest(server.id),
        listAddonFiles(server.id, context.directory),
    ]);

    const presentBaseNames = new Set(files.map((file) => file.baseFileName));

    const kept = manifest.filter((existing) => (
        existing.projectId !== entry.projectId
        && existing.fileName !== entry.fileName
        && presentBaseNames.has(existing.fileName)
    ));

    await writeAddonManifest(server, [...kept, entry]);
}

export async function setMinecraftAddonEnabled(
    server: GameServerRow,
    fileName: string,
    enabled: boolean
): Promise<InstalledMinecraftAddon> {
    const context = await resolveMinecraftAddonContext(server, { requireCatalog: false });
    const requested = assertSafeFileName(fileName);
    const baseFileName = toBaseFileName(requested);

    const dirPath = await resolveAddonDirectory(server.id, context.directory);
    const enabledPath = path.join(dirPath, baseFileName);
    const disabledPath = `${enabledPath}${DISABLED_SUFFIX}`;

    const currentPath = await fs.stat(enabledPath).then(() => enabledPath).catch(() => null)
        ?? await fs.stat(disabledPath).then(() => disabledPath).catch(() => null);

    if (!currentPath) notFound(`${baseFileName} is not installed`);

    const targetPath = enabled ? enabledPath : disabledPath;
    if (currentPath !== targetPath) {
        await fs.rename(currentPath, targetPath);
    }

    const { records, catalogAvailable } = await buildAddonRecords(server, context);
    const record = records.find((entry) => entry.baseFileName === baseFileName);
    if (!record) notFound(`${baseFileName} is not installed`);

    const summaries = catalogAvailable && record.resolved
        ? await fetchProjectSummaries([record.resolved.projectId])
        : new Map<string, { slug: string | null; title: string | null; iconUrl: string | null }>();

    return toInstalledAddon(record, context, summaries, new Map());
}
