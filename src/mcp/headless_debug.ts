import * as fs from 'fs';
import * as NodePath from 'path';
import { CORTEX_M_FAULT_REGISTERS, decodeCortexFault } from '../core/debug/fault';
import {
    MiBreakpointRecord,
    MiFrame,
    MiSession,
    MiSpawn,
    MiStopEvent,
    MiThreadList,
    MiVariable,
    MiVariableOptions
} from '../core/debug/mi';
import { SvdModel } from '../core/debug/svd';
import { HeadlessProject } from './headless_project';

const MAX_DEBUG_MEMORY_BYTES = 1024 * 1024;
const MAX_BACKTRACE_DEPTH = 200;

export interface DebugSessionOptions {
    gdbPath?: string;
    spawn?: MiSpawn;
    commandTimeoutMs?: number;
    stopTimeoutMs?: number;
}

function parseIntegerValue(value: unknown, name: string, minimum: number): number {
    let parsed: number;
    if (typeof value === 'number') {
        parsed = value;
    } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        parsed = Number(value.trim());
    } else {
        throw new Error(`'${name}' must be an integer.`);
    }
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new Error(`'${name}' must be an integer greater than or equal to ${minimum}.`);
    }
    return parsed;
}

function parseAddressValue(value: unknown, name: string): number {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`'${name}' must be a non-negative safe integer.`);
        }
        return value;
    }
    if (typeof value === 'string') {
        const text = value.trim();
        const parsed = /^0x[0-9a-f]+$/i.test(text)
            ? parseInt(text.slice(2), 16)
            : /^\d+$/.test(text) ? parseInt(text, 10) : NaN;
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
            throw new Error(`'${name}' must be a non-negative address.`);
        }
        return parsed;
    }
    throw new Error(`'${name}' must be an address.`);
}

export class HeadlessDebugSession {
    private session: MiSession | undefined;

    constructor(private readonly options: DebugSessionOptions) {}

    private requireSession(): MiSession {
        if (!this.session) {
            throw new Error('No active debug session. Call eide_debug_connect first.');
        }
        return this.session;
    }

    async connect(project: HeadlessProject, args: Record<string, unknown>): Promise<any> {
        if (this.session) {
            throw new Error('A debug session is already active.');
        }
        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (target.length === 0) {
            throw new Error("'target' must not be empty.");
        }
        const modeValue = args.mode ?? 'extended-remote';
        if (modeValue !== 'remote' && modeValue !== 'extended-remote') {
            throw new Error(`Invalid remote mode: ${String(modeValue)}`);
        }
        const mode = modeValue;
        let elf: string | undefined;
        if (typeof args.elf === 'string' && args.elf.trim().length > 0) {
            elf = NodePath.resolve(project.projectPath, args.elf);
        } else {
            const snapshot = project.getSnapshot();
            const candidate = NodePath.join(
                snapshot.projectPath, snapshot.outDir, snapshot.target, `${snapshot.name}.elf`);
            if (fs.existsSync(candidate)) {
                elf = candidate;
            }
        }
        const gdbPath = typeof args.gdbPath === 'string' && args.gdbPath.trim().length > 0
            ? args.gdbPath
            : this.options.gdbPath;
        const gdbArgs = elf === undefined
            ? undefined
            : ['--interpreter=mi2', '--quiet', '--nx', elf];
        const session = new MiSession({
            gdbPath,
            gdbArgs,
            cwd: project.projectPath,
            spawn: this.options.spawn,
            commandTimeoutMs: this.options.commandTimeoutMs,
            stopTimeoutMs: this.options.stopTimeoutMs
        });
        await session.connect(target, mode);
        this.session = session;
        return { success: true, target, mode, elf };
    }

    async disconnect(): Promise<any> {
        const session = this.session;
        this.session = undefined;
        if (session) {
            await session.disconnect();
        }
        return { success: true };
    }

    async readRegister(name: unknown): Promise<any> {
        const register = typeof name === 'string' ? name.trim() : '';
        return { name: register, value: await this.requireSession().readRegister(register) };
    }

    async readMemory(address: unknown, length: unknown): Promise<any> {
        const parsedAddress = parseAddressValue(address, 'address');
        if (typeof length !== 'number' || !Number.isInteger(length)
            || length <= 0 || length > MAX_DEBUG_MEMORY_BYTES) {
            throw new Error(`'length' must be an integer between 1 and ${MAX_DEBUG_MEMORY_BYTES}.`);
        }
        const data = await this.requireSession().readMemory(parsedAddress, length);
        return { address: parsedAddress, length, hex: data.toString('hex') };
    }

