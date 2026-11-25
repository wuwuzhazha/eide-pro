const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');

require('../../../src/headless/vscode').installVscodeShim();

interface TargetConfig {
    toolchain?: string;
    custom_dep?: unknown;
    cppPreprocessAttrs?: {
        name?: string;
        incList?: string[];
        libList?: string[];
        defineList?: string[];
    };
}

interface ProjectConfig {
    version?: string;
    name?: string;
    type?: string;
    srcDirs?: string[];
    outDir?: string;
    dependenceList?: unknown[];
    miscInfo?: { uid?: string };
    targets: { [name: string]: TargetConfig };
}

const { HeadlessProject } = require('../../../src/mcp/headless_project') as {
    HeadlessProject: new (projectPath: string, target?: string) => {
        configPath: string;
        getIncludeDirs(): string[];
        setIncludeDirs(paths: string[]): void;
        getDefines(): string[];
        setDefines(defines: string[]): void;
    };
};
const { needsProjectConfigMigration, MIGRATED_CONFIG_VERSION } = require('../../../src/core/project_config_migration') as {
    needsProjectConfigMigration(config: unknown): boolean;
    MIGRATED_CONFIG_VERSION: string;
};
const { EIDE_CONF_VERSION } = require('../../../src/EIDETypeDefine') as {
    EIDE_CONF_VERSION: string;
};

function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

const root = NodePath.join(os.tmpdir(), `eide-headless-project-migration-${process.pid}-${Date.now()}`);
const past = new Date('2001-02-03T04:05:06Z');

function legacyConfig(): ProjectConfig {
    return {
        version: '3.5',
        name: 'legacy-mcp',
        type: 'ARM',
        srcDirs: ['src'],
        outDir: 'build',
        dependenceList: [],
        miscInfo: { uid: 'legacy-mcp-uid' },
        targets: {
            Debug: {
                toolchain: 'GCC',
                custom_dep: {
                    name: 'default',
                    incList: ['inc'],
                    libList: [],
                    defineList: ['BOARD=1']
                }
            }
        }
    };
}

function currentConfig(): ProjectConfig {
    return {
        version: EIDE_CONF_VERSION,
        name: 'current-mcp',
        type: 'ARM',
        srcDirs: ['src'],
        outDir: 'build',
        dependenceList: [],
        miscInfo: { uid: 'current-mcp-uid' },
        targets: {
            Debug: {
                toolchain: 'GCC',
                cppPreprocessAttrs: { name: 'default', incList: [], libList: [], defineList: [] }
            }
        }
    };
}

function createProject(name: string, config: ProjectConfig): { projectDir: string; configFile: string } {
    const projectDir = NodePath.join(root, name);
    fs.mkdirSync(NodePath.join(projectDir, '.eide'), { recursive: true });
    const configFile = NodePath.join(projectDir, '.eide', 'eide.yml');
    fs.writeFileSync(configFile, yaml.stringify(config));
    return { projectDir, configFile };
}

function readConfigFile(configFile: string): ProjectConfig {
    return yaml.parse(fs.readFileSync(configFile, 'utf8'));
}

function run(): void {
    fs.mkdirSync(root, { recursive: true });

    const legacy = createProject('legacy', legacyConfig());
    const project = new HeadlessProject(legacy.projectDir);

    assert(project.getIncludeDirs().join('|') === 'inc'
        && project.getDefines().join('|') === 'BOARD=1',
        'legacy project: include/define reads return migrated values (not empty lists)');

    const saved = readConfigFile(legacy.configFile);
    assert(saved.version === MIGRATED_CONFIG_VERSION
        && (saved.targets.Debug as TargetConfig & { [key: string]: unknown }).custom_dep === undefined
        && saved.targets.Debug.cppPreprocessAttrs?.incList?.[0] === 'inc',
        'legacy project: first read migrates and persists eide.yml');

    project.setIncludeDirs(['inc', 'lib']);
    const edited = readConfigFile(legacy.configFile);
    assert((edited.targets.Debug as TargetConfig & { [key: string]: unknown }).custom_dep === undefined
        && JSON.stringify(edited.targets.Debug.cppPreprocessAttrs?.incList) === JSON.stringify(['inc', 'lib']),
        'legacy project: setIncludeDirs writes new field with custom_dep not resurrected');

    assert(!needsProjectConfigMigration(edited),
        'legacy project: edited config needs no migration, a later build cannot overwrite the edit');

    const editedContent = fs.readFileSync(legacy.configFile, 'utf8');
    fs.utimesSync(legacy.configFile, past, past);
    project.getIncludeDirs();
    project.getDefines();
    assert(fs.statSync(legacy.configFile).mtimeMs === past.getTime()
        && fs.readFileSync(legacy.configFile, 'utf8') === editedContent,
        'legacy project: reads after edit rewrite nothing');

    const current = createProject('current', currentConfig());
    const currentContent = fs.readFileSync(current.configFile, 'utf8');
    fs.utimesSync(current.configFile, past, past);
    const currentProject = new HeadlessProject(current.projectDir);
    currentProject.getDefines();
    currentProject.getIncludeDirs();
    assert(fs.statSync(current.configFile).mtimeMs === past.getTime()
        && fs.readFileSync(current.configFile, 'utf8') === currentContent,
        'current project: reads rewrite nothing');

    currentProject.setDefines(['USE_USB=1']);
    const written = readConfigFile(current.configFile);
    assert(JSON.stringify(written.targets.Debug.cppPreprocessAttrs?.defineList)
        === JSON.stringify(['USE_USB=1']),
        'current project: setDefines writes without migration');

    assert(!needsProjectConfigMigration(written),
        'current project: written config still needs no migration');
    fs.utimesSync(current.configFile, past, past);
    new HeadlessProject(current.projectDir);
    assert(fs.statSync(current.configFile).mtimeMs === past.getTime(),
        'current project: later loads rewrite nothing');
}

try {
    run();
    console.log('All headless project migration tests passed.');
    process.exit(0);
} catch (error) {
    console.error(error);
    process.exit(1);
} finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
export {};
