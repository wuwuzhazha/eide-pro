const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');
const { createHeadlessToolExecutor } = require('../../../src/mcp/headless_tools') as any;

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
    return JSON.parse(result.content[0].text);
}

function builderOptions(): any {
    return {
        version: 5,
        beforeBuildTasks: [],
        afterBuildTasks: [],
        global: {},
        'c/cpp-compiler': { C_FLAGS: '', CXX_FLAGS: '' },
        'asm-compiler': { ASM_FLAGS: '' },
        linker: { LD_FLAGS: '', LIB_FLAGS: '', 'output-format': 'elf' }
    };
}

function target(toolchain: string, uploader: string, uploadConfig: any): any {
    return {
        toolchain,
        toolchainConfigMap: {
            [toolchain]: {
                cpuType: 'Cortex-M3',
                floatingPointHardware: 'default',
                archExtensions: '',
                scatterFilePath: 'link.ld',
                options: builderOptions()
            }
        },
        uploader,
        uploadConfigMap: { [uploader]: uploadConfig },
        excludeList: [],
        cppPreprocessAttrs: { name: 'default', incList: [], libList: [], defineList: [] },
        settings: {}
    };
}

function projectConfig(uid: string, targets: { [name: string]: any }, outDir = 'build'): any {
    return {
        version: '4.1',
        name: 'demo',
        type: 'ARM',
        srcDirs: ['src'],
        outDir,
        dependenceList: [],
        miscInfo: { uid },
        targets
    };
}

function writeProject(root: string, config: any): void {
    write(NodePath.join(root, 'src', 'main.c'), 'int main(void) { return 0; }');
    write(NodePath.join(root, 'link.ld'));
    write(NodePath.join(root, '.eide', 'eide.yml'), yaml.stringify(config));
}

function toolchainLayout(root: string): string {
    const dir = NodePath.join(root, 'toolchain');
    write(NodePath.join(dir, 'bin', 'compiler'));
    return dir;
}

class CountingRunner {
    calls: Array<{ file: string; args: string[] }> = [];
    commandFile: string | undefined;

    async run(file: string, args: string[]): Promise<any> {
        this.calls.push({ file, args });
        const index = args.indexOf('-CommandFile');
        if (index >= 0) {
            this.commandFile = fs.readFileSync(args[index + 1], 'utf8');
        }
        return { code: 0, stdout: 'Programmed successfully', stderr: '' };
    }
}

const base = NodePath.join(os.tmpdir(), `eide-headless-parity-${process.pid}-${Date.now()}`);
const resources = NodePath.join(process.cwd(), 'res');

const jlinkConfig = {
    bin: '',
    baseAddr: '0x08000000',
    cpuInfo: { cpuName: 'test-device', vendor: 'ST' },
    proType: 1,
    speed: 4000,
    otherCmds: ''
};

async function cleanTest(): Promise<void> {
    const root = NodePath.join(base, 'clean');
    writeProject(root, projectConfig(
        'clean-uid',
        { Debug: target('GCC', 'Custom', {}) },
        'custom-out'));
    const toolchainPath = toolchainLayout(root);
    const outDir = NodePath.join(root, 'custom-out', 'Debug');
    write(NodePath.join(outDir, 'demo.hex'), 'hex');
    write(NodePath.join(root, 'custom-out', 'keep.txt'), 'keep');

    const execute = createHeadlessToolExecutor({
        projectPaths: [root],
        resourcesDir: resources,
        extensionRoot: process.cwd(),
        toolchainPath,
        buildTimeoutMs: 10000,
        flashTimeoutMs: 10000,
        runner: new CountingRunner()
    });
    const result = await execute('eide_clean', { uid: 'clean-uid' });
    const data = parse(result);
    assert(result.isError !== true && data.success === true && data.command === 'clean',
        'parity: clean succeeds');
    assert(!fs.existsSync(outDir), 'parity: clean removes the resolved outDir');
    assert(fs.existsSync(NodePath.join(root, 'custom-out', 'keep.txt')),
        'parity: clean keeps files outside the target outDir');
    assert(fs.existsSync(NodePath.join(root, 'src', 'main.c')),
        'parity: clean keeps project sources');
}

