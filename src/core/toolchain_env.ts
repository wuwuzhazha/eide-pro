import * as fs from 'fs';
import * as NodePath from 'path';
import { ConfigError } from './errors';
import { TOOLCHAIN_SETTING_KEYS } from './toolchain_setting_keys';

export interface ResolvedPath {
    value: string | null;
    source: 'settings' | 'toolchain-path' | 'project-config' | 'path' | 'xpack' | 'not-found';
}

export interface ResolvedTool {
    name: string;
    path: string | null;
    source: ResolvedPath['source'];
}

export interface EnvironmentReport {
    target: string;
    type: string;
    toolchain: string;
    toolchainPath: ResolvedPath;
    tools: ResolvedTool[];
    searched: string[];
}

export interface EnvironmentOptions {
    projectPath: string;
    target?: string;
    type: string;
    toolchain: string;
    settings: { [key: string]: unknown };
    toolchainPath?: string;
    resourcesDir: string;
    envPath?: string;
    platform?: NodeJS.Platform;
    fileExists?: (path: string) => boolean;
}

function normalizeSettingKey(key: string): string {
    return key.replace(/^EIDE\./, '');
}

function settingNameFor(type: string, toolchain: string): string | undefined {
    return TOOLCHAIN_SETTING_KEYS[`${type}:${toolchain}`];
}

function candidateToolNames(model: any, platform: NodeJS.Platform): string[] {
    const prefix = typeof model?.toolPrefix === 'string' ? model.toolPrefix : '';
    const suffix = platform === 'win32' ? '.exe' : '';
    return ['gcc', 'gdb', 'make', 'objcopy'].map(name => `${prefix}${name}${suffix}`);
}

export function resolveToolchainEnvironment(options: EnvironmentOptions): EnvironmentReport {
    const platform = options.platform ?? process.platform;
    const fileExists = options.fileExists ?? fs.existsSync;
    const searched: string[] = [];
    const settingKey = settingNameFor(options.type, options.toolchain);
    let toolchainPath: ResolvedPath = { value: null, source: 'not-found' };

    if (settingKey) {
        searched.push(`settings: EIDE.${settingKey}`);
        const settingValue = options.settings[normalizeSettingKey(settingKey)] ?? options.settings[settingKey];
        if (typeof settingValue === 'string' && settingValue.trim().length > 0 && fileExists(settingValue)) {
            toolchainPath = { value: settingValue, source: 'settings' };
        }
    }
    if (toolchainPath.source === 'not-found' && options.toolchainPath) {
        searched.push('cli: --toolchain-path');
        if (fileExists(options.toolchainPath)) {
            toolchainPath = { value: options.toolchainPath, source: 'toolchain-path' };
        }
    }
    const projectEnvIni = NodePath.join(options.projectPath, '.eide', 'env.ini');
    if (toolchainPath.source === 'not-found') {
        searched.push('project: .eide/env.ini');
        if (fileExists(projectEnvIni)) {
            const content = fs.readFileSync(projectEnvIni, 'utf8');
            const match = /(?:^|\n)\s*([^=\r\n]+?)\s*=\s*([^\r\n]+)/.exec(content);
            if (match && fileExists(match[2].trim())) {
                toolchainPath = { value: match[2].trim(), source: 'project-config' };
            }
        }
    }

    const modelDir = NodePath.join(options.resourcesDir, 'data', 'models');
    const modelName = fs.readdirSync(modelDir).find(name =>
        name.toLowerCase().endsWith(`.${options.toolchain.toLowerCase()}.model.json`)
        && name.toLowerCase().startsWith(options.type.toLowerCase()));
    if (!modelName) {
        throw new ConfigError(`Toolchain model not found for ${options.type}:${options.toolchain} in ${modelDir}`);
    }
    const modelPath = NodePath.join(modelDir, modelName);
    if (!fs.existsSync(modelPath)) {
        throw new ConfigError(`Toolchain model not found: ${modelPath}`);
    }
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    searched.push(`model: ${NodePath.basename(modelPath)} global`);
    const names = candidateToolNames(model, platform);
    const pathDirs = (options.envPath ?? process.env.PATH ?? '').split(NodePath.delimiter).filter(Boolean);
    searched.push('path: PATH');
    const xpackDir = NodePath.join(options.projectPath, 'xpacks');
    searched.push('xpack: xpacks/');

    const tools = names.map(name => {
        let path: string | null = null;
        let source: ResolvedTool['source'] = 'not-found';
        if (toolchainPath.value) {
            const binPath = NodePath.join(toolchainPath.value, 'bin', name);
            if (fileExists(binPath)) {
                path = binPath;
                source = toolchainPath.source;
            }
        }
        if (!path) {
            for (const dir of pathDirs) {
                const candidate = NodePath.join(dir, name);
                if (fileExists(candidate)) {
                    path = candidate;
                    source = 'path';
                    break;
                }
            }
        }
        if (!path) {
            const candidate = NodePath.join(xpackDir, 'bin', name);
            if (fileExists(candidate)) {
                path = candidate;
                source = 'xpack';
            }
        }
        return { name, path, source };
    });

    return {
        target: options.target ?? '',
        type: options.type,
        toolchain: options.toolchain,
        toolchainPath,
        tools,
        searched
    };
}
