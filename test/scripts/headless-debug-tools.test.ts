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
    try {
        return JSON.parse(result.content[0].text);
    } catch {
        return result.content[0].text;
    }
}

class FakeGdb {
    written: string[];
    killCount: number;
    exited: boolean;
    executable?: string;
    args?: string[];
    onCommand?: (line: string) => void;
    stdoutListeners: Array<(chunk: string) => void>;
    stderrListeners: Array<(chunk: string) => void>;
    exitListeners: Array<(code: number | null, signal: string | null) => void>;
    errorListeners: Array<(error: Error) => void>;

    constructor() {
        this.written = [];
        this.killCount = 0;
        this.exited = false;
        this.stdoutListeners = [];
        this.stderrListeners = [];
        this.exitListeners = [];
        this.errorListeners = [];
    }

    write(data: string): void {
        if (this.exited) {
            throw new Error('GDB stdin is closed');
        }
        this.written.push(data);
        this.onCommand?.(data);
    }

    onStdout(listener: (chunk: string) => void): void { this.stdoutListeners.push(listener); }
    onStderr(listener: (chunk: string) => void): void { this.stderrListeners.push(listener); }
    onExit(listener: (code: number | null, signal: string | null) => void): void { this.exitListeners.push(listener); }
    onError(listener: (error: Error) => void): void { this.errorListeners.push(listener); }

    kill(): void {
        this.killCount++;
        queueMicrotask(() => this.emitExit(null, 'SIGKILL'));
    }

