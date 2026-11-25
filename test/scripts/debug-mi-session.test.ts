import {
    MiChildProcess,
    MiError,
    MiSession,
    MiSessionOptions,
    MiSpawn,
    MiStopEvent,
} from '../../src/core/debug/mi';

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
    console.log('OK:', message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
    assert(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function assertWritten(fake: FakeGdb, expected: string[], message: string): void {
    assertEqual(fake.written.join(''), expected.join(''), message);
}

async function captureReject(promise: Promise<unknown>, message: string): Promise<MiError> {
    try {
        await promise;
    } catch (error) {
        assert(error instanceof MiError, `${message}: rejection is MiError`);
        return error as MiError;
    }
    throw new Error(`${message}: expected rejection`);
}

class FakeGdb implements MiChildProcess {
    readonly written: string[] = [];
    killCount = 0;
    onCommand?: (line: string) => void;

    private exited = false;
    private readonly stdoutListeners: Array<(chunk: string) => void> = [];
    private readonly stderrListeners: Array<(chunk: string) => void> = [];
    private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
    private readonly errorListeners: Array<(error: Error) => void> = [];

    write(data: string): void {
        if (this.exited) {
            throw new Error('GDB stdin is closed');
        }
        this.written.push(data);
        this.onCommand?.(data);
    }

    onStdout(listener: (chunk: string) => void): void {
        this.stdoutListeners.push(listener);
    }

    onStderr(listener: (chunk: string) => void): void {
        this.stderrListeners.push(listener);
    }

    onExit(listener: (code: number | null, signal: string | null) => void): void {
        this.exitListeners.push(listener);
    }

    onError(listener: (error: Error) => void): void {
        this.errorListeners.push(listener);
    }

    kill(): void {
        this.killCount++;
        queueMicrotask(() => this.emitExit(null, 'SIGKILL'));
    }

    emitStdout(chunk: string): void {
        for (const listener of this.stdoutListeners) {
            listener(chunk);
        }
    }

    emitStderr(chunk: string): void {
        for (const listener of this.stderrListeners) {
            listener(chunk);
        }
    }

    emitExit(code: number | null, signal: string | null = null): void {
        if (this.exited) {
            return;
        }
        this.exited = true;
        for (const listener of this.exitListeners) {
            listener(code, signal);
        }
    }

    emitError(error: Error): void {
        for (const listener of this.errorListeners) {
            listener(error);
        }
    }
}

type Responder = (command: string, token: number, fake: FakeGdb) => string | string[] | undefined;

function standardResponse(command: string, token: number): string | undefined {
    switch (command) {
        case '-gdb-set mi-async on':
        case '-gdb-set confirm off':
            return `${token}^done\n(gdb) \n`;
        case '-target-disconnect':
            return `${token}^done\n(gdb) \n`;
        case '-gdb-exit':
            return `${token}^exit\n`;
        default:
            return command.startsWith('-target-select ')
                ? `${token}^connected\n(gdb) \n`
                : undefined;
    }
}

function createHarness(
    responder: Responder,
    options: Partial<MiSessionOptions> = {},
    startupPrompt = true,
): { fake: FakeGdb; session: MiSession } {
    const fake = new FakeGdb();
    const spawn: MiSpawn = () => {
        if (startupPrompt) {
            queueMicrotask(() => fake.emitStdout('=thread-group-added,id="i1"\n(gdb) \n'));
        }
        return fake;
    };
    const session = new MiSession({
        commandTimeoutMs: 200,
        stopTimeoutMs: 200,
        spawn,
        ...options,
    });
    fake.onCommand = line => {
        const match = /^(\d+)(.*)\n$/.exec(line);
        if (match === null) {
            throw new Error(`unexpected GDB input: ${line}`);
        }
        const response = responder(match[2], Number(match[1]), fake);
        if (response !== undefined) {
            const chunks = Array.isArray(response) ? response : [response];
            queueMicrotask(() => {
                for (const chunk of chunks) {
                    fake.emitStdout(chunk);
                }
                if (match[2] === '-gdb-exit') {
                    setImmediate(() => fake.emitExit(0));
                }
            });
        }
    };
    return { fake, session };
}

async function testConnectAndDisconnect(): Promise<void> {
    const { fake, session } = createHarness(standardResponse);
    await session.connect('localhost:3333');
    assertWritten(
        fake,
        [
            '1-gdb-set mi-async on\n',
            '2-gdb-set confirm off\n',
            '3-target-select extended-remote localhost:3333\n',
        ],
        'extended-remote connect command sequence',
    );
    await session.disconnect();
    assertWritten(
        fake,
        [
            '1-gdb-set mi-async on\n',
            '2-gdb-set confirm off\n',
            '3-target-select extended-remote localhost:3333\n',
            '4-target-disconnect\n',
            '5-gdb-exit\n',
        ],
        'disconnect command sequence',
    );
    await session.disconnect();
    assertEqual(fake.written.length, 5, 'second disconnect is a no-op');

    const remote = createHarness(standardResponse);
    await remote.session.connect('localhost:3334', 'remote');
    assertEqual(
        remote.fake.written[2],
        '3-target-select remote localhost:3334\n',
        'remote mode command',
    );
    await remote.session.disconnect();
}

async function testConnectErrors(): Promise<void> {
    const targetError = createHarness((command, token) => {
        if (command.startsWith('-target-select ')) {
            return `${token}^error,msg="localhost:1: Connection timed out."\n`;
        }
        return standardResponse(command, token);
    });
    const targetFailure = await captureReject(
        targetError.session.connect('localhost:1'),
        'target connect failure',
    );
    assertEqual(targetFailure.code, 'target', 'target connect error code');
    assert(targetFailure.message.includes('Connection timed out'), 'target connect error message');
    assertEqual(targetError.fake.killCount, 1, 'failed connect kills GDB');

    const started = Date.now();
    const promptError = createHarness(() => undefined, { commandTimeoutMs: 30 }, false);
    const promptFailure = await captureReject(
        promptError.session.connect('localhost:1'),
        'startup prompt timeout',
    );
    assertEqual(promptFailure.code, 'timeout', 'startup prompt timeout code');
    assert(Date.now() - started < 1000, 'startup prompt timeout is bounded');
    assertEqual(promptError.fake.killCount, 1, 'startup timeout kills GDB');

    const stderrHarness = createHarness(() => undefined, { commandTimeoutMs: 30 }, false);
    const stderrConnect = stderrHarness.session.connect('localhost:1');
    stderrHarness.fake.emitStderr('cannot open device');
    const stderrFailure = await captureReject(stderrConnect, 'startup prompt timeout with stderr');
    assert(stderrFailure.message.includes('cannot open device'), 'startup timeout includes stderr');
}

async function testRegisterAndMemory(): Promise<void> {
    const register = createHarness((command, token) => {
        if (command.startsWith('-data-evaluate-expression ')) {
            return `${token}^done,value="0xE000ED28 <SCB+0>"\n`;
        }
        return standardResponse(command, token);
    });
    await register.session.connect('localhost:3333');
    const cfsr = await register.session.readRegister('cfsr');
    assertEqual(cfsr, 0xE000ED28, 'register value');
    assertEqual(
        register.fake.written[3],
        '4-data-evaluate-expression "$cfsr"\n',
        'register read command',
    );
    await register.session.disconnect();

    const voidRegister = createHarness((command, token) => {
        if (command.startsWith('-data-evaluate-expression ')) {
            return `${token}^done,value="void"\n`;
        }
        return standardResponse(command, token);
    });
    await voidRegister.session.connect('localhost:3333');
    const voidFailure = await captureReject(
        voidRegister.session.readRegister('missing'),
        'non-numeric register',
    );
    assertEqual(voidFailure.code, 'target', 'non-numeric register code');
    await voidRegister.session.disconnect();

    const memory = createHarness((command, token) => {
        if (command.startsWith('-data-read-memory-bytes ')) {
            return `${token}^done,memory=[{begin="0x20000000",offset="0x0",end="0x20000004",contents="DEADBEEF"}]\n`;
        }
        if (command.startsWith('-data-write-memory-bytes ')) {
            return `${token}^done\n`;
        }
        return standardResponse(command, token);
    });
    await memory.session.connect('localhost:3333');
    const bytes = await memory.session.readMemory(0x20000000, 4);
    assertEqual(bytes.toString('hex'), 'deadbeef', 'read memory bytes');
    assertEqual(
        memory.fake.written[3],
        '4-data-read-memory-bytes 0x20000000 4\n',
        'read memory command',
    );
    await memory.session.writeMemory(0x20000000, Buffer.from([1, 2, 3, 4]));
    assertEqual(
        memory.fake.written[4],
        '5-data-write-memory-bytes 0x20000000 01020304\n',
        'write memory command',
    );
    await memory.session.disconnect();

    const gap = createHarness((command, token) => {
        if (command.startsWith('-data-read-memory-bytes ')) {
            return `${token}^done,memory=[{begin="0x20000000",offset="0x0",end="0x20000002",contents="0102"},{begin="0x20000004",offset="0x4",end="0x20000006",contents="0304"}]\n`;
        }
        return standardResponse(command, token);
    });
    await gap.session.connect('localhost:3333');
    const gapFailure = await captureReject(gap.session.readMemory(0x20000000, 6), 'memory gap');
    assertEqual(gapFailure.code, 'target', 'memory gap code');
    await gap.session.disconnect();
}

async function testBreakpointsAndEvaluation(): Promise<void> {
    const harness = createHarness((command, token) => {
        if (command.startsWith('-break-insert ')) {
            return `${token}^done,bkpt={number="7",type="breakpoint",addr="0x08000100",func="tick",file="main.c",line="42"}\n`;
        }
        if (command === '-break-delete 7') {
            return `${token}^done\n`;
        }
        if (command.startsWith('-data-evaluate-expression ')) {
            return `${token}^done,value="9"\n`;
        }
        return standardResponse(command, token);
    });
    await harness.session.connect('localhost:3333');
    const breakpoint = await harness.session.insertBreakpoint('tick', {
        hardware: true,
        condition: 'x > 1',
    });
    assertEqual(
        harness.fake.written[3],
        '4-break-insert -h -c "x > 1" "tick"\n',
        'breakpoint insert command',
    );
    assertEqual(breakpoint.id, 7, 'breakpoint id');
    assertEqual(breakpoint.address, 0x08000100, 'breakpoint address');
    assertEqual(breakpoint.functionName, 'tick', 'breakpoint function');
    assertEqual(breakpoint.file, 'main.c', 'breakpoint file');
    assertEqual(breakpoint.line, 42, 'breakpoint line');
    await harness.session.removeBreakpoint(7);
    assertEqual(harness.fake.written[4], '5-break-delete 7\n', 'breakpoint delete command');
    const value = await harness.session.evaluate('sizeof(int) + 5');
    assertEqual(value, '9', 'evaluate value');
    assertEqual(
        harness.fake.written[5],
        '6-data-evaluate-expression "sizeof(int) + 5"\n',
        'evaluate command',
    );
    await harness.session.disconnect();
}

async function testThreadsFramesAndVariables(): Promise<void> {
    const harness = createHarness((command, token) => {
        if (command === '-thread-info') {
            return `${token}^done,threads=[{id="1",target-id="Thread 1",name="main",state="stopped",frame={level="0",addr="0x08000100",func="main",file="main.c",line="10"}},{id="2",target-id="Thread 2",name="worker",state="stopped",frame={level="0",addr="0x08000200",func="worker"}}],current-thread-id="1"\n`;
        }
        if (command === '-thread-select 2') {
            return `${token}^done,new-thread-id="2",frame={level="0",addr="0x08000200",func="worker",file="worker.c",line="20"}\n`;
        }
        if (command === '-stack-select-frame 1') {
            return `${token}^done\n`;
        }
        if (command.startsWith('-stack-list-variables ')) {
            return `${token}^done,variables=[{name="argc",value="2"},{name="argv",value="0x20001000"},{name="optimized",value="<optimized out>"}]\n`;
        }
        return standardResponse(command, token);
    });
    await harness.session.connect('localhost:3333');

    const threads = await harness.session.listThreads();
    assertEqual(harness.fake.written[3], '4-thread-info\n', 'thread info command');
    assertEqual(threads.threads.length, 2, 'thread count');
    assertEqual(threads.currentThreadId, 1, 'current thread id');
    assertEqual(threads.threads[0].id, 1, 'first thread id');
    assertEqual(threads.threads[0].targetId, 'Thread 1', 'first thread target id');
    assertEqual(threads.threads[0].name, 'main', 'first thread name');
    assertEqual(threads.threads[0].state, 'stopped', 'first thread state');
    assertEqual(threads.threads[0].frame?.functionName, 'main', 'first thread frame');
    assertEqual(threads.threads[1].frame?.functionName, 'worker', 'second thread frame');

    const selected = await harness.session.selectThread(2);
    assertEqual(harness.fake.written[4], '5-thread-select 2\n', 'thread select command');
    assertEqual(selected?.functionName, 'worker', 'selected thread frame');
    assertEqual(selected?.line, 20, 'selected thread frame line');

    await harness.session.selectFrame(1);
    assertEqual(harness.fake.written[5], '6-stack-select-frame 1\n', 'frame select command');

    const variables = await harness.session.listVariables();
    assertEqual(
        harness.fake.written[6],
        '7-stack-list-variables 1\n',
        'variable list command',
    );
    assertEqual(variables.length, 3, 'variable count');
    assertEqual(variables[0].name, 'argc', 'variable name');
    assertEqual(variables[0].value, '2', 'variable value');
    assertEqual(variables[2].value, '<optimized out>', 'optimized out value');

    const scoped = await harness.session.listVariables({ threadId: 2, frameLevel: 1 });
    assertEqual(
        harness.fake.written[7],
        '8-stack-list-variables --thread 2 --frame 1 1\n',
        'scoped variable list command',
    );
    assertEqual(scoped.length, 3, 'scoped variable count');

    const frameOnly = await captureReject(
        harness.session.listVariables({ frameLevel: 0 }),
        'frame level without a thread id',
    );
    assertEqual(frameOnly.code, 'state', 'frame level without a thread id code');
    assertEqual(harness.fake.written.length, 8, 'frame level without a thread id sends no command');

    const threadOnly = await harness.session.listVariables({ threadId: 2 });
    assertEqual(
        harness.fake.written[8],
        '9-stack-list-variables --thread 2 1\n',
        'thread-only variable list command',
    );
    assertEqual(threadOnly.length, 3, 'thread-only variable count');
    await harness.session.disconnect();

    const malformedThreads = createHarness((command, token) => {
        if (command === '-thread-info') {
            return `${token}^done,threads=[{id="0"}]\n`;
        }
        return standardResponse(command, token);
    });
    await malformedThreads.session.connect('localhost:3333');
    const threadFailure = await captureReject(
        malformedThreads.session.listThreads(),
        'invalid thread id',
    );
    assertEqual(threadFailure.code, 'protocol', 'invalid thread id code');
    await malformedThreads.session.disconnect();

    const missingThreads = createHarness((command, token) => {
        if (command === '-thread-info') {
            return `${token}^done\n`;
        }
        return standardResponse(command, token);
    });
    await missingThreads.session.connect('localhost:3333');
    const missingThreadFailure = await captureReject(
        missingThreads.session.listThreads(),
        'missing thread list',
    );
    assertEqual(missingThreadFailure.code, 'protocol', 'missing thread list code');
    await missingThreads.session.disconnect();

    const malformedVariables = createHarness((command, token) => {
        if (command.startsWith('-stack-list-variables ')) {
            return `${token}^done,variables=[{value="1"}]\n`;
        }
        return standardResponse(command, token);
    });
    await malformedVariables.session.connect('localhost:3333');
    const variableFailure = await captureReject(
        malformedVariables.session.listVariables(),
        'variable without name',
    );
    assertEqual(variableFailure.code, 'protocol', 'variable without name code');
    await malformedVariables.session.disconnect();

    await captureReject(harness.session.selectThread(0), 'thread id validation');
    await captureReject(harness.session.selectFrame(-1), 'frame level validation');
    await captureReject(
        harness.session.listVariables({ threadId: 0 }),
        'variable thread id validation',
    );
    await captureReject(
        harness.session.listVariables({ frameLevel: -1 }),
        'variable frame level validation',
    );
}

async function testStepping(): Promise<void> {
    const harness = createHarness((command, token) => {
        if (command === '-exec-next') {
            return `${token}^running\n*stopped,reason="end-stepping-range",frame={level="0",addr="0x08000104",func="main",line="11"},thread-id="1"\n`;
        }
        if (command === '-exec-step') {
            return `${token}^running\n*stopped,reason="end-stepping-range",frame={level="0",addr="0x08000200",func="tick",line="20"},thread-id="1"\n`;
        }
        if (command === '-exec-finish') {
            return `${token}^running\n*stopped,reason="function-finished",frame={level="0",addr="0x08000108",func="main",line="12"},thread-id="1"\n`;
        }
        return standardResponse(command, token);
    });
    await harness.session.connect('localhost:3333');

    await harness.session.stepOver();
    const over = await harness.session.waitForStop(100);
    assertEqual(harness.fake.written[3], '4-exec-next\n', 'step over command');
    assertEqual(over.results.reason, 'end-stepping-range', 'step over stop reason');

    await harness.session.stepInto();
    const into = await harness.session.waitForStop(100);
    assertEqual(harness.fake.written[4], '5-exec-step\n', 'step into command');
    assertEqual(into.results.reason, 'end-stepping-range', 'step into stop reason');

    await harness.session.stepOut();
    const out = await harness.session.waitForStop(100);
    assertEqual(harness.fake.written[5], '6-exec-finish\n', 'step out command');
    assertEqual(out.results.reason, 'function-finished', 'step out stop reason');
    await harness.session.disconnect();
}

async function testStopsAndInterrupt(): Promise<void> {
    const harness = createHarness((command, token) => {
        if (command === '-exec-continue') {
            return `${token}^running\n*running,thread-id="all"\n*stopped,reason="breakpoint-hit",bkptno="1",frame={addr="0x08000100",func="main",line="42"},thread-id="1"\n`;
        }
        if (command === '-exec-interrupt') {
            return `${token}^done\n*stopped,reason="signal-received",signal-name="SIGINT",thread-id="1"\n`;
        }
        return standardResponse(command, token);
    });
    await harness.session.connect('localhost:3333');
    await harness.session.continue();
    const breakpointStop: MiStopEvent = await harness.session.waitForStop(100);
    assertEqual(breakpointStop.class, 'stopped', 'stop class');
    assertEqual(breakpointStop.results.reason, 'breakpoint-hit', 'stop reason');
    const frame = breakpointStop.results.frame;
    assert(frame !== null && typeof frame === 'object' && !Array.isArray(frame), 'stop frame');
    assertEqual((frame as { func: string }).func, 'main', 'stop frame function');

    await harness.session.interrupt();
    const interruptStop = await harness.session.waitForStop(100);
    assertEqual(interruptStop.results.reason, 'signal-received', 'interrupt stop reason');
    assertEqual(interruptStop.results['signal-name'], 'SIGINT', 'interrupt signal name');
    await harness.session.disconnect();

    const noStop = createHarness((command, token) => {
        if (command === '-exec-continue') {
            return `${token}^running\n`;
        }
        return standardResponse(command, token);
    });
    await noStop.session.connect('localhost:3333');
    await noStop.session.continue();
    const started = Date.now();
    const stopTimeout = await captureReject(noStop.session.waitForStop(30), 'waitForStop timeout');
    assertEqual(stopTimeout.code, 'timeout', 'waitForStop timeout code');
    assert(Date.now() - started < 1000, 'waitForStop timeout is bounded');
    await noStop.session.disconnect();

    const exitWhileWaiting = createHarness((command, token, fake) => {
        if (command === '-exec-continue') {
            setTimeout(() => fake.emitExit(1), 10);
            return `${token}^running\n`;
        }
        return standardResponse(command, token);
    });
    await exitWhileWaiting.session.connect('localhost:3333');
    await exitWhileWaiting.session.continue();
    const exitWaitFailure = await captureReject(
        exitWhileWaiting.session.waitForStop(1000),
        'process exit while waiting for stop',
    );
    assertEqual(exitWaitFailure.code, 'exited', 'process exit rejects stop wait');
}

async function testContinueIgnoresStaleStop(): Promise<void> {
    const harness = createHarness((command, token) => {
        if (command === '-exec-continue') {
            return `${token}^running\n*running,thread-id="all"\n`;
        }
        return standardResponse(command, token);
    });
    await harness.session.connect('localhost:3333');
    harness.fake.emitStdout('*stopped,reason="stale",frame={level="0",addr="0x08000018",func="Reset_Handler"},thread-id="1"\n');
    await harness.session.continue();
    harness.fake.emitStdout('*stopped,reason="breakpoint-hit",frame={level="0",addr="0x08000008",func="main",line="6"},thread-id="1"\n');
    const stop = await harness.session.waitForStop(100);
    assertEqual(stop.results.reason, 'breakpoint-hit', 'continue ignores stale stop');
    const frame = stop.results.frame;
    assert(frame !== null && typeof frame === 'object' && !Array.isArray(frame), 'fresh stop frame');
    assertEqual((frame as { func: string }).func, 'main', 'fresh stop frame function');
    await harness.session.disconnect();
}

async function testInterruptIgnoresStaleStop(): Promise<void> {
    const harness = createHarness((command, token) => {
        if (command === '-exec-continue') {
            return `${token}^running\n`;
        }
        if (command === '-exec-interrupt') {
            return `${token}^done\n*stopped,reason="signal-received",signal-name="SIGINT",frame={level="0",addr="0x08000020",func="main"},thread-id="1"\n`;
        }
        return standardResponse(command, token);
    });
    await harness.session.connect('localhost:3333');
    await harness.session.continue();
    harness.fake.emitStdout('*stopped,reason="breakpoint-hit",frame={level="0",addr="0x08000010",func="main"},thread-id="1"\n');
    await harness.session.interrupt();
    const stop = await harness.session.waitForStop(100);
    assertEqual(stop.results.reason, 'signal-received', 'interrupt ignores a stop queued before it');
    assertEqual(stop.results['signal-name'], 'SIGINT', 'interrupt returns its own stop');
    await harness.session.disconnect();
}

async function testResumeAttribution(): Promise<void> {
    const harness = createHarness((command, token) => {
        if (command === '-exec-continue') {
            return `${token}^running\n`;
        }
        return standardResponse(command, token);
    });
    await harness.session.connect('localhost:3333');
    harness.fake.emitStdout('*stopped,reason="signal-received",signal-name="SIGTRAP",frame={level="0",addr="0x08000008",func="main"},thread-id="1"\n');
    await harness.session.continue();
    harness.fake.emitStdout('*stopped,reason="signal-received",signal-name="SIGTRAP",frame={level="0",addr="0x08000008",func="main"},thread-id="1"\n');
    const repeatedHalt = await harness.session.waitForStop(100);
    assertEqual(repeatedHalt.stale, true, 'a repeated halt after resume is flagged stale');
    assertEqual(repeatedHalt.results.reason, 'signal-received', 'stale stop keeps its MI payload');

    harness.fake.emitStdout('*stopped,reason="signal-received",signal-name="SIGTRAP",frame={level="0",addr="0x08000008",func="main"},thread-id="1"\n');
    const secondOfRun = await harness.session.waitForStop(100);
    assertEqual(secondOfRun.stale, undefined, 'only the first stop after a resume is classified');

    await harness.session.continue();
    harness.fake.emitStdout('*stopped,reason="breakpoint-hit",bkptno="1",frame={level="0",addr="0x08000008",func="main"},thread-id="1"\n');
    const breakpointAtResume = await harness.session.waitForStop(100);
    assertEqual(breakpointAtResume.stale, undefined, 'a breakpoint hit at the resume PC is not stale');

    await harness.session.continue();
    harness.fake.emitStdout('*stopped,reason="signal-received",frame={level="0",addr="0x08000020",func="main"},thread-id="1"\n');
    const moved = await harness.session.waitForStop(100);
    assertEqual(moved.stale, undefined, 'a stop at a different PC is not stale');

    await harness.session.continue();
    harness.fake.emitStdout('*stopped,reason="signal-received",frame={level="0",addr="0x08000020",func="worker"},thread-id="2"\n');
    const otherThread = await harness.session.waitForStop(100);
    assertEqual(otherThread.stale, undefined, 'a stop on another thread is not stale');
    await harness.session.disconnect();

    const fresh = createHarness((command, token) => {
        if (command === '-exec-continue') {
            return `${token}^running\n`;
        }
        return standardResponse(command, token);
    });
    await fresh.session.connect('localhost:3333');
    await fresh.session.continue();
    fresh.fake.emitStdout('*stopped,reason="signal-received",frame={level="0",addr="0x08000008"},thread-id="1"\n');
    const noHistory = await fresh.session.waitForStop(100);
    assertEqual(noHistory.stale, undefined, 'the first stop of a session is not stale');
    await fresh.session.disconnect();
}

async function testCommandFailureModes(): Promise<void> {
    const exitDuringCommand = createHarness((command, token, fake) => {
        if (command.startsWith('-data-evaluate-expression ')) {
            fake.emitExit(3);
            return undefined;
        }
        return standardResponse(command, token);
    });
    await exitDuringCommand.session.connect('localhost:3333');
    const exitFailure = await captureReject(
        exitDuringCommand.session.evaluate('1'),
        'process exit during command',
    );
    assertEqual(exitFailure.code, 'exited', 'process exit error code');

    let evaluations = 0;
    const timeoutRecovery = createHarness((command, token, fake) => {
        if (command.startsWith('-data-evaluate-expression ')) {
            evaluations++;
            if (evaluations === 1) {
                setTimeout(() => fake.emitStdout(`${token}^done,value="late"\n`), 80);
                return undefined;
            }
            return `${token}^done,value="2"\n`;
        }
        return standardResponse(command, token);
    }, { commandTimeoutMs: 30 });
    await timeoutRecovery.session.connect('localhost:3333');
    const timeoutFailure = await captureReject(
        timeoutRecovery.session.evaluate('first'),
        'command timeout',
    );
    assertEqual(timeoutFailure.code, 'timeout', 'command timeout code');
    const recovered = await timeoutRecovery.session.evaluate('second');
    assertEqual(recovered, '2', 'command after timeout succeeds');
    await timeoutRecovery.session.disconnect();

    const protocolHarness = createHarness((command, token) => {
        if (command.startsWith('-data-evaluate-expression ')) {
            return 'garbage\n';
        }
        return standardResponse(command, token);
    });
    await protocolHarness.session.connect('localhost:3333');
    const protocolFailure = await captureReject(
        protocolHarness.session.evaluate('1'),
        'protocol failure',
    );
    assertEqual(protocolFailure.code, 'protocol', 'protocol failure code');
    assertEqual(protocolHarness.fake.killCount, 1, 'protocol failure kills GDB');

    const stderrHarness = createHarness((command, token, fake) => {
        if (command.startsWith('-data-evaluate-expression ')) {
            fake.emitStderr('target not responding');
            return undefined;
        }
        return standardResponse(command, token);
    }, { commandTimeoutMs: 30 });
    await stderrHarness.session.connect('localhost:3333');
    const stderrFailure = await captureReject(
        stderrHarness.session.evaluate('1'),
        'command timeout with stderr',
    );
    assert(stderrFailure.message.includes('target not responding'), 'command timeout includes stderr');
}

async function testBacktraceAndBreakpointList(): Promise<void> {
    const harness = createHarness((command, token) => {
        if (command === '-stack-list-frames') {
            return `${token}^done,stack=[frame={level="0",addr="0x08000100",func="main",file="main.c",fullname="C:\\\\fw\\\\main.c",line="10"},frame={level="1",addr="0x08000200"}]\n`;
        }
        if (command === '-break-list') {
            return `${token}^done,BreakpointTable={nr_rows="2",nr_cols="6",hdr=[],body=[bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x08000100",func="main",file="main.c",fullname="C:\\\\fw\\\\main.c",line="10",cond="x > 0",times="3",original-location="main"},bkpt={number="2",type="breakpoint",disp="keep",enabled="n",addr="<PENDING>",pending="later",times="0",original-location="later"}]}\n`;
        }
        return standardResponse(command, token);
    });
    await harness.session.connect('localhost:3333');
    const frames = await harness.session.backtrace();
    assertEqual(harness.fake.written[3], '4-stack-list-frames\n', 'backtrace command');
    assertEqual(frames.length, 2, 'backtrace frame count');
    assertEqual(frames[0].level, 0, 'backtrace first level');
    assertEqual(frames[0].address, 0x08000100, 'backtrace first address');
    assertEqual(frames[0].functionName, 'main', 'backtrace first function');
    assertEqual(frames[0].file, 'main.c', 'backtrace first file');
    assertEqual(frames[0].line, 10, 'backtrace first line');
    assertEqual(frames[0].fullName, 'C:\\fw\\main.c', 'backtrace first full name');
    assertEqual(frames[1].level, 1, 'backtrace second level');
    assert(frames[1].functionName === undefined, 'backtrace absent function stays undefined');

    const breakpoints = await harness.session.listBreakpoints();
    assertEqual(harness.fake.written[4], '5-break-list\n', 'breakpoint list command');
    assertEqual(breakpoints.length, 2, 'breakpoint list count');
    assertEqual(breakpoints[0].id, 1, 'breakpoint list id');
    assertEqual(breakpoints[0].type, 'breakpoint', 'breakpoint list type');
    assertEqual(breakpoints[0].enabled, true, 'breakpoint list enabled');
    assertEqual(breakpoints[0].address, 0x08000100, 'breakpoint list address');
    assertEqual(breakpoints[0].functionName, 'main', 'breakpoint list function');
    assertEqual(breakpoints[0].file, 'main.c', 'breakpoint list file');
    assertEqual(breakpoints[0].line, 10, 'breakpoint list line');
    assertEqual(breakpoints[0].condition, 'x > 0', 'breakpoint list condition');
    assertEqual(breakpoints[0].hitCount, 3, 'breakpoint list hit count');
    assertEqual(breakpoints[1].enabled, false, 'disabled breakpoint list flag');
    assert(breakpoints[1].address === undefined, 'pending breakpoint has no address');
    await harness.session.disconnect();

    const legacyMultiple = createHarness((command, token) => {
        if (command === '-break-list') {
            return `${token}^done,BreakpointTable={nr_rows="1",nr_cols="6",hdr=[],body=[bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="<MULTIPLE>",times="0"},{number="1.1",enabled="y",addr="0x08000100",func="foo",file="a.c",line="1"},{number="1.2",enabled="N",addr="0x08000200"}]}\n`;
        }
        return standardResponse(command, token);
    });
    await legacyMultiple.session.connect('localhost:3333');
    const multiple = await legacyMultiple.session.listBreakpoints();
    assertEqual(multiple.length, 1, 'legacy multiple location breakpoint count');
    assert(multiple[0].address === undefined, 'multiple location breakpoint has no single address');
    assertEqual(multiple[0].locations?.length, 2, 'legacy location count');
    assertEqual(multiple[0].locations?.[0].number, '1.1', 'legacy location number');
    assertEqual(multiple[0].locations?.[0].enabled, true, 'legacy location enabled');
    assertEqual(multiple[0].locations?.[0].address, 0x08000100, 'legacy location address');
    assertEqual(multiple[0].locations?.[1].enabled, false, 'invalid condition location disabled');
    await legacyMultiple.session.disconnect();

    const modernMultiple = createHarness((command, token) => {
        if (command === '-break-list') {
            return `${token}^done,BreakpointTable={nr_rows="1",nr_cols="6",hdr=[],body=[bkpt={number="1",type="breakpoint",enabled="y",addr="0x08000100",times="0",locations=[{number="1.1",enabled="y",addr="0x08000100",func="foo",file="a.c",line="1"}]}]}\n`;
        }
        return standardResponse(command, token);
    });
    await modernMultiple.session.connect('localhost:3333');
    const nested = await modernMultiple.session.listBreakpoints();
    assertEqual(nested[0].locations?.length, 1, 'nested location count');
    assertEqual(nested[0].locations?.[0].functionName, 'foo', 'nested location function');
    await modernMultiple.session.disconnect();

    const empty = createHarness((command, token) => {
        if (command === '-break-list') {
            return `${token}^done,BreakpointTable={nr_rows="0",nr_cols="6",hdr=[],body=[]}\n`;
        }
        return standardResponse(command, token);
    });
    await empty.session.connect('localhost:3333');
    assertEqual((await empty.session.listBreakpoints()).length, 0, 'empty breakpoint list');
    await empty.session.disconnect();
}

async function testBacktraceAndBreakpointErrors(): Promise<void> {
    let stackResponse: ((token: number) => string) | undefined;
    let breakpointResponse: ((token: number) => string) | undefined;
    const harness = createHarness((command, token) => {
        if (command === '-stack-list-frames' && stackResponse !== undefined) {
            return stackResponse(token);
        }
        if (command === '-break-list' && breakpointResponse !== undefined) {
            return breakpointResponse(token);
        }
        return standardResponse(command, token);
    });
    await harness.session.connect('localhost:3333');

    const stack = (body: string) => (token: number) =>
        body === '' ? `${token}^done\n` : `${token}^done,${body}\n`;
    const stackCases: Array<{ label: string; code: string; response: (token: number) => string }> = [
        { label: 'missing stack', code: 'protocol', response: stack('') },
        { label: 'stack not a list', code: 'protocol', response: stack('stack={}') },
        { label: 'frame not a tuple', code: 'protocol', response: stack('stack=["x"]') },
        { label: 'frame without level', code: 'protocol', response: stack('stack=[frame={addr="0x1"}]') },
        { label: 'frame without address', code: 'protocol', response: stack('stack=[frame={level="0"}]') },
        { label: 'invalid frame level', code: 'protocol', response: stack('stack=[frame={level="x",addr="0x1"}]') },
        { label: 'invalid frame address', code: 'protocol', response: stack('stack=[frame={level="0",addr="x"}]') },
        { label: 'non-string frame function', code: 'protocol', response: stack('stack=[frame={level="0",addr="0x1",func=1}]') },
        { label: 'non-string frame line', code: 'protocol', response: stack('stack=[frame={level="0",addr="0x1",line=1}]') },
        { label: 'target error', code: 'target', response: token => `${token}^error,msg="No registers."\n` },
    ];
    for (const testCase of stackCases) {
        stackResponse = testCase.response;
        const failure = await captureReject(harness.session.backtrace(), `backtrace ${testCase.label}`);
        assertEqual(failure.code, testCase.code, `backtrace ${testCase.label} code`);
    }
    stackResponse = undefined;

    const table = (body: string) => (token: number) =>
        `${token}^done,BreakpointTable={nr_rows="1",nr_cols="6",hdr=[],body=${body}}\n`;
    const breakpointCases: Array<{ label: string; code: string; response: (token: number) => string }> = [
        { label: 'missing table', code: 'protocol', response: token => `${token}^done\n` },
        { label: 'table not a tuple', code: 'protocol', response: token => `${token}^done,BreakpointTable=[]\n` },
        { label: 'missing body', code: 'protocol', response: token => `${token}^done,BreakpointTable={nr_rows="0"}\n` },
        { label: 'body not a list', code: 'protocol', response: token => `${token}^done,BreakpointTable={body={}}\n` },
        { label: 'entry not a tuple', code: 'protocol', response: table('["x"]') },
        { label: 'bkpt not a tuple', code: 'protocol', response: table('[bkpt="x"]') },
        { label: 'missing number', code: 'protocol', response: table('[bkpt={type="breakpoint",enabled="y"}]') },
        { label: 'invalid number', code: 'protocol', response: table('[bkpt={number="x",type="breakpoint",enabled="y"}]') },
        { label: 'missing type', code: 'protocol', response: table('[bkpt={number="1",enabled="y"}]') },
        { label: 'missing enabled', code: 'protocol', response: table('[bkpt={number="1",type="breakpoint"}]') },
        { label: 'invalid enabled', code: 'protocol', response: table('[bkpt={number="1",type="breakpoint",enabled="yes"}]') },
        { label: 'invalid address', code: 'protocol', response: table('[bkpt={number="1",type="breakpoint",enabled="y",addr="bad"}]') },
        { label: 'invalid hit count', code: 'protocol', response: table('[bkpt={number="1",type="breakpoint",enabled="y",times="many"}]') },
        { label: 'location without breakpoint', code: 'protocol', response: table('[{number="1.1",enabled="y"}]') },
        { label: 'locations not a list', code: 'protocol', response: table('[bkpt={number="1",type="breakpoint",enabled="y",locations={}}]') },
        { label: 'target error', code: 'target', response: token => `${token}^error,msg="No breakpoints."\n` },
    ];
    for (const testCase of breakpointCases) {
        breakpointResponse = testCase.response;
        const failure = await captureReject(
            harness.session.listBreakpoints(),
            `breakpoint list ${testCase.label}`,
        );
        assertEqual(failure.code, testCase.code, `breakpoint list ${testCase.label} code`);
    }
    await harness.session.disconnect();
}

async function run(): Promise<void> {
    await testConnectAndDisconnect();
    await testConnectErrors();
    await testRegisterAndMemory();
    await testBreakpointsAndEvaluation();
    await testBacktraceAndBreakpointList();
    await testBacktraceAndBreakpointErrors();
    await testThreadsFramesAndVariables();
    await testStepping();
    await testStopsAndInterrupt();
    await testContinueIgnoresStaleStop();
    await testInterruptIgnoresStaleStop();
    await testResumeAttribution();
    await testCommandFailureModes();
    console.log('debug-mi-session tests passed');
}

run().catch(error => {
    console.error('FAIL:', error);
    process.exit(1);
});
