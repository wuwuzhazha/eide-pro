const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');
const { EideBuildService } = require('../../../src/headless/build_service') as any;
const { ProcessTimeoutError } = require('../../../src/core/process_runner') as any;

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

const root = NodePath.join(os.tmpdir(), `eide-headless-service-${process.pid}-${Date.now()}`);
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
        miscInfo: { uid: 'headless-service-uid' },
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
                cppPreprocessAttrs: { name: 'default', incList: ['src'], libList: [], defineList: ['DEMO=1'] },
                settings: {}
            }
        }
    };
}

class FakeRunner {
    constructor(private readonly action: (args: string[]) => any) {}
    async run(file: string, args: string[]): Promise<any> {
        return this.action(args);
    }
}

async function run(): Promise<void> {
    write(NodePath.join(root, 'src', 'main.c'), 'int main(void) { return 0; }');
    write(NodePath.join(root, '.eide', 'eide.yml'), yaml.stringify(projectConfig()));
    write(NodePath.join(root, 'link.ld'));
    write(NodePath.join(root, 'package.json'), JSON.stringify({
        name: 'eide', version: 'test', contributes: { configuration: [] }
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

    const successLog = [
        '>>> cc',
        "src/main.c: In function 'main':",
        "src/main.c:3:9: warning: unused variable 'x' [Wunused-variable]",
        '>>> ld',
        'Memory region         Used Size  Region Size  %age Used',
        '           FLASH:       1234 B        64 KB      1.88%',
        '             RAM:        567 B        20 KB      2.77%'
    ].join('\n');

    const successService = new EideBuildService({
        resourcesDir: resources,
        toolchainPath: toolchain,
        runner: new FakeRunner(args => {
            assert(args.includes('-p'), 'service: builder receives params path');
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(NodePath.join(outDir, 'compiler.log'), successLog);
            fs.writeFileSync(NodePath.join(outDir, 'demo.elf'), 'elf');
            fs.writeFileSync(NodePath.join(outDir, 'compile_commands.json'), '[]');
            return { code: 0, stdout: 'done', stderr: '' };
        }),
        timeoutMs: 5000
    });
    const result = await successService.build({
        projectPath: root,
        target: 'Debug',
        overrides: { cFlags: '-O2' }
    });
    assert(result.success === true, 'service: successful build');
    assert(result.configHash.length === 64, 'service: config hash');
    assert(result.stage === 'link', 'service: stage');
    assert(result.problems.length === 1 && result.problems[0].severity === 'warning',
        'service: parses warning');
    assert(result.problems[0].line === 3 && result.problems[0].column === 9,
        'service: problem location');
    assert(result.memory.FLASH.used === 1234 && result.memory.FLASH.size === 65536,
        'service: memory usage');
    assert(result.artifacts.length === 1 && result.artifacts[0].endsWith('demo.elf'),
        'service: artifacts');
    assert(result.compileCommands.endsWith('compile_commands.json'),
        'service: compile commands');
    assert(result.effectiveConfig.cFlags === '-Wall -O2', 'service: effective config');
    assert(fs.existsSync(NodePath.join(outDir, 'build-manifest.json')), 'service: manifest');
    assert(result.logTail === undefined, 'service: no log tail on success');

    const failureLog = [
        '>>> cc',
        'src/main.c:7:3: error: expected expression before end of input'
    ].join('\n');
    const failureService = new EideBuildService({
        resourcesDir: resources,
        toolchainPath: toolchain,
        runner: new FakeRunner(() => {
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(NodePath.join(outDir, 'compiler.log'), failureLog);
            return { code: 1, stdout: '', stderr: 'build failed' };
        }),
        timeoutMs: 5000
    });
    const failed = await failureService.build({ projectPath: root, mode: 'rebuild' });
    assert(failed.success === false, 'service: failed build');
    assert(failed.failureKind === 'build', 'service: build failure kind');
    assert(failed.stage === 'compile', 'service: failure stage');
    assert(failed.problems[0].severity === 'error', 'service: parses error');
    assert(failed.logTail.includes('expected expression'), 'service: log tail');

    const timeoutService = new EideBuildService({
        resourcesDir: resources,
        toolchainPath: toolchain,
        runner: new FakeRunner(() => {
            throw new ProcessTimeoutError(42, 'partial', '');
        }),
        timeoutMs: 42
    });
    const timedOut = await timeoutService.build({ projectPath: root });
    assert(timedOut.success === false && timedOut.analysisError.includes('timed out'),
        'service: timeout is reported');
    assert(timedOut.failureKind === 'timeout', 'service: timeout failure kind');
    assert(timedOut.logTail.includes('partial'), 'service: timeout log tail');

    const signalService = new EideBuildService({
        resourcesDir: resources,
        toolchainPath: toolchain,
        runner: new FakeRunner(() => ({ code: null, stdout: 'signal', stderr: '' })),
        timeoutMs: 5000
    });
    const signaled = await signalService.build({ projectPath: root });
    assert(signaled.success === false && signaled.failureKind === 'signal',
        'service: signal failure kind');

    const failedManifest = JSON.parse(fs.readFileSync(
        NodePath.join(outDir, 'build-manifest.json'), 'utf8'));
    assert(failedManifest.failureKind === 'signal', 'service: manifest writes failure kind');

    const cleaned = await successService.clean({ projectPath: root });
    assert(cleaned.success === true && !fs.existsSync(outDir), 'service: clean removes output');
    const cleanedAgain = await successService.clean({ projectPath: root });
    assert(cleanedAgain.success === true && cleanedAgain.message.includes('does not exist'),
        'service: clean is idempotent');

    write(NodePath.join(root, 'demo.code-workspace'), '{}');
    const workspacePlan = await successService.plan({
        projectPath: root,
        workspaceFile: NodePath.join(root, 'demo.code-workspace')
    });
    assert(workspacePlan.outDir === outDir, 'service: accepts code-workspace path');
}

run()
    .then(() => {
        console.log('All headless build service tests passed.');
    })
    .catch(error => {
        console.error(error);
        process.exit(1);
    })
    .finally(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
export {};
