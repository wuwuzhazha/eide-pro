const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const yaml = require('yaml');
const { createHeadlessToolExecutor } = require('../../../src/mcp/headless_tools') as any;

const QEMU_MACHINE = 'netduinoplus2';
const BREAKPOINT_LOCATION = 'main.c:7';
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
        throw new Error(message);
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

function normalizedLine(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : String(value);
}

function commandExists(command: string): boolean {
    if (NodePath.isAbsolute(command)) {
        return fs.existsSync(command);
    }
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

async function prepareQemuSession(options: {
    fixtureDir: string;
    main?: string;
}): Promise<{
    root: string;
    project: string;
    qemuProcess: any;
    target: string;
    call: (tool: string, args?: Record<string, unknown>) => Promise<any>;
}> {
    const repoRoot = process.cwd();
    const root = fs.mkdtempSync(NodePath.join(os.tmpdir(), 'eide-debug-qemu-'));
    const project = NodePath.join(root, 'project');
    const fixture = options.fixtureDir;
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
    if (options.main !== undefined) {
        write(mainSource, options.main);
    }
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
    const qemuArgs = ['-M', QEMU_MACHINE, '-kernel', elf, '-gdb', `tcp:${target}`, ...QEMU_ARGS];
    assert(qemuArgs.includes('-S'), 'qemu: target is halted until the debugger resumes it');
    console.log(`QEMU_ARGS=${JSON.stringify(qemuArgs)}`);
    const qemuProcess = spawn(qemu, qemuArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const projectConfig = yaml.parse(fs.readFileSync(NodePath.join(project, '.eide', 'eide.yml'), 'utf8'));
    const uid = String(projectConfig.miscInfo.uid);
    const call = (tool: string, args: Record<string, unknown> = {}) => execute(tool, { uid, ...args });
    return { root, project, qemuProcess, target, call };
}

async function run(): Promise<void> {
    let session = await prepareQemuSession({
        fixtureDir: NodePath.join(process.cwd(), 'test', 'e2e', 'fixtures', 'cortex-m3'),
        main: [
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
        ].join('\n')
    });
    const root = session.root;
    const project = session.project;
    let qemuProcess: any = session.qemuProcess;
    try {
        const call = session.call;

        let result = await call('eide_debug_connect', { target: session.target, mode: 'extended-remote' });
        assert(result.isError !== true && parse(result).success === true, 'qemu: debug connect');

        const haltedPc = await call('eide_debug_read_register', { name: 'pc' });
        const pcBefore = parse(haltedPc).value;
        console.log(`EVIDENCE pc-before=${JSON.stringify(pcBefore)}`);
        assert(haltedPc.isError !== true
            && typeof parse(haltedPc).value === 'number',
        'qemu: target is halted until the debugger resumes it');

        const breakpoint = parse(await call('eide_debug_set_breakpoint', {
            location: BREAKPOINT_LOCATION, hardware: false
        }));
        console.log(`EVIDENCE breakpoint=${JSON.stringify(breakpoint)}`);

        let continueResult = await call('eide_debug_continue', { stopTimeoutMs: 10000 });
        let stopped = parse(continueResult);
        console.log(`EVIDENCE continue=${JSON.stringify(stopped)}`);
        const breakpointAddress = typeof breakpoint.address === 'number'
            ? `0x${breakpoint.address.toString(16)}` : undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
            const attributed = stopped.stale === true;
            const repeatsHaltedPc = frameAddress(stopped.results?.frame) === pcBeforeAddress(pcBefore)
                && frameAddress(stopped.results?.frame) !== breakpointAddress;
            if (continueResult.isError === true || (!attributed && !repeatsHaltedPc)) {
                break;
            }
            console.log(`EVIDENCE resume-retry=${attributed ? 'stale-flag' : 'attribution-miss'}`);
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
        assert(normalizedLine(stopped.results?.frame?.line) === '7',
            'qemu: stop frame is at main.c:7');

        const frames = parse(await call('eide_debug_backtrace', { maxDepth: 5 }));
        assert(Array.isArray(frames?.items) && frames.items.some((frame: any) =>
            typeof frame.functionName === 'string' && frame.functionName.includes('main')),
        'qemu: backtrace contains main');

        const threadList = parse(await call('eide_debug_list_threads'));
        console.log(`EVIDENCE threads=${JSON.stringify(threadList)}`);
        assert(typeof threadList.currentThreadId === 'number',
            'qemu: reports the current thread id');

        result = await call('eide_debug_select_frame', { level: 0 });
        assert(result.isError !== true && parse(result).success === true,
            'qemu: selects frame 0 before reading variables');

        const variableResult = await call('eide_debug_list_variables', {
            threadId: threadList.currentThreadId, frameLevel: 0
        });
        const variables = variableResult.isError === true ? [] : parse(variableResult).variables;
        console.log(`EVIDENCE variables=${JSON.stringify(variableResult)}`);
        const localCounter = Array.isArray(variables)
            ? variables.find((variable: any) => variable?.name === 'local_counter') : undefined;
        assert(localCounter !== undefined
            && Number.isFinite(Number(localCounter.value)),
        `qemu: reads frame variables; variables=${JSON.stringify(variableResult).slice(0, 200)}`);

        const evaluateResult = await call('eide_debug_evaluate', { expression: 'counter' });
        const evaluated = evaluateResult.isError === true ? undefined : parse(evaluateResult);
        console.log(`EVIDENCE evaluate=${JSON.stringify(evaluateResult)}`);
        assert(evaluated !== undefined && Number.isFinite(Number(evaluated.value)),
            `qemu: evaluates global counter; evaluate=${JSON.stringify(evaluateResult).slice(0, 200)}`);

        const register = parse(await call('eide_debug_read_register', { name: 'pc' }));
        console.log(`EVIDENCE pc-after=${JSON.stringify(register.value)}`);
        assert(typeof register.value === 'number' && register.value > 0,
            'qemu: reads a register');

        const scbHfsr = parse(await call('eide_debug_read_memory', {
            address: '0xE000ED2C', length: 4
        }));
        const scbCfsr = parse(await call('eide_debug_read_memory', {
            address: '0xE000ED28', length: 4
        }));
        console.log(`EVIDENCE scb-hfsr=${JSON.stringify(scbHfsr.hex)}`
            + ` scb-cfsr=${JSON.stringify(scbCfsr.hex)}`);
        assert(typeof scbHfsr.hex === 'string' && scbHfsr.hex.length === 8,
            'qemu: reads the memory-mapped HFSR');
        assert(typeof scbCfsr.hex === 'string' && scbCfsr.hex.length === 8,
            'qemu: reads the memory-mapped CFSR');

        const liveFaultResult = await call('eide_debug_fault', {});
        const liveFault = parse(liveFaultResult);
        console.log(`EVIDENCE live-fault=${JSON.stringify(liveFaultResult)}`);
        assert(liveFaultResult.isError !== true && Array.isArray(liveFault.reasons),
            'qemu: fault decoder reads SCB memory from the active session');

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
        await stopProcess(qemuProcess);
        qemuProcess = undefined;
        fs.rmSync(root, { recursive: true, force: true });

        const demoRoot = NodePath.join(process.cwd(), 'examples', 'hardfault-demo');
        const demoMain = fs.readFileSync(NodePath.join(demoRoot, 'src', 'main.c'), 'utf8');
        const badCallLine = demoMain.split(/\r?\n/).findIndex((line: string) => line.trim() === 'sensor->on_event();') + 1;
        const pollCallLine = demoMain.split(/\r?\n/).findIndex((line: string) => line.trim() === 'poll(&sensors[i]);') + 1;
        assert(badCallLine > 0, 'qemu fault: demo source contains the null callback call');
        assert(pollCallLine > 0, 'qemu fault: demo source contains the poll call');
        session = await prepareQemuSession({ fixtureDir: demoRoot });
        try {
            const faultCall = session.call;
            const connectResult = await faultCall('eide_debug_connect', {
                target: session.target, mode: 'extended-remote'
            });
            assert(connectResult.isError !== true && parse(connectResult).success === true,
                'qemu fault: debug connect');
            const breakpoint = parse(await faultCall('eide_debug_set_breakpoint', {
                location: 'HardFault_Handler', hardware: false
            }));
            assert(typeof breakpoint.address === 'number', 'qemu fault: breakpoint at HardFault_Handler');
            const stoppedResult = await faultCall('eide_debug_continue', { stopTimeoutMs: 10000 });
            const stopped = parse(stoppedResult);
            assert(stoppedResult.isError !== true && stopped.class === 'stopped',
                'qemu fault: continue stops in HardFault_Handler');
            const faultResult = await faultCall('eide_debug_fault', {});
            const report = parse(faultResult);
            const codes = Array.isArray(report.reasons)
                ? report.reasons.map((reason: any) => reason.code) : [];
            console.log(`EVIDENCE fault-reasons=${JSON.stringify(report.reasons)}`);
            console.log(`EVIDENCE fault-exception=${JSON.stringify(report.exception)}`);
            assert(codes.includes('FORCED') && codes.includes('INVSTATE'),
                'qemu fault: reports FORCED and INVSTATE');
            assert(report.exception?.stack === 'MSP', 'qemu fault: fault frame uses MSP');
            assert(report.exception?.faultLocation?.address === 0
                && report.exception?.faultLocation?.file === undefined
                && report.exception?.faultLocation?.line === undefined,
            'qemu fault: fault location is address 0 without invented source');
            assert(report.exception?.callerLocation?.functionName === 'poll'
                && String(report.exception?.callerLocation?.file).endsWith('main.c'),
            'qemu fault: caller location is poll in main.c');
            assert(Number(report.exception?.callerLocation?.line) === badCallLine,
                'qemu fault: caller location is the null callback call line');

            const backtrace = report.exception?.backtrace;
            assert(backtrace?.from === 'callSite', 'qemu fault: backtrace starts at the call site');
            assert(backtrace?.frames?.[0]?.functionName === 'poll'
                && String(backtrace?.frames?.[0]?.file).endsWith('main.c')
                && Number(backtrace?.frames?.[0]?.line) === badCallLine,
            'qemu fault: backtrace frame 0 is the null callback call');
            assert(backtrace?.frames?.[1]?.functionName === 'main'
                && Number(backtrace?.frames?.[1]?.line) === pollCallLine,
            'qemu fault: backtrace frame 1 is the caller of poll');

            const restoredBacktrace = parse(await faultCall('eide_debug_backtrace'));
            assert(restoredBacktrace.items?.[0]?.functionName === 'HardFault_Handler',
                'qemu fault: registers are restored after diagnosis');
            const repeatFault = parse(await faultCall('eide_debug_fault', {}));
            assert(JSON.stringify(repeatFault.exception?.backtrace) === JSON.stringify(backtrace),
                'qemu fault: repeated diagnosis yields the same backtrace');
            await faultCall('eide_debug_disconnect');
            console.log('QEMU FAULT DIAGNOSIS RAN');
        } finally {
            await session.call('eide_debug_disconnect');
            await stopProcess(session.qemuProcess);
            fs.rmSync(session.root, { recursive: true, force: true });
        }
        console.log('All QEMU GDB/MI session tests passed.');
    } finally {
        if (qemuProcess !== undefined) {
            await session.call('eide_debug_disconnect');
        }
        await stopProcess(qemuProcess);
        fs.rmSync(root, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
export {};