    emitStdout(chunk: string): void {
        for (const listener of this.stdoutListeners) {
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
}

let malformed: 'none' | 'backtrace' | 'breakpoints' = 'none';
let faultMemoryUnreadable = false;
let faultRegisters: { lr: string; msp: string; psp: string } = {
    lr: '0x0', msp: '0x20004fc0', psp: '0x0'
};
let faultDisassemblyFails = false;
let faultBacktraceMode: 'normal' | 'error' | 'restore-mismatch' = 'normal';
let faultAssignments: string[] = [];

const SCB_CONTENTS: { [address: string]: string } = {
    '0xe000ed2c': '00000040',
    '0xe000ed28': '81000000',
    '0xe000ed34': '00000020',
    '0xe000ed38': '00000008'
};

const STACKED_FRAME_CONTENTS = '0000000000000000000000209400000800000000870000089400000800000060';
let stackedFrameContents = STACKED_FRAME_CONTENTS;

function response(command: string, token: number): string | string[] | undefined {
    if (command.startsWith('-gdb-set ')) {
        return `${token}^done\n(gdb) \n`;
    }
    if (command.startsWith('-target-select ')) {
        return `${token}^connected\n(gdb) \n`;
    }
    if (command === '-stack-list-frames') {
        if (malformed === 'backtrace') {
            return `${token}^done,stack=[frame={level="x",addr="0x08000000"}]\n(gdb) \n`;
        }
        if (faultBacktraceMode === 'error') {
            return `${token}^error,msg="backtrace failed"\n`;
        }
        return `${token}^done,stack=[frame={level="0",addr="0x08000000",func="main",file="main.c",fullname="C:\\\\fw\\\\main.c",line="10"},frame={level="1",addr="0x08000100",func="tick",file="main.c",line="20"},frame={level="2",addr="0x08000200"}]\n(gdb) \n`;
    }
    if (command === '-break-list') {
        if (malformed === 'breakpoints') {
            return `${token}^done,BreakpointTable={body=[bkpt={number="x"}]}\n(gdb) \n`;
        }
        return `${token}^done,BreakpointTable={nr_rows="2",nr_cols="6",hdr=[],body=[bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x08000000",func="main",file="main.c",line="10",times="2"},bkpt={number="2",type="breakpoint",disp="keep",enabled="n",addr="<PENDING>",times="0"}]}\n(gdb) \n`;
    }
    if (command.startsWith('-data-evaluate-expression ')) {
        const rawExpression = command.slice('-data-evaluate-expression '.length);
        const assignment = /^"\$(\w+)=(\d+)"$/.exec(rawExpression);
        if (assignment) {
            const name = assignment[1];
            faultAssignments.push(`${name}=${assignment[2]}`);
            if (faultBacktraceMode === 'restore-mismatch' && name === 'msp') {
                faultRegisters.msp = '0x99999999';
            } else if (name in faultRegisters) {
                (faultRegisters as any)[name] = `0x${Number(assignment[2]).toString(16)}`;
            }
            return `${token}^done,value="${assignment[2]}"\n`;
        }
        const expression = /^"\$(\w+)"$/.exec(rawExpression);
        if (expression) {
            const values: { [name: string]: string } = {
                r0: '0x1234', lr: faultRegisters.lr, msp: faultRegisters.msp, psp: faultRegisters.psp
            };
            return `${token}^done,value="${values[expression[1]] || '0x0'}"\n(gdb) \n`;
        }
        return `${token}^done,value="42"\n(gdb) \n`;
    }
    if (command.startsWith('-data-disassemble ')) {
        if (faultDisassemblyFails) {
            return `${token}^error,msg="Cannot access memory at address 0x08000085"\n`;
        }
        if (command.includes(' -s 0x8000094 ')) {
            return `${token}^done,asm_insns=[src_and_asm_line={line="1",file="trap.c",fullname="C:\\\\fw\\\\trap.c",line_asm_insn=[{address="0x08000094",func-name="trap_line",offset="0",opcodes="80 b4",inst="push\\t{r7}"}]}]\n(gdb) \n`;
        }
        if (command.includes(' -s 0x8000085 ')) {
            return `${token}^done,asm_insns=[src_and_asm_line={line="39",file="main.c",fullname="C:\\\\fw\\\\main.c",line_asm_insn=[{address="0x08000085",func-name="main",offset="16",opcodes="47 00",inst="blx\\tr3"}]}]\n(gdb) \n`;
        }
        return `${token}^error,msg="No symbol at address"\n`;
    }
    if (command.startsWith('-data-read-memory-bytes ')) {
        const match = /^-data-read-memory-bytes (0x[0-9a-f]+) 32$/.exec(command);
        if (match && match[1] === faultRegisters.msp && faultRegisters.lr !== '0x0') {
            return `${token}^done,memory=[{offset="0x0",contents="${stackedFrameContents}"}]\n(gdb) \n`;
        }
        if (match && match[1] === faultRegisters.psp && faultRegisters.lr === '0xfffffffd') {
            return `${token}^done,memory=[{offset="0x0",contents="${stackedFrameContents}"}]\n(gdb) \n`;
        }
        const scbMatch = /^-data-read-memory-bytes (0x[0-9a-f]+) 4$/.exec(command);
        const scbContents = scbMatch === null ? undefined : SCB_CONTENTS[scbMatch[1]];
        if (scbContents !== undefined) {
            if (faultMemoryUnreadable) {
                return `${token}^error,msg="Cannot access memory at address ${scbMatch![1]}"\n(gdb) \n`;
            }
            return `${token}^done,memory=[{offset="0x0",contents="${scbContents}"}]\n(gdb) \n`;
        }
        return `${token}^done,memory=[{offset="0x0",contents="deadbeef"}]\n(gdb) \n`;
    }
    if (command.startsWith('-data-write-memory-bytes ')) {
        return `${token}^done\n(gdb) \n`;
    }
    if (command.startsWith('-break-insert ')) {
        return `${token}^done,bkpt={number="1",addr="0x08000000",func="main",file="main.c",line="10"}\n(gdb) \n`;
    }
    if (command.startsWith('-break-delete ')) {
        return `${token}^done\n(gdb) \n`;
    }
    if (command === '-thread-info') {
        return `${token}^done,threads=[{id="1",target-id="Thread 1",name="main",state="stopped",frame={level="0",addr="0x08000000",func="main",file="main.c",line="10"}},{id="2",target-id="Thread 2",name="worker",state="stopped",frame={level="0",addr="0x08000100",func="worker"}}],current-thread-id="1"\n(gdb) \n`;
    }
    if (command === '-thread-select 2') {
        return `${token}^done,new-thread-id="2",frame={level="0",addr="0x08000100",func="worker",file="worker.c",line="20"}\n(gdb) \n`;
    }
    if (command === '-stack-select-frame 1') {
        return `${token}^done\n(gdb) \n`;
    }
    if (command === '-stack-select-frame 0') {
        return `${token}^done\n(gdb) \n`;
    }
    if (command.startsWith('-stack-list-variables ')) {
        return `${token}^done,variables=[{name="counter",value="42"},{name="argc",value="1"}]\n(gdb) \n`;
    }
    if (command === '-exec-next' || command === '-exec-step' || command === '-exec-finish') {
        const reason = command === '-exec-finish' ? 'function-finished' : 'end-stepping-range';
        return [
            `${token}^running\n`,
            `*stopped,reason="${reason}",frame={func="main",file="main.c",line="11"}\n`,
            '(gdb) \n'
        ];
    }
    if (command === '-exec-continue') {
        return [
            `${token}^running\n`,
            '*stopped,reason="breakpoint-hit",bkptno="1",frame={func="main",file="main.c",line="10"}\n',
            '(gdb) \n'
        ];
    }
    if (command === '-exec-interrupt') {
        return `${token}^done\n(gdb) \n`;
    }
    if (command === '-target-disconnect') {
        return `${token}^done\n(gdb) \n`;
    }
    if (command === '-gdb-exit') {
        return `${token}^exit\n`;
    }
    return undefined;
}

function createHarness() {
    const fake = new FakeGdb();
    const spawn = (file: string, args: string[]) => {
        fake.executable = file;
        fake.args = args;
        queueMicrotask(() => fake.emitStdout('=thread-group-added,id="i1"\n(gdb) \n'));
        return fake;
    };
    fake.onCommand = (line: string) => {
        const match = /^(\d+)(.*)\n$/.exec(line);
        if (!match) {
            throw new Error(`unexpected GDB input: ${line}`);
        }
        const result = response(match[2], Number(match[1]));
        if (result !== undefined) {
            const chunks = Array.isArray(result) ? result : [result];
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
    return { fake, spawn };
}

const root = NodePath.join(os.tmpdir(), `eide-headless-debug-${process.pid}-${Date.now()}`);
const SVD = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<device><name>TestDevice</name><addressUnitBits>8</addressUnitBits><width>32</width>',
    '<peripherals><peripheral><name>GPIOA</name><baseAddress>0x40020000</baseAddress>',
    '<addressBlock><offset>0x0</offset><size>0x400</size></addressBlock>',
    '<registers><register><name>MODER</name><addressOffset>0x0</addressOffset></register>',
    '<register><name>CR</name><addressOffset>0x4</addressOffset></register></registers>',
    '</peripheral></peripherals></device>'
].join('\n');

async function run(): Promise<void> {
    write(NodePath.join(root, '.eide', 'eide.yml'), yaml.stringify({
        version: '4.1',
        name: 'demo',
        type: 'ARM',
        srcDirs: ['src'],
        outDir: 'build',
        dependenceList: [],
        miscInfo: { uid: 'debug-uid' },
        targets: {
            Debug: {
                toolchain: 'GCC',
                toolchainConfigMap: { GCC: { options: {} } },
                uploader: 'pyOCD',
                uploadConfigMap: { pyOCD: {} },
                excludeList: [],
                cppPreprocessAttrs: { name: 'default', incList: [], libList: [], defineList: [] },
                settings: {}
            }
        }
    }));
    write(NodePath.join(root, 'build', 'Debug', 'demo.elf'), 'elf');
    write(NodePath.join(root, 'test.svd'), SVD);

    const harness = createHarness();
    const execute = createHeadlessToolExecutor({
        projectPaths: [root],
        resourcesDir: NodePath.join(root, 'resources'),
        toolchainPath: NodePath.join(root, 'toolchain'),
        buildTimeoutMs: 5000,
        flashTimeoutMs: 5000,
        runner: {
            run: async () => ({ code: 0, stdout: '', stderr: '' })
        },
        gdbPath: 'fake-gdb',
        debugSpawn: harness.spawn,
        debugCommandTimeoutMs: 1000,
        debugStopTimeoutMs: 1000
    });

    let result = await execute('eide_debug_read_register', { uid: 'debug-uid', name: 'r0' });
    assert(result.isError === true, 'headless debug: operations require a session');

    result = await execute('eide_debug_connect', {
        uid: 'debug-uid',
        target: 'localhost:3333'
    });
    let data = parse(result);
    assert(result.isError !== true && data.success === true, 'headless debug: connect');
    assert(harness.fake.executable === 'fake-gdb', 'headless debug: gdb executable');
    const gdbArgs = harness.fake.args as string[];
    assert(gdbArgs[gdbArgs.length - 1].endsWith('demo.elf'),
        'headless debug: default elf is loaded');

    data = parse(await execute('eide_debug_read_register', { uid: 'debug-uid', name: 'r0' }));
    assert(data.value === 0x1234, 'headless debug: read register');

    data = parse(await execute('eide_debug_write_memory', {
        uid: 'debug-uid', address: '0x20000000', hex: 'deadbeef'
    }));
    assert(data.success === true && data.length === 4, 'headless debug: write memory');

    data = parse(await execute('eide_debug_read_memory', {
        uid: 'debug-uid', address: '0x20000000', length: 4
    }));
    assert(data.hex === 'deadbeef', 'headless debug: read memory');

    data = parse(await execute('eide_debug_set_breakpoint', {
        uid: 'debug-uid', location: 'main', hardware: true
    }));
    assert(data.id === 1 && data.functionName === 'main', 'headless debug: set breakpoint');

    data = parse(await execute('eide_debug_backtrace', { uid: 'debug-uid' }));
    assert(Array.isArray(data.items) && data.items.length === 3, 'headless debug: backtrace returns frames');
    assert(data.items[0].functionName === 'main' && data.items[0].line === 10,
        'headless debug: backtrace frame fields');
    assert(data.items[2].functionName === undefined, 'headless debug: backtrace optional fields');

    data = parse(await execute('eide_debug_backtrace', { uid: 'debug-uid', maxDepth: 1 }));
    assert(data.items.length === 1 && data.items[0].level === 0, 'headless debug: backtrace maxDepth');
    result = await execute('eide_debug_backtrace', { uid: 'debug-uid', maxDepth: 0 });
    assert(result.isError === true && result.content[0].text.includes('maxDepth'),
        'headless debug: backtrace rejects maxDepth 0');
    result = await execute('eide_debug_backtrace', { uid: 'debug-uid', maxDepth: 201 });
    assert(result.isError === true && result.content[0].text.includes('maxDepth'),
        'headless debug: backtrace rejects maxDepth 201');
    result = await execute('eide_debug_backtrace', { uid: 'debug-uid', maxDepth: '2' });
    assert(result.isError === true && result.content[0].text.includes('maxDepth'),
        'headless debug: backtrace rejects non-numeric maxDepth');
    malformed = 'backtrace';
    result = await execute('eide_debug_backtrace', { uid: 'debug-uid' });
    assert(result.isError === true && result.content[0].text.includes('level'),
        'headless debug: backtrace rejects malformed frames');
    malformed = 'none';

    data = parse(await execute('eide_debug_list_breakpoints', { uid: 'debug-uid' }));
    assert(Array.isArray(data.items) && data.items.length === 2, 'headless debug: list breakpoints');
    assert(data.items[0].id === 1 && data.items[0].enabled === true && data.items[0].hitCount === 2,
        'headless debug: breakpoint list fields');
    assert(data.items[1].enabled === false && data.items[1].address === undefined,
        'headless debug: pending breakpoint list fields');
    malformed = 'breakpoints';
    result = await execute('eide_debug_list_breakpoints', { uid: 'debug-uid' });
    assert(result.isError === true, 'headless debug: breakpoint list rejects malformed response');
    malformed = 'none';

    data = parse(await execute('eide_debug_list_threads', { uid: 'debug-uid' }));
    assert(data.threads.length === 2 && data.currentThreadId === 1,
        'headless debug: list threads');
    assert(data.threads[1].name === 'worker' && data.threads[1].frame.functionName === 'worker',
        'headless debug: thread fields');

    data = parse(await execute('eide_debug_select_thread', { uid: 'debug-uid', id: 2 }));
    assert(data.threadId === 2 && data.frame.functionName === 'worker',
        'headless debug: select thread');

    data = parse(await execute('eide_debug_select_frame', { uid: 'debug-uid', level: 1 }));
    assert(data.success === true && data.level === 1, 'headless debug: select frame');

    data = parse(await execute('eide_debug_list_variables', { uid: 'debug-uid' }));
    assert(data.variables.length === 2 && data.variables[0].name === 'counter',
        'headless debug: list variables');

    data = parse(await execute('eide_debug_list_variables', {
        uid: 'debug-uid', threadId: 2, frameLevel: 1
    }));
    assert(data.threadId === 2 && data.frameLevel === 1 && data.variables[1].value === '1',
        'headless debug: scoped variables');

    data = parse(await execute('eide_debug_list_variables', { uid: 'debug-uid', threadId: 2 }));
    assert(data.threadId === 2 && data.frameLevel === undefined && data.variables.length === 2,
        'headless debug: thread-scoped variables');

    result = await execute('eide_debug_list_variables', { uid: 'debug-uid', frameLevel: 0 });
    assert(result.isError === true && result.content[0].text.includes('requires a thread id'),
        'headless debug: variables reject a frame level without a thread id');

    data = parse(await execute('eide_debug_step_over', {
        uid: 'debug-uid', stopTimeoutMs: 1000
    }));
    assert(data.class === 'stopped' && data.results.reason === 'end-stepping-range',
        'headless debug: step over waits for stop');

    data = parse(await execute('eide_debug_step_into', { uid: 'debug-uid' }));
    assert(data.class === 'stopped' && data.results.reason === 'end-stepping-range',
        'headless debug: step into waits for stop');

    data = parse(await execute('eide_debug_step_out', { uid: 'debug-uid' }));
    assert(data.class === 'stopped' && data.results.reason === 'function-finished',
        'headless debug: step out waits for stop');

    const beforeInvalidStep = harness.fake.written.length;
    result = await execute('eide_debug_step_over', { uid: 'debug-uid', stopTimeoutMs: 0 });
    assert(result.isError === true && result.content[0].text.includes('stopTimeoutMs'),
        'headless debug: step rejects invalid timeout');
    assert(harness.fake.written.length === beforeInvalidStep,
        'headless debug: invalid timeout does not step the target');
    result = await execute('eide_debug_select_thread', { uid: 'debug-uid', id: 0 });
    assert(result.isError === true && result.content[0].text.includes('id'),
        'headless debug: select thread rejects id 0');
    result = await execute('eide_debug_select_frame', { uid: 'debug-uid', level: -1 });
    assert(result.isError === true && result.content[0].text.includes('level'),
        'headless debug: select frame rejects negative level');
    result = await execute('eide_debug_list_variables', { uid: 'debug-uid', threadId: 0 });
    assert(result.isError === true && result.content[0].text.includes('threadId'),
        'headless debug: variables reject invalid thread');

    data = parse(await execute('eide_debug_continue', { uid: 'debug-uid' }));
    assert(data.class === 'stopped' && data.results.reason === 'breakpoint-hit',
        'headless debug: continue waits for stop');

    data = parse(await execute('eide_debug_evaluate', {
        uid: 'debug-uid', expression: 'counter'
    }));
    assert(data.value === '42', 'headless debug: evaluate');

    const beforeFault = harness.fake.written.length;
    data = parse(await execute('eide_debug_fault', { uid: 'debug-uid' }));
    assert(data.reasons.some((reason: any) => reason.code === 'FORCED'),
        'headless debug: fault reads registers');
    assert(data.reasons.some((reason: any) => reason.code === 'IACCVIOL'),
        'headless debug: fault decodes CFSR');
    assert(data.memManageAddressValid === true && data.memManageAddress === 0x20000000,
        'headless debug: fault address');
    const faultCommands = harness.fake.written
        .slice(beforeFault)
        .map((line: string) => line.replace(/^\d+/, ''));
    for (const address of ['0xe000ed2c', '0xe000ed28', '0xe000ed34', '0xe000ed38']) {
        assert(faultCommands.includes(`-data-read-memory-bytes ${address} 4\n`),
            `headless debug: fault reads SCB memory at ${address}`);
    }
    assert(!faultCommands.some((line: string) =>
        line.startsWith('-data-evaluate-expression "$hfsr"')),
    'headless debug: fault does not treat SCB registers as CPU registers');

    faultMemoryUnreadable = true;
    result = await execute('eide_debug_fault', { uid: 'debug-uid' });
    assert(result.isError === true
        && result.content[0].text.includes('Cannot access memory at address 0xe000ed2c'),
    'headless debug: fault surfaces an unreadable SCB register');
    faultMemoryUnreadable = false;

    faultRegisters = { lr: '0xfffffff9', msp: '0x20004fc0', psp: '0x0' };
    const beforeException = harness.fake.written.length;
    data = parse(await execute('eide_debug_fault', { uid: 'debug-uid' }));
    assert(data.exception !== null && data.exception.stack === 'MSP',
        'headless debug: fault selects MSP from EXC_RETURN');
    assert(data.exception.frame.pc === 0x08000094 && data.exception.frame.lr === 0x08000087,
        'headless debug: fault decodes stacked pc and lr');
    assert(data.exception.faultLocation.file === 'trap.c' && data.exception.faultLocation.line === 1,
        'headless debug: fault location points to trap.c:1');
    assert(data.exception.callerLocation.file === 'main.c' && data.exception.callerLocation.line === 39,
        'headless debug: caller location points to main.c:39');
    const exceptionCommands = harness.fake.written
        .slice(beforeException)
        .map((line: string) => line.replace(/^\d+/, ''));
    assert(exceptionCommands.some((line: string) => line.startsWith('-data-disassemble -s 0x8000094 ')),
        'headless debug: fault resolves stacked pc');
    assert(exceptionCommands.some((line: string) => line.startsWith('-data-disassemble -s 0x8000085 ')),
        'headless debug: fault resolves lr-1 call site');
    assert(!exceptionCommands.some((line: string) => line.startsWith('-data-disassemble -s 0x8000086 ')),
        'headless debug: fault does not resolve lr+0');
    assert(exceptionCommands.some((line: string) => line === '-data-read-memory-bytes 0x20004fc0 32\n'),
        'headless debug: fault reads 8 stacked words from MSP');

    faultRegisters = { lr: '0xfffffffd', msp: '0x20004fc0', psp: '0x20004e00' };
    harness.fake.written.length = 0;
    data = parse(await execute('eide_debug_fault', { uid: 'debug-uid' }));
    assert(data.exception.stack === 'PSP', 'headless debug: fault selects PSP from EXC_RETURN');
    assert(harness.fake.written.some((line: string) => line.includes('-data-read-memory-bytes 0x20004e00 32')),
        'headless debug: fault reads stacked frame from PSP');

    faultRegisters = { lr: '0x0', msp: '0x20004fc0', psp: '0x0' };
    data = parse(await execute('eide_debug_fault', { uid: 'debug-uid' }));
    assert(data.exception === null && typeof data.exceptionUnavailable === 'string'
        && data.exceptionUnavailable.includes('0x0'),
    'headless debug: non-EXC_RETURN LR reports exception unavailable');

    faultRegisters = { lr: '0xfffffff9', msp: '0x20004fc0', psp: '0x0' };
    faultDisassemblyFails = true;
    data = parse(await execute('eide_debug_fault', { uid: 'debug-uid' }));
    assert(data.exception !== null && data.exception.faultLocation.address === 0x08000094
        && typeof data.exception.faultLocation.error === 'string'
        && data.reasons.some((reason: any) => reason.code === 'FORCED'),
    'headless debug: failed location resolution keeps register decode');
    faultDisassemblyFails = false;

    faultRegisters = { lr: '0xfffffff9', msp: '0x20004fc0', psp: '0x0' };
    faultAssignments = [];
    faultBacktraceMode = 'normal';
    faultDisassemblyFails = true;
    data = parse(await execute('eide_debug_fault', { uid: 'debug-uid' }));
    assert(data.exception?.backtrace?.from === 'callSite',
        'headless debug: fault backtrace starts at callSite when fault PC has no symbol');
    assert(faultAssignments.includes('msp=536891360'),
        'headless debug: fault backtrace writes SP plus 32 into MSP');
    faultDisassemblyFails = false;

    faultRegisters = { lr: '0xfffffff9', msp: '0x20000000', psp: '0x0' };
    faultAssignments = [];
    stackedFrameContents = '0000000000000000000000209400000800000000870000089400000800000200';
    faultDisassemblyFails = true;
    data = parse(await execute('eide_debug_fault', { uid: 'debug-uid' }));
    assert(faultAssignments.includes('msp=536870944'),
        'headless debug: fault backtrace adds 36 when xPSR bit9 is set');
    faultDisassemblyFails = false;
    stackedFrameContents = STACKED_FRAME_CONTENTS;

    faultRegisters = { lr: '0xfffffff9', msp: '0x20004fc0', psp: '0x0' };
    faultAssignments = [];
    const faultPcResult = await execute('eide_debug_fault', { uid: 'debug-uid' });
    data = parse(faultPcResult);
    assert(faultPcResult.isError !== true && data.exception?.backtrace?.from === 'faultPc'
        && faultAssignments.includes('pc=134217876'),
    'headless debug: fault backtrace uses fault PC when its function is known');

    faultRegisters = { lr: '0xfffffff9', msp: '0x20004fc0', psp: '0x0' };
    faultAssignments = [];
    faultBacktraceMode = 'error';
    data = parse(await execute('eide_debug_fault', { uid: 'debug-uid' }));
    assert(typeof data.exception?.backtrace?.error === 'string',
        'headless debug: ordinary backtrace failure is reported in the result');
    assert(faultAssignments.some((item: string) => item.startsWith('msp=') && !item.includes('536891360')),
        'headless debug: registers are written back after ordinary backtrace failure');

    faultRegisters = { lr: '0xfffffff9', msp: '0x20004fc0', psp: '0x0' };
    faultAssignments = [];
    faultBacktraceMode = 'restore-mismatch';
    result = await execute('eide_debug_fault', { uid: 'debug-uid' });
    assert(result.isError === true && result.content[0].text.includes('registers not restored'),
        'headless debug: register restore failure fails the whole tool');

    faultBacktraceMode = 'normal';
    faultRegisters = { lr: '0x0', msp: '0x20004fc0', psp: '0x0' };

    data = parse(await execute('eide_debug_interrupt', { uid: 'debug-uid' }));
    assert(data.success === true, 'headless debug: interrupt');

    data = parse(await execute('eide_debug_svd_lookup', {
        uid: 'debug-uid', path: 'test.svd', address: '0x40020004'
    }));
    assert(data.register.register.name === 'CR' && data.peripheral.peripheral.name === 'GPIOA',
        'headless debug: svd lookup by address');

    data = parse(await execute('eide_debug_remove_breakpoint', { uid: 'debug-uid', id: 1 }));
    assert(data.success === true, 'headless debug: remove breakpoint');

    data = parse(await execute('eide_debug_disconnect', { uid: 'debug-uid' }));
    assert(data.success === true, 'headless debug: disconnect');

    result = await execute('eide_debug_read_register', { uid: 'debug-uid', name: 'r0' });
    assert(result.isError === true, 'headless debug: session is closed');

    data = parse(await execute('eide_debug_fault', {
        uid: 'debug-uid', hfsr: '0x40000000', cfsr: '0x00020000', mmar: '0x20000000', bfar: '0x08000000'
    }));
    assert(data.reasons.some((reason: any) => reason.code === 'FORCED')
        && data.exception === undefined && data.exceptionUnavailable === undefined,
    'headless debug: offline fault decode has no exception field');
}

run()
    .then(() => {
        console.log('All headless debug tool tests passed.');
    })
    .catch(error => {
        console.error(error);
        process.exit(1);
    })
    .finally(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
export {};