    async writeMemory(address: unknown, hex: unknown): Promise<any> {
        const parsedAddress = parseAddressValue(address, 'address');
        if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0
            || !/^[0-9a-f]+$/i.test(hex)) {
            throw new Error("'hex' must be a non-empty even-length hexadecimal string.");
        }
        const data = Buffer.from(hex, 'hex');
        if (data.length > MAX_DEBUG_MEMORY_BYTES) {
            throw new Error(`Memory write exceeds ${MAX_DEBUG_MEMORY_BYTES} bytes.`);
        }
        await this.requireSession().writeMemory(parsedAddress, data);
        return { success: true, address: parsedAddress, length: data.length };
    }

    async setBreakpoint(args: Record<string, unknown>): Promise<any> {
        const location = typeof args.location === 'string' ? args.location.trim() : '';
        return this.requireSession().insertBreakpoint(location, {
            hardware: args.hardware === true,
            condition: typeof args.condition === 'string' ? args.condition : undefined
        });
    }

    async removeBreakpoint(id: unknown): Promise<any> {
        if (typeof id !== 'number') {
            throw new Error("'id' must be a breakpoint number.");
        }
        await this.requireSession().removeBreakpoint(id);
        return { success: true, id };
    }

    async backtrace(maxDepth: unknown): Promise<MiFrame[]> {
        if (maxDepth !== undefined
            && (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth)
                || maxDepth < 1 || maxDepth > MAX_BACKTRACE_DEPTH)) {
            throw new Error(`'maxDepth' must be an integer between 1 and ${MAX_BACKTRACE_DEPTH}.`);
        }
        const frames = await this.requireSession().backtrace();
        return maxDepth === undefined ? frames : frames.slice(0, maxDepth);
    }

    async listBreakpoints(): Promise<MiBreakpointRecord[]> {
        return this.requireSession().listBreakpoints();
    }

    async listThreads(): Promise<MiThreadList> {
        return this.requireSession().listThreads();
    }

    async selectThread(id: unknown): Promise<any> {
        const threadId = parseIntegerValue(id, 'id', 1);
        const frame = await this.requireSession().selectThread(threadId);
        return { threadId, frame: frame ?? null };
    }

    async selectFrame(level: unknown): Promise<any> {
        const frameLevel = parseIntegerValue(level, 'level', 0);
        await this.requireSession().selectFrame(frameLevel);
        return { success: true, level: frameLevel };
    }

    async listVariables(args: Record<string, unknown>): Promise<any> {
        const options: MiVariableOptions = {};
        if (args.threadId !== undefined) {
            options.threadId = parseIntegerValue(args.threadId, 'threadId', 1);
        }
        if (args.frameLevel !== undefined) {
            options.frameLevel = parseIntegerValue(args.frameLevel, 'frameLevel', 0);
        }
        const variables: MiVariable[] = await this.requireSession().listVariables(options);
        return { ...options, variables };
    }

    async continue(stopTimeoutMs: unknown): Promise<MiStopEvent> {
        return this.runAndWait(session => session.continue(), stopTimeoutMs);
    }

    async stepOver(stopTimeoutMs: unknown): Promise<MiStopEvent> {
        return this.runAndWait(session => session.stepOver(), stopTimeoutMs);
    }

    async stepInto(stopTimeoutMs: unknown): Promise<MiStopEvent> {
        return this.runAndWait(session => session.stepInto(), stopTimeoutMs);
    }

    async stepOut(stopTimeoutMs: unknown): Promise<MiStopEvent> {
        return this.runAndWait(session => session.stepOut(), stopTimeoutMs);
    }

    private async runAndWait(
        action: (session: MiSession) => Promise<void>,
        stopTimeoutMs: unknown
    ): Promise<MiStopEvent> {
        const timeout = stopTimeoutMs === undefined
            ? this.options.stopTimeoutMs
            : parseIntegerValue(stopTimeoutMs, 'stopTimeoutMs', 1);
        const session = this.requireSession();
        await action(session);
        return timeout === undefined ? session.waitForStop() : session.waitForStop(timeout);
    }

    async interrupt(): Promise<any> {
        await this.requireSession().interrupt();
        return { success: true };
    }

    async evaluate(expression: unknown): Promise<any> {
        const text = typeof expression === 'string' ? expression.trim() : '';
        return { expression: text, value: await this.requireSession().evaluate(text) };
    }

    async fault(args: Record<string, unknown>): Promise<any> {
        const session = this.session;
        const read = async (name: keyof typeof CORTEX_M_FAULT_REGISTERS): Promise<number> => {
            if (args[name] !== undefined) {
                return parseAddressValue(args[name], name);
            }
            if (session) {
                const bytes = await session.readMemory(CORTEX_M_FAULT_REGISTERS[name], 4);
                return bytes.readUInt32LE(0);
            }
            throw new Error(`'${name}' is required when no debug session is active.`);
        };
        return decodeCortexFault({
            hfsr: await read('hfsr'),
            cfsr: await read('cfsr'),
            mmar: args.mmar !== undefined || session ? await read('mmar') : undefined,
            bfar: args.bfar !== undefined || session ? await read('bfar') : undefined
        });
    }

    async svdLookup(project: HeadlessProject, args: Record<string, unknown>): Promise<any> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        if (path.length === 0) {
            throw new Error("'path' must not be empty.");
        }
        const file = NodePath.resolve(project.projectPath, path);
        if (!fs.existsSync(file)) {
            throw new Error(`SVD file not found: ${file}`);
        }
        const model = SvdModel.parse(fs.readFileSync(file, 'utf8'));
        if (args.address !== undefined) {
            const address = parseAddressValue(args.address, 'address');
            return {
                address,
                register: model.findRegisterAt(address) ?? null,
                peripheral: model.findPeripheralAt(address) ?? null
            };
        }
        const peripheralName = typeof args.peripheral === 'string' ? args.peripheral : undefined;
        const registerName = typeof args.register === 'string' ? args.register : undefined;
        if (peripheralName && registerName) {
            return {
                peripheral: model.findPeripheral(peripheralName) ?? null,
                register: model.findRegister(peripheralName, registerName) ?? null
            };
        }
        if (peripheralName) {
            return { peripheral: model.findPeripheral(peripheralName) ?? null };
        }
        if (registerName) {
            return { registers: model.findRegisters(registerName) };
        }
        throw new Error("Provide 'address', 'peripheral', or 'register'.");
    }
}
