const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');

require('../../../src/headless/vscode').installVscodeShim();

interface ToolchainConfig {
    cpuType?: string;
    scatterFilePath?: string;
    options?: { version?: number; global?: { [key: string]: unknown } };
}

interface TargetConfig {
    toolchainConfigMap?: { [name: string]: ToolchainConfig };
    uploadConfigMap?: { [name: string]: unknown };
    cppPreprocessAttrs?: { incList?: string[]; defineList?: string[] };
    compileConfig?: unknown;
    builderOptions?: unknown;
    uploadConfig?: unknown;
    custom_dep?: unknown;
}

interface ProjectConfig {
    version?: string;
    targets: { [name: string]: TargetConfig };
}

interface HeadlessOptions {
    projectPath: string;
    resourcesDir: string;
    extensionRoot: string;
    toolchainPath: string;
}

interface HeadlessSession {
    project: { GetConfiguration(): { config: ProjectConfig } };
    close(): void;
}

const { openHeadlessProject } = require('../../../src/headless/host') as {
    openHeadlessProject(options: HeadlessOptions): Promise<HeadlessSession>;
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

const repoRoot = NodePath.join(__dirname, '..', '..', '..', '..');
const root = NodePath.join(os.tmpdir(), `eide-headless-migration-${process.pid}-${Date.now()}`);
const toolchainDir = NodePath.join(root, 'toolchain');
const past = new Date('2001-02-03T04:05:06Z');

function legacyConfig(): any {
    return {
        version: '3.5',
        name: 'legacy',
        type: 'ARM',
        srcDirs: ['src'],
        outDir: 'build',
        dependenceList: [],
        miscInfo: { uid: 'legacy-uid' },
        targets: {
            Debug: {
                toolchain: 'GCC',
                uploader: 'JLink',
                excludeList: [],
                compileConfig: {
                    cpuType: 'Cortex-M3',
                    scatterFilePath: 'link.ld',
                    options: {
                        version: 5,
                        global: {},
                        'c/cpp-compiler': { C_FLAGS: '', CXX_FLAGS: '' },
                        'asm-compiler': { ASM_FLAGS: '' },
                        linker: { LD_FLAGS: '', LIB_FLAGS: '' }
                    }
                },
                builderOptions: {
                    GCC: { version: 5, global: { 'output-debug-info': 'enable' } }
                },
                uploadConfig: {},
                custom_dep: {
                    name: 'default',
                    incList: ['inc'],
                    libList: [],
                    defineList: ['BOARD=1']
                },
                settings: {}
            }
        }
    };
}

function currentConfig(): any {
    return {
        version: EIDE_CONF_VERSION,
        name: 'current',
        type: 'ARM',
        srcDirs: ['src'],
        outDir: 'build',
        dependenceList: [],
        miscInfo: { uid: 'current-uid' },
        targets: {
            Debug: {
                toolchain: 'GCC',
                uploader: 'JLink',
                excludeList: [],
                toolchainConfigMap: {
                    GCC: {
                        cpuType: 'Cortex-M3',
                        scatterFilePath: 'link.ld',
                        options: {
                            version: 5,
                            global: {},
                            'c/cpp-compiler': { C_FLAGS: '', CXX_FLAGS: '' },
                            'asm-compiler': { ASM_FLAGS: '' },
                            linker: { LD_FLAGS: '', LIB_FLAGS: '' }
                        }
                    }
                },
                uploadConfigMap: { JLink: {} },
                cppPreprocessAttrs: { name: 'default', incList: [], libList: [], defineList: [] },
                settings: {}
            }
        }
    };
}

function createProject(name: string, config: unknown): { projectDir: string; configFile: string } {
    const projectDir = NodePath.join(root, name);
    fs.mkdirSync(NodePath.join(projectDir, '.eide'), { recursive: true });
    fs.mkdirSync(NodePath.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(
        NodePath.join(projectDir, `${name}.code-workspace`),
        JSON.stringify({ folders: [{ path: '.' }], settings: {} }));
    const configFile = NodePath.join(projectDir, '.eide', 'eide.yml');
    fs.writeFileSync(configFile, yaml.stringify(config));
    return { projectDir, configFile };
}

/** Load a project and capture the lines it writes to stderr. */
async function load(projectDir: string): Promise<{ config: ProjectConfig; log: string }> {
    const lines: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        lines.push(String(chunk));
        return true;
    }) as typeof process.stderr.write;
    try {
        const session = await openHeadlessProject({
            projectPath: projectDir,
            resourcesDir: NodePath.join(repoRoot, 'res'),
            extensionRoot: repoRoot,
            toolchainPath: toolchainDir
        });
        const config = session.project.GetConfiguration().config;
        session.close();
        return { config, log: lines.join('') };
    } finally {
        process.stderr.write = originalWrite;
    }
}

