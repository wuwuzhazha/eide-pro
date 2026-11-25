const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const yaml = require('yaml');
const { createHeadlessToolExecutor } = require('../../../src/mcp/headless_tools') as any;

const QEMU_MACHINE = 'netduinoplus2';
const QEMU_ARGS = ['-S', '-nographic', '-monitor', 'none', '-serial', 'none'];

function skipped(reason: string): never {
    if (process.env.EIDE_REQUIRE_QEMU_DEBUG === '1') {
        console.error(`FAIL: required QEMU debug test cannot run: ${reason}`);
        process.exit(1);
    }
    console.log(`SKIPPED: ${reason}`);
    process.exit(0);
}

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

function frameHasMain(frame: unknown): boolean {
    return frame !== null && typeof frame === 'object'
        && typeof (frame as Record<string, unknown>).func === 'string'
        && String((frame as Record<string, unknown>).func).includes('main');
}

function frameAddress(frame: unknown): string | undefined {
    if (frame === null || typeof frame !== 'object') {
        return undefined;
    }
    const address = (frame as Record<string, unknown>).addr;
    return typeof address === 'string' ? address : undefined;
}

function pcBeforeAddress(value: unknown): string | undefined {
    return typeof value === 'number' ? `0x${value.toString(16)}` : undefined;
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
    const repoRoot = process.cwd();
    const root = fs.mkdtempSync(NodePath.join(os.tmpdir(), 'eide-debug-qemu-'));
    const project = NodePath.join(root, 'project');
    const fixture = NodePath.join(repoRoot, 'test', 'e2e', 'fixtures', 'cortex-m3');
    const mainSource = NodePath.join(project, 'src', 'main.c');
    const distCli = NodePath.join(repoRoot, 'dist', 'eide_cli.js');
    const resourcesDir = NodePath.join(repoRoot, 'res');
    if (!fs.existsSync(fixture)) {
        fs.rmSync(root, { recursive: true, force: true });
        console.error(`FAIL: QEMU fixture not found at ${fixture}`);
        process.exit(1);
    }
    fs.cpSync(fixture, project, { recursive: true });
    if (!fs.existsSync(mainSource)) {
        fs.rmSync(root, { recursive: true, force: true });
        console.error(`FAIL: QEMU breakpoint source not found at ${mainSource}`);
        process.exit(1);
    }
    write(mainSource, [
        'volatile unsigned int counter;',
        '',
        'int main(void)',
        '{',
        '    volatile int local_counter = 7;',
        '    for (;;) {',
        '        local_counter++;',
        '        counter++;',
        '    }',
        '}',
        ''
    ].join('\n'));
    console.log(`OK: QEMU fixture prepared from ${fixture}`);

    const qemu = process.env.QEMU_SYSTEM_ARM || 'qemu-system-arm';
    const gdb = process.env.ARM_GDB || 'arm-none-eabi-gdb';
    if (!commandExists(qemu)) {
        fs.rmSync(root, { recursive: true, force: true });
        skipped(`${qemu} not found; install QEMU to run the real GDB/MI session.`);
    }
    if (!commandExists(gdb)) {
        fs.rmSync(root, { recursive: true, force: true });
        skipped(`${gdb} not found; install ARM GDB to run the real GDB/MI session.`);
    }

    const toolchainRoot = process.env.ARM_GCC_ROOT || '/usr';
    const gcc = NodePath.join(toolchainRoot, 'bin', process.platform === 'win32'
        ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc');
    if (!fs.existsSync(gcc)) {
        fs.rmSync(root, { recursive: true, force: true });
        skipped(`ARM GCC not found at ${gcc}.`);
    }

    let qemuProcess: any;
    try {
        const build = spawnSync(process.execPath, [
            distCli,
            'build', '--project', project, '--toolchain-path', toolchainRoot,
            '--timeout', '120000'
        ], { encoding: 'utf8' });
        assert(build.status === 0, `qemu fixture builds\n${build.stderr}`);
        const buildResult = JSON.parse(build.stdout);
        const elf = (buildResult.artifacts || []).find((file: string) => file.endsWith('.elf'));
        assert(typeof elf === 'string' && fs.existsSync(elf), 'qemu fixture produces an ELF');

        const port = await freePort();
        const target = `127.0.0.1:${port}`;
        const qemuArgs = [
            '-M', QEMU_MACHINE,
            '-kernel', elf,
            '-gdb', `tcp:${target}`,
            ...QEMU_ARGS
        ];
        assert(qemuArgs.includes('-S'), 'qemu: target is halted until the debugger resumes it');
        console.log(`QEMU_ARGS=${JSON.stringify(qemuArgs)}`);
        qemuProcess = spawn(qemu, qemuArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        qemuProcess.stderr.resume();
        await waitForPort(port, 5000);

        const execute = createHeadlessToolExecutor({
            projectPaths: [project],
            resourcesDir,
            extensionRoot: repoRoot,
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

        const haltedPc = await call('eide_debug_read_register', { name: 'pc' });
        const pcBefore = parse(haltedPc).value;
        console.log(`EVIDENCE pc-before=${JSON.stringify(pcBefore)}`);
        assert(haltedPc.isError !== true
            && typeof parse(haltedPc).value === 'number',
        'qemu: target is halted until the debugger resumes it');

        const breakpoint = parse(await call('eide_debug_set_breakpoint', {
            location: 'main', hardware: false
        }));
        console.log(`EVIDENCE breakpoint=${JSON.stringify(breakpoint)}`);

        let continueResult = await call('eide_debug_continue', { stopTimeoutMs: 10000 });
        let stopped = parse(continueResult);
        console.log(`EVIDENCE continue=${JSON.stringify(stopped)}`);
        const stopFrame = stopped.results?.frame;
        const breakpointAddress = typeof breakpoint.address === 'number'
            ? `0x${breakpoint.address.toString(16)}` : undefined;
        if (continueResult.isError !== true
            && frameAddress(stopFrame) === pcBeforeAddress(pcBefore)
            && frameAddress(stopFrame) !== breakpointAddress) {
            console.log('EVIDENCE resume-retry=1');
            continueResult = await call('eide_debug_continue', { stopTimeoutMs: 10000 });
            stopped = parse(continueResult);
            console.log(`EVIDENCE continue-after-retry=${JSON.stringify(stopped)}`);
        }
        const hit = continueResult.isError !== true
            && stopped.class === 'stopped'
            && ((breakpointAddress !== undefined
                && frameAddress(stopped.results?.frame) === breakpointAddress)
                || frameHasMain(stopped.results?.frame));
        console.log(`EVIDENCE stop-frame=${JSON.stringify(stopped.results?.frame)}`);
        console.log(`EVIDENCE hit=${hit}`);
        assert(hit, 'qemu: continue stops at breakpoint');

        const frames = parse(await call('eide_debug_backtrace', { maxDepth: 5 }));
        assert(Array.isArray(frames) && frames.some((frame: any) =>
            typeof frame.functionName === 'string' && frame.functionName.includes('main')),
        'qemu: backtrace contains main');

        const variableResult = await call('eide_debug_list_variables', { frameLevel: 0 });
        const variables = variableResult.isError === true ? [] : parse(variableResult).variables;
        const localCounter = Array.isArray(variables)
            ? variables.find((variable: any) => variable?.name === 'local_counter') : undefined;
        assert(localCounter !== undefined
            && Number.isFinite(Number(localCounter.value)),
        'qemu: reads frame variables');

        const evaluateResult = await call('eide_debug_evaluate', { expression: 'counter' });
        const evaluated = evaluateResult.isError === true ? undefined : parse(evaluateResult);
        assert(evaluated !== undefined && Number.isFinite(Number(evaluated.value)),
            'qemu: evaluates global counter');

        const register = parse(await call('eide_debug_read_register', { name: 'pc' }));
        console.log(`EVIDENCE pc-after=${JSON.stringify(register.value)}`);
        assert(typeof register.value === 'number' && register.value > 0,
            'qemu: reads a register');

        const faultResult = await call('eide_debug_fault', {
            hfsr: 0, cfsr: 0, mmar: 0, bfar: 0
        });
        const fault = parse(faultResult);
        assert(faultResult.isError !== true && Array.isArray(fault.reasons)
            && fault.reasons.length === 0,
            'qemu: fault decoder reports no active fault');
        assert(fault.memManageAddressValid === false && fault.busFaultAddressValid === false,
            'qemu: fault decoder reports no valid fault addresses');

        result = await call('eide_debug_disconnect');
        assert(result.isError !== true && parse(result).success === true, 'qemu: debug disconnect');
        console.log('QEMU DEBUG SESSION RAN');
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
