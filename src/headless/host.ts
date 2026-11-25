import * as fs from 'fs';
import * as NodePath from 'path';
import * as yaml from 'yaml';
import type { AbstractProject } from '../EIDEProject';
import {
    configureHeadlessVscode,
    HeadlessMemento
} from './vscode_shim';
import { findExtensionRoot, loadHeadlessSettings } from './settings';
import type { HeadlessSettings } from './settings';
import { ensureBundledToolPermissions } from './tool_permissions';
import { EXTENSION_ID } from '../ExtensionInfo';
import { installVscodeShim } from './vscode';
import { ConfigError } from '../core/errors';
import { TOOLCHAIN_SETTING_KEYS } from '../core/toolchain_setting_keys';
import {
    dumpProjectConfig,
    migrateProjectConfig,
    needsProjectConfigMigration
} from '../core/project_config_migration';

const FILE_SETTING_KEYS = new Set(['C51.INI.Path']);

export interface HeadlessHostOptions {
    projectPath: string;
    workspaceFile?: string;
    target?: string;
    resourcesDir: string;
    extensionRoot?: string;
    toolchainPath?: string;
    settingsFile?: string;
    builderThreads?: number;
}

export interface HeadlessProjectSession {
    project: AbstractProject;
    workspaceFile: string;
    close(): void;
}

class MemoryMemento implements HeadlessMemento {
    private readonly values = new Map<string, unknown>();

    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.values.has(key) ? this.values.get(key) as T : defaultValue;
    }

    update(key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
        return Promise.resolve();
    }

    keys(): readonly string[] {
        return Array.from(this.values.keys());
    }

    setKeysForSync(): void {
        // no persistent state in headless mode
    }
}

function resolveWorkspace(projectPath: string, workspaceFile?: string): {
    root: string;
    workspaceFile: string;
} {
    const absolute = NodePath.resolve(projectPath);
    if (workspaceFile) {
        const workspace = NodePath.isAbsolute(workspaceFile)
            ? NodePath.resolve(workspaceFile)
            : NodePath.resolve(
                fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()
                    ? absolute
                    : NodePath.dirname(absolute),
                workspaceFile);
        if (!workspace.endsWith('.code-workspace')) {
            throw new Error(`Workspace file must end with '.code-workspace': ${workspace}`);
        }
        return { root: NodePath.dirname(workspace), workspaceFile: workspace };
    }
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
        if (!absolute.endsWith('.code-workspace')) {
            throw new Error(`Unsupported project file: ${absolute}`);
        }
        return { root: NodePath.dirname(absolute), workspaceFile: absolute };
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
        throw new Error(`Project directory not found: ${absolute}`);
    }
    const candidates = fs.readdirSync(absolute)
        .filter(name => name.endsWith('.code-workspace'))
        .map(name => NodePath.join(absolute, name));
    if (candidates.length > 1) {
        throw new Error(
            `Multiple workspace files found in ${absolute}; pass --workspace explicitly.`);
    }
    return {
        root: absolute,
        workspaceFile: candidates[0] ?? NodePath.join(absolute, `${NodePath.basename(absolute)}.code-workspace`)
    };
}

function readProjectConfig(workspaceFile: string): any {
    const configFile = NodePath.join(NodePath.dirname(workspaceFile), '.eide', 'eide.yml');
    if (!fs.existsSync(configFile)) {
        throw new Error(`Project config not found: ${configFile}`);
    }
    const config = yaml.parse(fs.readFileSync(configFile, 'utf8'));
    if (!config || typeof config !== 'object') {
        throw new Error(`Invalid project config: ${configFile}`);
    }
    return migrateLoadedConfig(config, configFile);
}

/**
 * Migrate and persist an old config before the loader reads it again; configs
 * that need no migration are returned untouched.
 */
function migrateLoadedConfig(config: any, configFile: string): any {
    if (!needsProjectConfigMigration(config)) {
        return config;
    }
    const sourceVersion = String(config.version);
    migrateProjectConfig(config);
    fs.writeFileSync(configFile, dumpProjectConfig(config), 'utf8');
    process.stderr.write(
        `migration ${configFile} from ${sourceVersion} to ${config.version}\n`);
    return config;
}

function selectTarget(config: any, requested: string | undefined): string {
    const targets = config.targets && typeof config.targets === 'object'
        ? Object.keys(config.targets)
        : [];
    if (targets.length === 0) {
        throw new Error('Project config has no targets.');
    }
    const target = requested || targets[0];
    if (!targets.includes(target)) {
        throw new Error(`Target '${target}' not found. Available: ${targets.join(', ')}`);
    }
    return target;
}

