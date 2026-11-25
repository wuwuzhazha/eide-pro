const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const yaml = require('yaml');
const { createHeadlessToolExecutor } = require('../../../src/mcp/headless_tools') as any;

const QEMU_MACHINE = 'mps2-an385';
const QEMU_CPU = 'cortex-m3';
const QEMU_ARGS = ['-nographic', '-monitor', 'none', '-serial', 'none'];

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

function write(path: string, content = ''): void {
    fs.mkdirSync(NodePath.dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
}

function parse(result: any): any {
    return JSON.parse(result.content[0].text);
}

function commandExists(command: string): boolean {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
        encoding: 'utf8'
    });
    return result.status === 0;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Could not allocate a free port')));
                return;
            }
            server.close(() => resolve(address.port));
        });
    });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const connected = await new Promise<boolean>(resolve => {
            const socket = net.connect({ host: '127.0.0.1', port });
            socket.setTimeout(500);
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => resolve(false));
            socket.once('timeout', () => { socket.destroy(); resolve(false); });
        });
        if (connected) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`QEMU gdbstub did not listen on 127.0.0.1:${port}`);
}

function stopProcess(child: any): Promise<void> {
    if (!child || child.exitCode !== null) {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already stopped */ }
            resolve();
        }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
}

async function run(): Promise<void> {
    const qemu = process.env.QEMU_SYSTEM_ARM || 'qemu-system-arm';
    const gdb = process.env.ARM_GDB || 'arm-none-eabi-gdb';
    if (!commandExists(qemu)) {
        console.log(`SKIPPED: ${qemu} not found; install QEMU to run the real GDB/MI session.`);
        return;
    }
    if (!commandExists(gdb)) {
        console.log(`SKIPPED: ${gdb} not found; install ARM GDB to run the real GDB/MI session.`);
        return;
    }

    const root = fs.mkdtempSync(NodePath.join(os.tmpdir(), 'eide-debug-qemu-'));
    const project = NodePath.join(root, 'project');
    const toolchainRoot = process.env.ARM_GCC_ROOT || '/usr';
    const gcc = NodePath.join(toolchainRoot, 'bin', process.platform === 'win32'
        ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc');
    if (!fs.existsSync(gcc)) {
        fs.rmSync(root, { recursive: true, force: true });
        console.log(`SKIPPED: ARM GCC not found at ${gcc}.`);
        return;
    }

    const fixture = NodePath.join(__dirname, '..', 'e2e', 'fixtures', 'cortex-m3');
    const sourceFixture = fs.existsSync(fixture)
        ? fixture
        : NodePath.join(__dirname, '..', '..', '..', 'test', 'e2e', 'fixtures', 'cortex-m3');
    fs.cpSync(sourceFixture, project, { recursive: true });

    let qemuProcess: any;
    try {
        const build = spawnSync(process.execPath, [
            NodePath.join(__dirname, '..', '..', 'dist', 'eide_cli.js'),
            'build', '--project', project, '--toolchain-path', toolchainRoot,
            '--timeout', '120000'
        ], { encoding: 'utf8' });
        assert(build.status === 0, `qemu fixture builds\n${build.stderr}`);
        const buildResult = JSON.parse(build.stdout);
        const elf = (buildResult.artifacts || []).find((file: string) => file.endsWith('.elf'));
        assert(typeof elf === 'string' && fs.existsSync(elf), 'qemu fixture produces an ELF');

        const port = await freePort();
        const target = `127.0.0.1:${port}`;
        qemuProcess = spawn(qemu, [
            '-M', QEMU_MACHINE,
            '-cpu', QEMU_CPU,
            '-kernel', elf,
            '-gdb', `tcp:${target}`,
            ...QEMU_ARGS
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        qemuProcess.stderr.resume();
        await waitForPort(port, 5000);

        const execute = createHeadlessToolExecutor({
            projectPaths: [project],
            resourcesDir: NodePath.join(__dirname, '..', '..', '..', 'res'),
            extensionRoot: NodePath.join(__dirname, '..', '..', '..'),
            toolchainPath: toolchainRoot,
            buildTimeoutMs: 5000,
            flashTimeoutMs: 5000,
            runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
            gdbPath: gdb,
            debugCommandTimeoutMs: 10000,
            debugStopTimeoutMs: 10000
        });
        const uid = 'headless-e2e';
        const call = (tool: string, args: Record<string, unknown> = {}) =>
            execute(tool, { uid, ...args });

        let result = await call('eide_debug_connect', { target, mode: 'extended-remote' });
        assert(result.isError !== true && parse(result).success === true, 'qemu: debug connect');

        result = await call('eide_debug_set_breakpoint', { location: 'main', hardware: true });
        assert(result.isError !== true && parse(result).functionName === 'main',
            'qemu: breakpoint at main');

        const stopped = parse(await call('eide_debug_continue', { stopTimeoutMs: 10000 }));
        assert(stopped.class === 'stopped' && stopped.results.reason === 'breakpoint-hit',
            'qemu: continue stops at breakpoint');

        const frames = parse(await call('eide_debug_backtrace', { maxDepth: 5 }));
        assert(Array.isArray(frames) && frames.some((frame: any) => frame.functionName === 'main'),
            'qemu: backtrace contains main');

        const variableResult = await call('eide_debug_list_variables', { frameLevel: 0 });
        assert(variableResult.isError !== true
            && Array.isArray(parse(variableResult).variables),
        'qemu: reads frame variables');

        const register = parse(await call('eide_debug_read_register', { name: 'pc' }));
        assert(typeof register.value === 'number' && register.value > 0,
            'qemu: reads a register');

        const faultResult = await call('eide_debug_fault', {
            hfsr: 0, cfsr: 0, mmar: 0, bfar: 0
        });
        const fault = parse(faultResult);
        assert(faultResult.isError !== true && Array.isArray(fault.reasons)
            && fault.reasons.length === 0,
            'qemu: fault decoder reports no active fault');

        result = await call('eide_debug_disconnect');
        assert(result.isError !== true && parse(result).success === true, 'qemu: debug disconnect');
        console.log('All QEMU GDB/MI session tests passed.');
    } finally {
        await stopProcess(qemuProcess);
        fs.rmSync(root, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
export {};
