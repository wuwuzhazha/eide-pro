const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');
const { createHeadlessToolExecutor } = require('../../../src/mcp/headless_tools') as any;
const { loadProjectSnapshot } = require('../../../src/core/project_snapshot') as any;

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

function parse(result: any): any {
    try {
        return JSON.parse(result.content[0].text);
    } catch {
        return result.content[0].text;
    }
}

const root = NodePath.join(os.tmpdir(), `eide-headless-tools-${process.pid}-${Date.now()}`);
const exe = process.platform === 'win32' ? '.exe' : '';
const outDir = NodePath.join(root, 'build', 'Debug');

function projectConfig(): any {
    return {
        version: '4.1',
        name: 'demo',
        type: 'ARM',
        srcDirs: ['src'],
        outDir: 'build',
        dependenceList: [],
        miscInfo: { uid: 'project-uid' },
        virtualFolder: { name: '<virtual_root>', files: [], folders: [] },
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
                uploadConfigMap: {
                    pyOCD: {
                        bin: '',
                        targetName: 'cortex_m',
                        baseAddr: '0x08000000',
                        speed: '4M',
                        config: '',
                        otherCmds: ''
                    }
                },
                uploader: 'pyOCD',
                excludeList: [],
                cppPreprocessAttrs: {
                    name: 'default', incList: ['src'], libList: [], defineList: ['DEMO=1']
                },
                settings: {}
            },
            Release: {
                toolchain: 'GCC',
                toolchainConfigMap: { GCC: { options: {} } },
                uploadConfigMap: {},
                uploader: 'pyOCD',
                excludeList: [],
                cppPreprocessAttrs: { name: 'default', incList: [], libList: [], defineList: [] },
                settings: {}
            }
        }
    };
}

class FakeRunner {
    async run(file: string, args: string[]): Promise<any> {
        if (/unify_builder/.test(file)) {
            const paramsIndex = args.indexOf('-p');
            const params = JSON.parse(fs.readFileSync(args[paramsIndex + 1], 'utf8'));
            const log = [
                '>>> cc',
                "src/main.c:2:5: warning: unused variable 'x' [Wunused-variable]",
                '>>> ld',
                'Memory region         Used Size  Region Size  %age Used',
                '           FLASH:       1024 B        64 KB      1.56%',
                '             RAM:        256 B        20 KB      1.25%'
            ].join('\n');
            fs.mkdirSync(NodePath.join(root, params.outDir), { recursive: true });
            fs.writeFileSync(NodePath.join(root, params.outDir, 'compiler.log'), log);
            return { code: 0, stdout: 'done', stderr: '' };
        }
        return { code: 0, stdout: 'Programmed successfully\nVerified OK', stderr: '' };
    }
}

