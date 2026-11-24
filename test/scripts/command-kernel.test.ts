const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');
const { classifyError, createCommandKernel } = require('../../../src/core/command_kernel') as any;

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
                uploader: 'Custom',
                uploadConfigMap: { Custom: {} }
            }
        }
    };
}

async function run(): Promise<void> {
    write(NodePath.join(root, 'src', 'main.c'), 'int main(void) { return 0; }');
    write(NodePath.join(root, '.eide', 'eide.yml'), yaml.stringify(config('build')));
    const outDir = NodePath.join(root, 'build', 'Debug');
    write(NodePath.join(outDir, 'demo.hex'), 'hex');

    const kernel = createCommandKernel();
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

    const usage = new Error('bad option');
    usage.name = 'CliUsageError';
    assert(classifyError(usage, null).error.kind === 'usage', 'kernel: classifies usage errors');

    const tool = new Error('builder failed');
    tool.name = 'BuildExecutionError';
    assert(classifyError(tool, 'clean').error.kind === 'tool', 'kernel: classifies tool errors');

    assert(classifyError(new Error('boom'), 'clean').error.kind === 'config',
        'kernel: classifies config errors');
}

run()
    .then(() => console.log('All command kernel tests passed.'))
    .catch(error => { console.error(error); process.exit(1); })
    .finally(() => fs.rmSync(root, { recursive: true, force: true }));
export {};
