const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');
const { EideBuildService } = require('../../../src/headless/build_service') as any;
const { createConfigHash } = require('../../../src/core/build_manifest') as any;

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

function write(path: string, content = ''): void {
    fs.mkdirSync(NodePath.dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
}

const root = NodePath.join(os.tmpdir(), `eide-full-build-${process.pid}-${Date.now()}`);
const exe = process.platform === 'win32' ? '.exe' : '';

function projectConfig(): any {
    return {
        version: '4.1',
        name: 'demo',
        type: 'ARM',
        srcDirs: ['src'],
        outDir: 'build',
        dependenceList: [{
            groupName: 'custom',
            depList: [{
                name: 'vendorlib',
                incList: ['vendor/inc'],
                libList: [],
                defineList: ['FROM_DEP=1']
            }]
        }],
        miscInfo: { uid: 'full-build-uid' },
        virtualFolder: {
            name: '<virtual_root>',
            files: [],
            folders: [{
                name: 'virtual',
                files: [{ path: 'virtual_src/extra.c' }],
                folders: []
            }]
        },
        targets: {
            Debug: {
                toolchain: 'GCC',
                toolchainConfigMap: {
                    GCC: {
                        cpuType: 'Cortex-M3',
                        floatingPointHardware: 'default',
                        archExtensions: '',
                        scatterFilePath: 'link.ld',
                        options: {
                            version: 5,
                            'c/cpp-compiler': { C_FLAGS: '-Wall', CXX_FLAGS: '' },
                            'asm-compiler': { ASM_FLAGS: '' },
                            global: {},
                            linker: { LD_FLAGS: '', LIB_FLAGS: '' }
                        }
                    }
                },
                uploadConfigMap: { JLink: {} },
                uploader: 'JLink',
                excludeList: [],
                cppPreprocessAttrs: {
                    name: 'default',
                    incList: ['inc'],
                    libList: [],
                    defineList: ['BASE=1', 'ENV_DEFINE=${PROJECT_VALUE}', 'TARGET_DEFINE=${TARGET_VALUE}']
                },
                settings: {}
            }
        }
    };
}

async function run(): Promise<void> {
    write(NodePath.join(root, 'src', 'main.c'), 'int main(void) { return 0; }');
    write(NodePath.join(root, 'virtual_src', 'extra.c'), 'void extra(void) {}');
    write(NodePath.join(root, 'inc', 'demo.h'), '');
    write(NodePath.join(root, 'vendor', 'inc', 'vendor.h'), '');
    write(NodePath.join(root, 'link.ld'));
    write(NodePath.join(root, '.eide', 'eide.yml'), yaml.stringify(projectConfig()));
    write(NodePath.join(root, '.eide', 'files.options.yml'), yaml.stringify({
        version: '2.1',
        options: {
            Debug: {
                files: { 'src/*.c': '-D_FILE_OPTION=1' },
                virtualPathFiles: { '**/virtual/*.c': '-D_VIRTUAL_OPTION=1' },
                alwaysBuildSourceFiles: ['src/main.c']
            }
        }
    }));
    write(NodePath.join(root, '.eide', 'env.ini'), [
        'PROJECT_VALUE=42',
        'GLOBAL_DEFINE=9',
        '[Debug]',
        'TARGET_VALUE=7'
    ].join('\n'));
    write(NodePath.join(root, 'package.json'), JSON.stringify({
        name: 'eide', version: 'test', contributes: { configuration: [] }
    }));
    write(NodePath.join(root, 'demo.code-workspace'), JSON.stringify({
        folders: [{ path: '.' }],
        settings: { 'EIDE.Builder.ThreadNumber': 9 }
    }));
    const resources = NodePath.join(root, 'res');
    fs.cpSync(NodePath.join(process.cwd(), 'res', 'data', 'models'),
        NodePath.join(resources, 'data', 'models'), { recursive: true });
    const toolsDir = process.platform === 'win32'
        ? NodePath.join(resources, 'tools', 'win32')
        : process.platform === 'linux'
            ? NodePath.join(resources, 'tools', 'linux')
            : NodePath.join(resources, 'tools', 'darwin');
    write(NodePath.join(toolsDir, '7z', `7za${exe}`));
    write(NodePath.join(toolsDir, 'unify_builder', `unify_builder${exe}`));
    const toolchain = NodePath.join(root, 'toolchain');
    write(NodePath.join(toolchain, 'bin', `arm-none-eabi-gcc${exe}`));
    const settingsFile = NodePath.join(root, 'settings.json');
    write(settingsFile, JSON.stringify({
        'Builder.EnvironmentVariables': ['SETTING_VALUE=11']
    }));

    const service = new EideBuildService({
        resourcesDir: resources,
        toolchainPath: toolchain,
        settingsFile,
        runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
        timeoutMs: 5000
    });

    const plan = await service.plan({ projectPath: root, target: 'Debug' });
    const sources: string[] = plan.params.sourceList.map((p: string) => p.replace(/\\/g, '/'));
    assert(sources.includes('src/main.c'), 'full build: physical source');
    assert(sources.includes('virtual_src/extra.c'), 'full build: virtual source');
    assert(plan.params.incDirs.map((p: string) => p.replace(/\\/g, '/')).includes('vendor/inc'),
        'full build: dependency include dir');
    assert(plan.params.defines.includes('FROM_DEP=1'), 'full build: dependency define');
    assert(plan.params.defines.includes('ENV_DEFINE=42'), 'full build: env.ini global variable');
    assert(plan.params.defines.includes('TARGET_DEFINE=7'), 'full build: env.ini target variable');
    assert(plan.params.env.PROJECT_VALUE === '42', 'full build: env exposed to builder');
    assert(plan.params.env.TARGET_VALUE === '7', 'full build: target env exposed');
    assert(plan.params.env.SETTING_VALUE === '11', 'full build: settings environment variable');
    assert(plan.params.sourceParams['src/main.c'].includes('-D_FILE_OPTION=1'),
        'full build: source file options');
    assert(plan.params.sourceParams['virtual_src/extra.c'].includes('-D_VIRTUAL_OPTION=1'),
        'full build: virtual source file options');
    assert(plan.params.alwaysInBuildSources.includes('src/main.c'),
        'full build: always build source files');

    const withSetting = plan.params.defines.find((d: string) => d.startsWith('ENV_DEFINE='));
    assert(withSetting === 'ENV_DEFINE=42', 'full build: env define value');
    assert(plan.params.threadNum === 9, 'full build: workspace thread setting');

    const overridden = await service.plan({
        projectPath: root,
        target: 'Debug',
        overrides: {
            defines: ['FEATURE=1'],
            includeDirs: ['extra-inc'],
            libDirs: ['extra-lib'],
            cFlags: '-O2',
            ldFlags: '-Wl,--gc-sections',
            options: { 'c/cpp-compiler': { warnings: 'all-warnings' } },
            source: { exclude: ['src/main.c'] },
            env: { CI_VALUE: '1' }
        }
    });
    assert(overridden.args.includes('--rebuild'), 'full build: overrides force rebuild');
    assert(overridden.params.defines.includes('FEATURE=1'), 'full build: override define');
    assert(overridden.params.incDirs.includes('extra-inc'), 'full build: override include dir');
    assert(overridden.params.libDirs.includes('extra-lib'), 'full build: override lib dir');
    assert(!overridden.params.sourceList.some((p: string) => p.endsWith('src/main.c')),
        'full build: override source exclude');
    assert(overridden.params.options['c/cpp-compiler'].C_FLAGS.endsWith('-O2'),
        'full build: override c flag');
    assert(overridden.params.options.linker.LD_FLAGS.endsWith('-Wl,--gc-sections'),
        'full build: override ld flag');
    assert(overridden.params.options['c/cpp-compiler'].warnings === 'all-warnings',
        'full build: override options merge');
    assert(overridden.params.env.CI_VALUE === '1', 'full build: override env');

    const threaded = new EideBuildService({
        resourcesDir: resources,
        toolchainPath: toolchain,
        builderThreads: 3,
        runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
        timeoutMs: 5000
    });
    const explicitThreads = await threaded.plan({ projectPath: root, target: 'Debug' });
    assert(explicitThreads.params.threadNum === 3, 'full build: explicit thread count');

    let buildCalls = 0;
    const buildRunner = {
        run: async () => {
            const outDir = NodePath.join(root, 'build', 'Debug');
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(NodePath.join(outDir, 'demo.elf'), 'firmware');
            fs.writeFileSync(NodePath.join(outDir, 'compile_commands.json'), '[]');
            buildCalls++;
            if (buildCalls === 1) {
                return { code: 0, stdout: '', stderr: '' };
            }
            fs.writeFileSync(NodePath.join(outDir, 'compiler.log'),
                'src/main.c:1:1: error: expected expression');
            return { code: 1, stdout: '', stderr: '' };
        }
    };
    const buildService = new EideBuildService({
        resourcesDir: resources,
        toolchainPath: toolchain,
        settingsFile,
        runner: buildRunner,
        timeoutMs: 5000
    });
    const firstBuild = await buildService.build({ projectPath: root, target: 'Debug' });
    assert(firstBuild.success === true, 'full build: first build succeeds');
    assert(firstBuild.artifacts.length === 1, 'full build: first build reports artifact');

    const secondBuild = await buildService.build({ projectPath: root, target: 'Debug' });
    assert(secondBuild.success === false, 'full build: failed build fails');
    assert(Array.isArray(secondBuild.artifacts) && secondBuild.artifacts.length === 0,
        'full build: failed build drops stale artifacts');
    assert(secondBuild.buildId !== firstBuild.buildId, 'full build: build id is unique per build');
    assert(firstBuild.configHash.length === 64 && secondBuild.configHash.length === 64,
        'full build: config hash is sha256');
    assert(createConfigHash({}, { projectPath: root, target: 'Debug' })
        === createConfigHash({}, { projectPath: root, target: 'Debug' }),
        'full build: config hash remains stable');

    const manifest = JSON.parse(fs.readFileSync(
        NodePath.join(root, 'build', 'Debug', 'build-manifest.json'), 'utf8'));
    assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 0,
        'full build: failed manifest drops stale artifacts');
    assert(manifest.buildId === secondBuild.buildId, 'full build: manifest writes per-build id');
    assert(manifest.configHash === secondBuild.configHash, 'full build: manifest writes config hash');
}

run()
    .then(() => {
        console.log('All full build tests passed.');
    })
    .catch(error => {
        console.error(error);
        process.exit(1);
    })
    .finally(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
export {};
