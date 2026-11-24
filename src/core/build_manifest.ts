import { createHash } from 'crypto';
import * as fs from 'fs';
import * as NodePath from 'path';
import type { BuildRequest } from './types';

export interface BuildManifest {
    buildId: string;
    configHash: string;
    createdAt: string;
    request: BuildRequest;
    target: string;
    toolchain: string;
    outDir: string;
    defines: string[];
    includeDirs: string[];
    success: boolean;
    artifacts: string[];
    compileCommands?: string;
}

function normalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(normalize);
    }
    if (value !== null && typeof value === 'object') {
        const sorted: { [key: string]: unknown } = {};
        for (const key of Object.keys(value as object).sort()) {
            sorted[key] = normalize((value as { [key: string]: unknown })[key]);
        }
        return sorted;
    }
    return value;
}

export function stableStringify(value: unknown): string {
    return JSON.stringify(normalize(value));
}

export function createConfigHash(params: unknown, request: BuildRequest): string {
    return createHash('sha256')
        .update(stableStringify({ params, request }))
        .digest('hex');
}

export function writeBuildManifest(outDir: string, manifest: BuildManifest): string {
    fs.mkdirSync(outDir, { recursive: true });
    const manifestPath = NodePath.join(outDir, 'build-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2));
    return manifestPath;
}

const artifactExtensions = [
    '.elf', '.hex', '.bin', '.map', '.axf', '.out',
    '.s19', '.s37', '.sm8', '.lst'
];

export function collectArtifacts(outDir: string): string[] {
    if (!fs.existsSync(outDir)) {
        return [];
    }
    return fs.readdirSync(outDir, { withFileTypes: true })
        .filter(entry => entry.isFile()
            && artifactExtensions.includes(NodePath.extname(entry.name).toLowerCase()))
        .map(entry => NodePath.join(outDir, entry.name))
        .sort();
}
