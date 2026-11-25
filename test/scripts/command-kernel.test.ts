const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');
const { CliUsageError } = require('../../../src/cli/args') as any;
const { classifyError, ConfigError, createCommandKernel } = require('../../../src/core/command_kernel') as any;

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

const root = NodePath.join(os.tmpdir(), `eide-command-kernel-${process.pid}-${Date.now()}`);

function config(outDir: string): any {
    return {
        version: '4.1',
        name: 'demo',
        type: 'ARM',
        srcDirs: ['src'],
        outDir,
        dependenceList: [],
        miscInfo: { uid: 'kernel-uid' },
        targets: {
            Debug: {
                toolchain: 'GCC',
                toolchainConfigMap: { GCC: { options: {} } },
                uploader: 'JLink',
                uploadConfigMap: {
                    JLink: {
                        bin: '',
                        baseAddr: '0x08000000',
                        cpuInfo: { cpuName: 'test-device', vendor: 'ST' },
                        proType: 1,
                        speed: 4000,
                        otherCmds: ''
                    }
                }
            }
        }
    };
}

async function run(): Promise<void> {
    write(NodePath.join(root, 'src', 'main.c'), 'int main(void) { return 0; }');
    write(NodePath.join(root, '.eide', 'eide.yml'), yaml.stringify(config('build')));
    const outDir = NodePath.join(root, 'build', 'Debug');
    write(NodePath.join(outDir, 'demo.hex'), 'hex');

    const kernel = createCommandKernel({ runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) } });

    const dryRun = await kernel.flash({
        command: 'flash',
        projectPath: root,
        target: 'Debug',
        flasherExecutable: 'C:/fake/JLink.exe',
        dryRun: true
    });
    assert(dryRun.success === true && dryRun.verify === true,
        'kernel: flash dry-run reports the default verification');

    const cleaned = await kernel.clean({
        command: 'clean',
        projectPath: root,
        target: 'Debug'
    });
    assert(cleaned.success === true && cleaned.command === 'clean',
        'kernel: clean succeeds with flat result');
    assert(!fs.existsSync(outDir), 'kernel: clean removes output');

    write(NodePath.join(root, '.eide', 'eide.yml'), yaml.stringify(config('../outside')));
    const escaped = await kernel.clean({
        command: 'clean',
        projectPath: root,
        target: 'Debug'
    });
    assert(escaped.success === false && escaped.command === 'clean'
        && escaped.error.kind === 'config' && escaped.error.message.includes('Refusing'),
        'kernel: clean rejects outDir escape as config error');

    assert(classifyError(new CliUsageError('bad option'), null).error.kind === 'usage',
        'kernel: classifies usage errors');

    assert(classifyError(new ConfigError('bad config'), 'clean').error.kind === 'config',
        'kernel: classifies config errors');
    assert(classifyError(new Error('boom'), 'clean').error.kind === 'internal',
        'kernel: classifies internal errors');

    const flashResult = await kernel.flash({
        command: 'flash',
        projectPath: root,
        target: 'Debug',
        flasherExecutable: 'C:/fake/JLink.exe',
        eraseAll: true,
        verify: true
    });
    assert(flashResult.success === false && flashResult.error.kind === 'config',
        'kernel: flash not_supported is a config error');
}

run()
    .then(() => console.log('All command kernel tests passed.'))
    .catch(error => { console.error(error); process.exit(1); })
    .finally(() => fs.rmSync(root, { recursive: true, force: true }));
export {};