async function flashDryRunTest(): Promise<void> {
    const root = NodePath.join(base, 'flash-dry-run');
    writeProject(root, projectConfig('flash-uid', {
        Debug: target('GCC', 'JLink', jlinkConfig)
    }));
    const runner = new CountingRunner();
    const execute = createHeadlessToolExecutor({
        projectPaths: [root],
        resourcesDir: resources,
        flasherExecutable: 'C:/tools/JLink.exe',
        buildTimeoutMs: 10000,
        flashTimeoutMs: 10000,
        runner
    });

    let result = await execute('eide_flash', {
        uid: 'flash-uid',
        dryRun: true,
        verify: true,
        artifact: 'fw/app.bin,0x08004000;extra.hex'
    });
    let data = parse(result);
    assert(result.isError !== true && data.uploader === 'JLink',
        'parity: flash dry-run returns the plan');
    assert(data.invocation.executable === 'C:/tools/JLink.exe',
        'parity: flash dry-run uses the configured flasher executable');
    assert(data.verify === true && data.eraseAll === false,
        'parity: flash dry-run passes verify');
    assert(data.programs.length === 2
        && data.programs[0].path === NodePath.join(root, 'fw', 'app.bin')
        && data.programs[0].address === '0x08004000'
        && data.programs[1].path === NodePath.join(root, 'extra.hex'),
    'parity: flash dry-run passes artifact entries');
    assert(data.invocation.script.contents.includes('loadfile')
        && data.invocation.script.contents.includes('app.bin')
        && data.invocation.script.contents.includes(',0x08004000'),
    'parity: flash dry-run command contains the artifact');
    assert(runner.calls.length === 0, 'parity: flash dry-run does not run the flasher');

    const missingExecutable = createHeadlessToolExecutor({
        projectPaths: [root],
        resourcesDir: resources,
        buildTimeoutMs: 10000,
        flashTimeoutMs: 10000,
        runner: new CountingRunner()
    });
    result = await missingExecutable('eide_flash', {
        uid: 'flash-uid',
        dryRun: true,
        eraseAll: false
    });
    assert(result.isError === true && result.content[0].text.includes('--flasher-exe is required'),
        'parity: flash dry-run requires the configured flasher executable');

    result = await execute('eide_flash', {
        uid: 'flash-uid',
        verify: true,
        artifact: 'fw/app.bin,0x08004000'
    });
    data = parse(result);
    assert(result.isError !== true && data.success === true && runner.calls.length === 1,
        'parity: flash executes the planned command');
    assert(runner.commandFile !== undefined
        && runner.commandFile.includes('loadfile')
        && runner.commandFile.includes('app.bin')
        && runner.commandFile.includes(',0x08004000'),
    'parity: flash real run keeps the artifact');
}

async function isolationTest(): Promise<void> {
    const rootA = NodePath.join(base, 'isolation-a');
    const rootB = NodePath.join(base, 'isolation-b');
    const targets: { [name: string]: any } = {
        Debug: target('GCC', 'Custom', {}),
        Release: target('GCC', 'Custom', {})
    };
    writeProject(rootA, projectConfig('uid-a', targets));
    writeProject(rootB, projectConfig('uid-b', targets));
    const configB = NodePath.join(rootB, '.eide', 'eide.yml');
    const before = fs.readFileSync(configB, 'utf8');

    const execute = createHeadlessToolExecutor({
        projectPaths: [rootA, rootB],
        resourcesDir: resources,
        buildTimeoutMs: 10000,
        flashTimeoutMs: 10000,
        runner: new CountingRunner()
    });

    let result = await execute('eide_switch_target', { uid: 'uid-a', targetName: 'Release' });
    assert(result.isError !== true, 'parity: switch target on one project succeeds');

    const dataA = parse(await execute('eide_get_targets', { uid: 'uid-a' }));
    assert(dataA.actived === 'Release', 'parity: switched project uses the new target');
    const dataB = parse(await execute('eide_get_targets', { uid: 'uid-b' }));
    assert(dataB.actived === 'Debug' && dataB.targets.join('|') === 'Debug|Release',
        'parity: other project target selection is unchanged');
    assert(fs.readFileSync(configB, 'utf8') === before,
        'parity: other project config is unchanged');
}

async function run(): Promise<void> {
    await cleanTest();
    await flashDryRunTest();
    await isolationTest();
}

run()
    .then(() => {
        console.log('All headless tool parity tests passed.');
    })
    .catch(error => {
        console.error(error);
        process.exit(1);
    })
    .finally(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });
export {};
