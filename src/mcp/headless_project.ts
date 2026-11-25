import * as fs from 'fs';
import * as NodePath from 'path';
import * as yaml from 'yaml';
import { dumpProjectConfig, migrateLoadedConfig } from '../core/project_config_migration';
import { loadProjectSnapshot, ProjectSnapshot } from '../core/project_snapshot';

function ensureStringArray(value: unknown, name: string): string[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`Invalid project config: '${name}' must be a string array.`);
    }
    return value as string[];
}

function unique(values: string[]): string[] {
    const result: string[] = [];
    for (const value of values) {
        if (!result.includes(value)) {
            result.push(value);
        }
    }
    return result;
}

export class HeadlessProject {
    private selectedTarget: string | undefined;

    constructor(
        public readonly projectPath: string,
        target?: string
    ) {
        this.selectedTarget = target;
        this.getTargetNames();
    }

    get configPath(): string {
        return NodePath.join(this.projectPath, '.eide', 'eide.yml');
    }

    private readConfig(): any {
        if (!fs.existsSync(this.configPath)) {
            throw new Error(`Project config not found: ${this.configPath}`);
        }
        const config = yaml.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (!config || typeof config !== 'object') {
            throw new Error(`Invalid project config: ${this.configPath}`);
        }
        return migrateLoadedConfig(config, this.configPath);
    }

    private targetConfig(config: any): { name: string; target: any } {
        const targets = config.targets;
        if (!targets || typeof targets !== 'object') {
            throw new Error(`Invalid project config: no targets in ${this.configPath}`);
        }
        const names = Object.keys(targets);
        if (names.length === 0) {
            throw new Error(`Invalid project config: no targets in ${this.configPath}`);
        }
        const name = this.selectedTarget || names[0];
        if (!targets[name]) {
            throw new Error(`Target '${name}' not found. Available: ${names.join(', ')}`);
        }
        return { name, target: targets[name] };
    }

    private mutate(mutator: (config: any, target: any, targetName: string) => void): void {
        const config = this.readConfig();
        const { name, target } = this.targetConfig(config);
        mutator(config, target, name);
        const temp = `${this.configPath}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(temp, dumpProjectConfig(config));
            fs.renameSync(temp, this.configPath);
        } finally {
            fs.rmSync(temp, { force: true });
        }
    }

    getUid(): string | undefined {
        const uid = this.readConfig().miscInfo?.uid;
        return typeof uid === 'string' && uid.length > 0 ? uid : undefined;
    }

    getTargetNames(): string[] {
        return Object.keys(this.readConfig().targets || {});
    }

    getTargetName(): string {
        return this.targetConfig(this.readConfig()).name;
    }

    selectTarget(name: string): void {
        if (!this.getTargetNames().includes(name)) {
            throw new Error(`Target '${name}' not found.`);
        }
        this.selectedTarget = name;
    }

    getSnapshot(): ProjectSnapshot {
        return loadProjectSnapshot(this.projectPath, this.getTargetName());
    }

    private relativePath(input: string): string {
        const absolute = NodePath.isAbsolute(input)
            ? NodePath.resolve(input)
            : NodePath.resolve(this.projectPath, input);
        const relative = NodePath.relative(this.projectPath, absolute);
        if (relative.length === 0 || relative === '..' || relative.startsWith(`..${NodePath.sep}`)
            || NodePath.isAbsolute(relative)) {
            throw new Error(`Path is outside the project: ${input}`);
        }
        return relative.replace(/\\/g, '/');
    }

    getSrcDirs(): string[] {
        const config = this.readConfig();
        return ensureStringArray(config.srcDirs, 'srcDirs');
    }

    addSrcDir(path: string): void {
        const relative = this.relativePath(path);
        const absolute = NodePath.resolve(this.projectPath, relative);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
            throw new Error(`Source directory not found: ${path}`);
        }
        this.mutate(config => {
            const dirs = ensureStringArray(config.srcDirs, 'srcDirs');
            if (!dirs.includes(relative)) {
                dirs.push(relative);
                config.srcDirs = dirs;
            }
        });
    }

    removeSrcDir(path: string): void {
        const relative = this.relativePath(path);
        this.mutate(config => {
            const dirs = ensureStringArray(config.srcDirs, 'srcDirs')
                .filter(dir => this.relativePath(dir) !== relative);
            config.srcDirs = dirs;
        });
    }

    excludeSourceFile(path: string): void {
        const relative = this.relativePath(path);
        this.mutate((_config, target) => {
            const excludes = ensureStringArray(target.excludeList, 'excludeList');
            if (!excludes.includes(relative)) {
                excludes.push(relative);
                target.excludeList = excludes;
            }
        });
    }

    includeSourceFile(path: string): void {
        const relative = this.relativePath(path);
        this.mutate((_config, target) => {
            target.excludeList = ensureStringArray(target.excludeList, 'excludeList')
                .filter(item => this.relativePath(item) !== relative);
        });
    }

    private dependence(target: any): any {
        if (!target.cppPreprocessAttrs || typeof target.cppPreprocessAttrs !== 'object') {
            target.cppPreprocessAttrs = {
                name: 'default',
                incList: [],
                libList: [],
                defineList: []
            };
        }
        return target.cppPreprocessAttrs;
    }

    getIncludeDirs(): string[] {
        const config = this.readConfig();
        return ensureStringArray(
            this.dependence(this.targetConfig(config).target).incList,
            'cppPreprocessAttrs.incList');
    }

    setIncludeDirs(paths: string[]): void {
        if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
            throw new Error("'paths' must be an array of strings.");
        }
        const normalized = unique(paths.map(path => this.relativePath(path)));
        this.mutate((_config, target) => {
            this.dependence(target).incList = normalized;
        });
    }

    getDefines(): string[] {
        const config = this.readConfig();
        return ensureStringArray(
            this.dependence(this.targetConfig(config).target).defineList,
            'cppPreprocessAttrs.defineList');
    }

    setDefines(defines: string[]): void {
        if (!Array.isArray(defines) || defines.some(define => typeof define !== 'string')) {
            throw new Error("'defines' must be an array of strings.");
        }
        const normalized = unique(defines.map(define => define.trim()).filter(define => define.length > 0));
        this.mutate((_config, target) => {
            this.dependence(target).defineList = normalized;
        });
    }
}