function applyToolchainPath(
    settings: { [key: string]: unknown },
    config: any,
    target: string,
    toolchainPath: string | undefined
): void {
    if (!toolchainPath) {
        return;
    }
    const stat = fs.statSync(toolchainPath, { throwIfNoEntry: false });
    if (!stat) {
        throw new ConfigError(
            `--toolchain-path does not exist: ${toolchainPath}`);
    }
    const targetConfig = config.targets[target];
    const type = String(config.type || '');
    const toolchain = String(targetConfig.toolchain || '');
    const key = TOOLCHAIN_SETTING_KEYS[`${type}:${toolchain}`];
    if (!key) {
            throw new ConfigError(
            `--toolchain-path is not mapped for project type '${type}' and toolchain '${toolchain}'; ` +
            'use --settings with the toolchain install directory.');
    }
    if (FILE_SETTING_KEYS.has(key)) {
        if (!stat.isFile()) {
            throw new ConfigError(
                `--toolchain-path must be the TOOLS.INI file for toolchain '${toolchain}': ${toolchainPath}`);
        }
    } else if (!stat.isDirectory()) {
        throw new ConfigError(
            `--toolchain-path is not a directory for toolchain '${toolchain}': ${toolchainPath}`);
    }
    settings[key] = toolchainPath;
}

function ensureSameExtensionRoot(extensionRoot: string): void {
    const { ResManager } = require('../ResManager') as typeof import('../ResManager');
    const manager = ResManager.instance();
    if (NodePath.resolve(manager.getAppRootFolder().path) !== NodePath.resolve(extensionRoot)) {
        throw new Error(
            `Headless host is already initialized with a different extension root: ` +
            `${manager.getAppRootFolder().path}`);
    }
}

export interface HeadlessRuntimeOptions {
    resourcesDir: string;
    extensionRoot: string;
    workspaceRoot: string;
    workspaceFile?: string;
    settings: HeadlessSettings;
    workspaceState: HeadlessMemento;
    globalState: HeadlessMemento;
}

/**
 * Install the VS Code shim and initialize the extension singletons that the
 * headless host and the import/creation paths rely on.
 */
export function initHeadlessRuntime(options: HeadlessRuntimeOptions): void {
    installVscodeShim();
    process.env['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1';
    process.env['DOTNET_ROLL_FORWARD'] = 'Major';

    configureHeadlessVscode({
        settings: options.settings.values,
        workspaceRoot: options.workspaceRoot,
        workspaceFile: options.workspaceFile,
        workspaceState: options.workspaceState,
        globalState: options.globalState,
        language: options.settings.language
    });

    const context = {
        extensionPath: options.extensionRoot,
        extension: {
            id: EXTENSION_ID,
            packageJSON: JSON.parse(
                fs.readFileSync(NodePath.join(options.extensionRoot, 'package.json'), 'utf8'))
        },
        subscriptions: [],
        workspaceState: options.workspaceState,
        globalState: options.globalState
    };

    const platform = require('../Platform') as typeof import('../Platform');
    const { ResManager } = require('../ResManager') as typeof import('../ResManager');
    const { SettingManager } = require('../SettingManager') as typeof import('../SettingManager');

    platform.init(context as any);
    ResManager.GetInstance(context as any);
    ensureBundledToolPermissions(options.resourcesDir);
    ensureSameExtensionRoot(options.extensionRoot);
    SettingManager.GetInstance(context as any);
}

export async function openHeadlessProject(
    options: HeadlessHostOptions
): Promise<HeadlessProjectSession> {
    installVscodeShim();

    const { root, workspaceFile } = resolveWorkspace(options.projectPath, options.workspaceFile);
    const config = readProjectConfig(workspaceFile);
    const uid = config.miscInfo?.uid;
    if (typeof uid !== 'string' || uid.length === 0) {
        throw new Error(
            'Headless build requires an initialized project with miscInfo.uid; ' +
            'open the project in VS Code once to initialize it.');
    }
    const target = selectTarget(config, options.target);
    const extensionRoot = options.extensionRoot
        ? NodePath.resolve(options.extensionRoot)
        : findExtensionRoot(options.resourcesDir);
    const settings = loadHeadlessSettings(
        extensionRoot, workspaceFile, options.settingsFile);
    applyToolchainPath(settings.values, config, target, options.toolchainPath);
    if (options.builderThreads !== undefined) {
        if (!Number.isInteger(options.builderThreads) || options.builderThreads <= 0) {
            throw new Error(`Invalid builder thread count: ${options.builderThreads}`);
        }
        settings.values['Builder.ThreadNumber'] = options.builderThreads;
    }

    const workspaceState = new MemoryMemento();
    const globalState = new MemoryMemento();
    workspaceState.update(`project.${uid}`, JSON.stringify({ target }));

    initHeadlessRuntime({
        resourcesDir: options.resourcesDir,
        extensionRoot,
        workspaceRoot: root,
        workspaceFile,
        settings,
        workspaceState,
        globalState
    });

    const { AbstractProject } = require('../EIDEProject') as typeof import('../EIDEProject');
    const { File } = require('../../lib/node-utility/File') as typeof import('../../lib/node-utility/File');

    const project = AbstractProject.NewProject(workspaceState as any);
    try {
        await project.LoadForHeadless(new File(workspaceFile));
        if (!project.checkAndNotifyInstallToolchain()) {
            throw new Error('Toolchain is not installed or is not configured.');
        }
    } catch (error) {
        project.Close();
        throw error;
    }

    return {
        project,
        workspaceFile,
        close: () => project.Close()
    };
}