async function run(): Promise<void> {
    write(NodePath.join(root, 'src', 'main.c'), 'int main(void) { return 0; }');
    write(NodePath.join(root, 'hal', 'gpio.c'), 'void gpio(void) {}');
    write(NodePath.join(root, 'inc', 'demo.h'), '');
    write(NodePath.join(root, '.eide', 'eide.yml'), yaml.stringify(projectConfig()));
    write(NodePath.join(root, 'link.ld'));
    write(NodePath.join(root, 'package.json'), JSON.stringify({
        name: 'eide', version: 'test', contributes: { configuration: [] }
    }));

    const resources = NodePath.join(root, 'res');
    const toolsDir = process.platform === 'win32'
        ? NodePath.join(resources, 'tools', 'win32')
        : process.platform === 'linux'
            ? NodePath.join(resources, 'tools', 'linux')
            : NodePath.join(resources, 'tools', 'darwin');
    write(NodePath.join(toolsDir, '7z', `7za${exe}`));
    fs.cpSync(NodePath.join(process.cwd(), 'res', 'data', 'models'),
        NodePath.join(resources, 'data', 'models'), { recursive: true });
    if (process.platform === 'win32') {
        write(NodePath.join(resources, 'tools', 'win32', 'unify_builder', 'unify_builder.exe'));
    } else if (process.platform === 'linux') {
        write(NodePath.join(resources, 'tools', 'linux', 'unify_builder', 'unify_builder'));
    } else {
        const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
        write(NodePath.join(resources, 'tools', 'darwin', 'unify_builder', arch, 'unify_builder'));
    }
    const toolchain = NodePath.join(root, 'toolchain');
    write(NodePath.join(toolchain, 'bin', `arm-none-eabi-gcc${exe}`));
    const schemaDir = NodePath.join(root, 'lang');
    write(NodePath.join(schemaDir, 'arm.gcc.verify.json'), JSON.stringify({
        type: 'object',
        properties: { global: { type: 'object' } },
        additionalProperties: true
    }));

    const watchdogRunner = new FakeRunner();
    const watchdogExecute = createHeadlessToolExecutor({
        projectPaths: [root],
        resourcesDir: resources,
        toolchainPath: toolchain,
        buildTimeoutMs: 10000,
        flashTimeoutMs: 10000,
        toolWatchdogMs: 50,
        runner: watchdogRunner,
        toolRunner: {
            execute: async (tool: string) => tool === 'eide_build'
                ? new Promise(() => undefined)
                : { isError: false, content: [{ type: 'text', text: '{}' }] }
        }
    });
    const watchdogResult = await watchdogExecute('eide_build', { uid: 'project-uid' });
    assert(watchdogResult.isError === true, 'headless: watchdog rejects a stuck tool');
    const watchdogError = parse(watchdogResult);
    assert(watchdogError.error.kind === 'timeout', 'headless: watchdog reports timeout kind');
    const afterWatchdog = await watchdogExecute('eide_get_targets', { uid: 'project-uid' });
    assert(afterWatchdog.isError !== true, 'headless: queue continues after watchdog timeout');

    const execute = createHeadlessToolExecutor({
        projectPaths: [root],
        resourcesDir: resources,
        toolchainPath: toolchain,
        buildTimeoutMs: 10000,
        flashTimeoutMs: 10000,
        runner: new FakeRunner()
    });

    let result = await execute('eide_get_targets', { uid: 'wrong-uid' });
    assert(result.isError === true, 'headless: mismatched uid is rejected');

    result = await execute('eide_get_targets', { uid: 'project-uid' });
    let data = parse(result);
    assert(data.actived === 'Debug' && data.targets.join('|') === 'Debug|Release',
        'headless: get targets');

    result = await execute('eide_switch_target', { uid: 'project-uid', targetName: 'Release' });
    assert(result.isError !== true, 'headless: switch target succeeds');
    data = parse(await execute('eide_get_targets', { uid: 'project-uid' }));
    assert(data.actived === 'Release', 'headless: active target changes');
    await execute('eide_switch_target', { uid: 'project-uid', targetName: 'Debug' });

    result = await execute('eide_add_src_dir', { uid: 'project-uid', path: 'hal' });
    assert(result.isError !== true, 'headless: add source dir');
    data = parse(await execute('eide_get_src_dirs', { uid: 'project-uid' }));
    assert(data.items.join('|') === 'src|hal', 'headless: source dirs list');
    result = await execute('eide_del_src_dir', { uid: 'project-uid', path: 'hal' });
    assert(result.isError !== true, 'headless: remove source dir');

    result = await execute('eide_exclude_src_file', { uid: 'project-uid', path: 'src/main.c' });
    assert(result.isError !== true, 'headless: exclude source file');
    assert(loadProjectSnapshot(root).excludeList.includes('src/main.c'),
        'headless: exclude is persisted');
    result = await execute('eide_include_src_file', { uid: 'project-uid', path: 'src/main.c' });
    assert(result.isError !== true, 'headless: include source file');
    assert(!loadProjectSnapshot(root).excludeList.includes('src/main.c'),
        'headless: include is persisted');

    result = await execute('eide_set_inc_dirs', { uid: 'project-uid', paths: ['inc'] });
    assert(result.isError !== true, 'headless: set include dirs');
    data = parse(await execute('eide_get_inc_dirs', { uid: 'project-uid' }));
    assert(data.items.join('|') === 'inc', 'headless: include dirs list');

    result = await execute('eide_set_defines', { uid: 'project-uid', defines: ['A=1', ' A=1 ', 'B=2'] });
    assert(result.isError !== true, 'headless: set defines');
    data = parse(await execute('eide_get_defines', { uid: 'project-uid' }));
    assert(data.items.join('|') === 'A=1|B=2', 'headless: defines list');

    result = await execute('eide_get_builder_opts_schema', { uid: 'project-uid' });
    const schemaTop = parse(result);
    assert(typeof schemaTop === 'object' && schemaTop.global !== undefined,
        'headless: builder options schema top-level keys');

    result = await execute('eide_get_builder_opts_schema', {
        uid: 'project-uid',
        path: 'global'
    });
    assert(typeof parse(result) === 'object', 'headless: builder options schema subtree');

    result = await execute('eide_set_builder_opts', {
        uid: 'project-uid',
        options: { version: 5, global: { toolPrefix: 'arm-none-eabi-' } }
    });
    assert(result.isError !== true, 'headless: set builder options');
    data = parse(await execute('eide_get_builder_opts', { uid: 'project-uid' }));
    assert(data.global.toolPrefix === 'arm-none-eabi-', 'headless: builder options list');

    result = await execute('eide_set_builder_opts', {
        uid: 'project-uid',
        options: { global: 'invalid' }
    });
    assert(result.isError === true && result.content[0].text.includes('validation failed'),
        'headless: invalid builder options are rejected');

    result = await execute('eide_build', {
        uid: 'project-uid',
        overrides: { cFlags: '-O2', defines: ['FEATURE=1'] }
    });
    data = parse(result);
    assert(data.success === true, 'headless: build succeeds');
    assert(data.problems.length === 1 && data.problems[0].severity === 'warning',
        'headless: build problems');
    assert(data.memory.FLASH.used === 1024, 'headless: build memory');
    assert(data.effectiveConfig.cFlags.includes('-O2'), 'headless: build overrides applied');

    result = await execute('eide_build', {
        uid: 'project-uid',
        dryRun: true,
        overrides: { ldFlags: '-Wl,--gc-sections' }
    });
    data = parse(result);
    assert(data.dryRun === true && data.success === true, 'headless: build dry run');
    assert(data.params.options.linker.LD_FLAGS === '-Wl,--gc-sections',
        'headless: dry run includes overrides');
    assert(data.args.includes('--rebuild'), 'headless: dry run forces rebuild for overrides');

    result = await execute('eide_flash', { uid: 'project-uid' });
    data = parse(result);
    assert(result.isError !== true && data.success === true && data.uploader === 'pyOCD',
        'headless: flash succeeds');

    write(NodePath.join(outDir, 'statistic.json'), JSON.stringify({
        callgraph: [],
        stackusage: []
    }));
    data = parse(await execute('eide_get_stack_usage', { uid: 'project-uid' }));
    assert(data.available === false, 'headless: stack usage without data');
    data = parse(await execute('eide_query_callgraph', { uid: 'project-uid', symbol: 'main' }));
    assert(data.available === false, 'headless: callgraph without data');

    result = await execute('eide_reload', { uid: 'project-uid' });
    assert(result.isError !== true, 'headless: reload succeeds');

    result = await execute('eide_unknown_tool', { uid: 'project-uid' });
    assert(result.isError === true, 'headless: unknown tool fails');
}

run()
    .then(() => {
        console.log('All headless tool tests passed.');
    })
    .catch(error => {
        console.error(error);
        process.exit(1);
    })
    .finally(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
export {};
