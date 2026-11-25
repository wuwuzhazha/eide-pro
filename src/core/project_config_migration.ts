import * as fs from 'fs';
import * as yaml from 'yaml';

/** Config version produced by `migrateProjectConfig`. */
export const MIGRATED_CONFIG_VERSION = '4.0';

const CONFIG_KEY_ORDER = [
    'version',
    'name',
    'type',
    'deviceName',
    'packDir',
    'srcDirs',
    'virtualFolder',
    'dependenceList',
    'outDir',
    'miscInfo',
    'targets'
];

export function dumpProjectConfig(config: any): string {
    return yaml.stringify(config, {
        indent: 2,
        lineWidth: 1000,
        sortMapEntries: (a: any, b: any) => {
            const left = CONFIG_KEY_ORDER.indexOf(a.key);
            const right = CONFIG_KEY_ORDER.indexOf(b.key);
            if (left < 0 && right < 0) {
                return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
            }
            if (left < 0) {
                return 1;
            }
            if (right < 0) {
                return -1;
            }
            return left - right;
        }
    });
}

export function compareVersion(v1: string, v2: string): number {
    const left = v1.split('.').filter(part => part.trim() !== '');
    const right = v2.split('.').filter(part => part.trim() !== '');
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) {
        const a = parseInt(left[index], 10);
        const b = parseInt(right[index], 10);
        if (isNaN(a) || isNaN(b)) {
            throw new Error(`version string must contain only numbers and '.': ${a}, ${b}`);
        }
        if (a > b) {
            return 1;
        }
        if (a < b) {
            return -1;
        }
    }
    return left.length - right.length;
}

export function needsProjectConfigMigration(config: any): boolean {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('Invalid project configuration.');
    }
    const version = typeof config.version === 'number' ? String(config.version) : config.version;
    if (typeof version !== 'string') {
        throw new Error('Project configuration has no version.');
    }
    return compareVersion(version, MIGRATED_CONFIG_VERSION) < 0;
}

export function migrateProjectConfig(config: any): any {
    if (!needsProjectConfigMigration(config)) {
        return config;
    }
    config.version = MIGRATED_CONFIG_VERSION;

    const targets = config.targets && typeof config.targets === 'object'
        ? config.targets
        : {};
    for (const key of Object.keys(targets)) {
        const target = targets[key];
        if (target.compileConfig) {
            target.toolchainConfig = target.compileConfig;
            target.compileConfig = undefined;
        }
        if (target.compileConfigMap) {
            target.toolchainConfigMap = target.compileConfigMap;
            target.compileConfigMap = undefined;
        }
        if (target.toolchainConfigMap === undefined) {
            target.toolchainConfigMap = {};
        }
        if (target.toolchainConfig) {
            target.toolchainConfigMap[target.toolchain] = target.toolchainConfig;
            target.toolchainConfig = undefined;
        }
        if (target.builderOptions) {
            for (const toolchain of Object.keys(target.builderOptions)) {
                if (target.toolchainConfigMap[toolchain]) {
                    target.toolchainConfigMap[toolchain].options = target.builderOptions[toolchain];
                }
            }
            target.builderOptions = undefined;
        }
        if (target.uploadConfigMap === undefined) {
            target.uploadConfigMap = {};
        }
        if (target.uploadConfig) {
            target.uploadConfigMap[target.uploader] = target.uploadConfig;
            target.uploadConfig = undefined;
        }
        if (target.custom_dep) {
            target.cppPreprocessAttrs = target.custom_dep;
            target.custom_dep = undefined;
        }
    }
    return config;
}

/**
 * Migrate and persist an old config before the loader reads it again; configs
 * that need no migration are returned untouched.
 */
export function migrateLoadedConfig(config: any, configFile: string): any {
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