function migrationLines(log: string): string[] {
    return log.split('\n').filter(line => line.includes('migration '));
}

async function run(): Promise<void> {
    fs.mkdirSync(NodePath.join(toolchainDir, 'bin'), { recursive: true });

    const legacy = createProject('legacy', legacyConfig());
    const first = await load(legacy.projectDir);
    const firstMigrations = migrationLines(first.log);

    assert(firstMigrations.length === 1
        && firstMigrations[0].includes('from 3.5 to 4.0'),
        `migration: legacy config load reports one upgrade (${(firstMigrations[0] ?? 'none').trim()})`);
    assert(first.config.version === EIDE_CONF_VERSION,
        `migration: in-memory config is current (${first.config.version})`);
    assert(first.config.targets.Debug.toolchainConfigMap?.GCC.cpuType === 'Cortex-M3',
        'migration: in-memory compileConfig renamed to toolchainConfigMap');
    assert(first.config.targets.Debug.cppPreprocessAttrs?.incList?.[0] === 'inc',
        'migration: in-memory custom_dep renamed to cppPreprocessAttrs');

    const saved = yaml.parse(fs.readFileSync(legacy.configFile, 'utf8'));
    const target = saved.targets.Debug;
    assert(saved.version === EIDE_CONF_VERSION,
        `migration: eide.yml version is current (${saved.version})`);
    assert(target.compileConfig === undefined && target.builderOptions === undefined
        && target.uploadConfig === undefined && target.custom_dep === undefined,
        'migration: eide.yml has no legacy field names');
    assert(target.toolchainConfigMap.GCC.cpuType === 'Cortex-M3'
        && target.toolchainConfigMap.GCC.scatterFilePath === 'link.ld',
        'migration: compileConfig stored as toolchainConfigMap');
    assert(target.toolchainConfigMap.GCC.options.version === 5
        && target.toolchainConfigMap.GCC.options.global['output-debug-info'] === 'enable',
        'migration: builderOptions merged into toolchainConfigMap options');
    assert(JSON.stringify(target.uploadConfigMap) === JSON.stringify({ JLink: {} }),
        'migration: uploadConfig stored as uploadConfigMap');
    assert(JSON.stringify(target.cppPreprocessAttrs.incList) === JSON.stringify(['inc'])
        && JSON.stringify(target.cppPreprocessAttrs.defineList) === JSON.stringify(['BOARD=1']),
        'migration: custom_dep stored as cppPreprocessAttrs');

    const migratedContent = fs.readFileSync(legacy.configFile, 'utf8');
    fs.utimesSync(legacy.configFile, past, past);
    const second = await load(legacy.projectDir);
    assert(migrationLines(second.log).length === 0,
        'migration: second load reports no upgrade');
    assert(fs.statSync(legacy.configFile).mtimeMs === past.getTime()
        && fs.readFileSync(legacy.configFile, 'utf8') === migratedContent,
        'migration: second load rewrites nothing');

    const current = createProject('current', currentConfig());
    const currentContent = fs.readFileSync(current.configFile, 'utf8');
    fs.utimesSync(current.configFile, past, past);
    const loaded = await load(current.projectDir);
    assert(migrationLines(loaded.log).length === 0,
        'current config: load reports no upgrade');
    assert(fs.statSync(current.configFile).mtimeMs === past.getTime()
        && fs.readFileSync(current.configFile, 'utf8') === currentContent,
        'current config: load rewrites nothing');
}

run()
    .then(() => {
        console.log('All headless migration tests passed.');
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        process.exit(0);
    })
    .catch(error => {
        console.error(error);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        process.exit(1);
    });
export {};
