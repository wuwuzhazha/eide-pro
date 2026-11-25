import {
    FlashCapabilities,
    FlashCommand,
    FlashProgram,
    FlashRequest,
    FlashRequestBase,
    FlashTool,
    FlashUploaderName,
    JLinkFlashRequest,
    OpenOCDFlashRequest,
    ProbeRSFlashRequest,
    PyOCDFlashRequest,
    STLinkFlashRequest
} from './types';
import { renderJLinkCommandFile, resolveJLinkProgramVariables } from './jlink_template';

export const FLASH_COMMAND_FILE_PLACEHOLDER = '__EIDE_FLASH_COMMAND_FILE__';

const DEFAULT_JLINK_INTERFACE = 'SWD';
const DEFAULT_JLINK_SPEED_KHZ = 4000;
const DEFAULT_STLINK_PROTOCOL = 'SWD';
const DEFAULT_STLINK_FREQUENCY_KHZ = 4000;
const DEFAULT_PROBE_RS_PROTOCOL = 'swd';

export class FlashBuildError extends Error {

    constructor(readonly code: 'not_supported' | 'invalid_request', message: string) {
        super(message);
        this.name = 'FlashBuildError';
    }
}

function invalidRequest(message: string): FlashBuildError {
    return new FlashBuildError('invalid_request', message);
}

function unsupported(message: string): FlashBuildError {
    return new FlashBuildError('not_supported', message);
}

function requiredString(value: string | undefined, name: string): string {
    if (value === undefined || value.trim() === '') {
        throw invalidRequest(`${name} must not be empty`);
    }
    return value;
}

function programsOf(request: FlashRequestBase, required: boolean): FlashProgram[] {
    const programs = Array.isArray(request.programs) ? request.programs : [request.programs];
    if (!required) {
        return programs;
    }
    if (programs.length === 0) {
        throw invalidRequest('no program files were provided');
    }
    for (const program of programs) {
        if (program.path.trim() === '') {
            throw invalidRequest('program file path must not be empty');
        }
    }
    return programs;
}

function assertVerifyNotWithEraseAll(request: FlashRequestBase, uploader: FlashUploaderName): void {
    if (request.eraseAll === true && request.verify === true) {
        throw unsupported(`verify cannot be performed for eraseAll on '${uploader}'`);
    }
}

function toUnixPath(path: string): string {
    return path.replace(/\\/g, '/');
}

function openOCDConfigArg(kind: 'interface' | 'target', name: string): string {
    const value = requiredString(name, `${kind} config`);
    const path = value.startsWith('${workspaceFolder}/')
        ? value.slice('${workspaceFolder}/'.length)
        : `${kind}/${value}`;
    return `${path}.cfg`;
}

export function buildJLinkCommand(request: JLinkFlashRequest): FlashCommand {

    assertVerifyNotWithEraseAll(request, 'JLink');

    if (request.verify === false) {
        throw unsupported("verification cannot be disabled for 'JLink'");
    }

    const options = request.options;
    const executable = requiredString(options.executable, 'JLink executable');
    const device = requiredString(options.device, 'JLink device');
    const protocol = options.interface ?? DEFAULT_JLINK_INTERFACE;

    const commands: string[] = [];
    let programs: FlashProgram[] = [];
    let verify = false;

    if (request.eraseAll) {
        commands.push('r', 'halt', 'erase', 'r');
    } else {
        programs = programsOf(request, true);
        commands.push('r', 'halt');
        for (const program of programs) {
            if (/\.bin$/i.test(program.path)) {
                const address = program.address ?? request.address;
                if (address === undefined || address.trim() === '') {
                    throw invalidRequest(
                        `JLink requires an address for the .bin program '${program.path}': `
                        + 'set the project baseAddr or use a "file.bin,0x..." program entry');
                }
                commands.push(`loadfile "${program.path}",${address}`);
            } else {
                commands.push(`loadfile "${program.path}"`);
            }
        }
        commands.push('r', 'go');
        verify = true;
    }

    const args = [
        '-ExitOnError', '1',
        '-AutoConnect', '1',
        '-Device', device,
        '-If', protocol,
        '-Speed', String(options.speedKhz ?? DEFAULT_JLINK_SPEED_KHZ),
        '-CommandFile', FLASH_COMMAND_FILE_PLACEHOLDER
    ];

    if (protocol === 'JTAG' || protocol === 'cJTAG') {
        args.push('-JTAGConf', '-1,-1');
    }
    if (options.extraArgs && options.extraArgs.length > 0) {
        args.push(...options.extraArgs);
    }

    return {
        executable,
        args,
        verify,
        script: {
            contents: renderJLinkCommandFile(
                commands,
                options.commandTemplate === undefined
                    ? undefined
                    : resolveJLinkProgramVariables(options.commandTemplate, programs)),
            extension: '.jlink'
        }
    };
}

export function buildOpenOCDCommand(request: OpenOCDFlashRequest): FlashCommand {

    assertVerifyNotWithEraseAll(request, 'OpenOCD');

    if (request.eraseAll) {
        throw unsupported("eraseAll is not supported for 'OpenOCD'");
    }

    const options = request.options;
    const executable = requiredString(options.executable, 'OpenOCD executable');
    const programs = programsOf(request, true);
    const verify = request.verify !== false;

    const args: string[] = [];
    if (options.searchDir) {
        args.push('-s', options.searchDir);
    }
    args.push(
        '-f', openOCDConfigArg('interface', options.interfaceConfig),
        '-f', openOCDConfigArg('target', options.targetConfig)
    );
    if (options.extraArgs && options.extraArgs.length > 0) {
        args.push(...options.extraArgs);
    }

    for (const program of programs) {
        const path = toUnixPath(program.path);
        if (/\.bin$/i.test(program.path)) {
            const address = program.address ?? request.address;
            if (address === undefined || address.trim() === '') {
                throw invalidRequest(
                    `OpenOCD requires an address for the .bin program '${program.path}': `
                    + 'set the project baseAddr or use a "file.bin,0x..." program entry');
            }
            args.push('-c', `program "${path}" ${address}${verify ? ' verify' : ''}`);
        } else {
            args.push('-c', `program "${path}"${verify ? ' verify' : ''}`);
        }
    }

    args.push('-c', 'reset run', '-c', 'exit');

    return { executable, args, verify };
}

export function buildPyOCDCommand(request: PyOCDFlashRequest): FlashCommand {

    assertVerifyNotWithEraseAll(request, 'pyOCD');

    const options = request.options;
    const executable = requiredString(options.executable, 'pyOCD executable');
    const target = requiredString(options.target, 'pyOCD target');

    const args: string[] = [request.eraseAll ? 'erase' : 'flash'];

    if (options.extraArgs && options.extraArgs.length > 0) {
        args.push(...options.extraArgs);
    }
    if (request.eraseAll) {
        args.push('--chip');
    }
    if (options.configFile) {
        args.push('--config', options.configFile);
    }
    args.push('-t', target);
    if (options.frequency) {
        args.push('-f', options.frequency);
    }

    if (!request.eraseAll) {
        for (const program of programsOf(request, true)) {
            if (/\.bin$/i.test(program.path)) {
                const address = program.address ?? request.address;
                // pyOCD documents the start of flash as the default for a .bin without an address.
                args.push(address ? `${program.path}@${address}` : program.path);
            } else {
                args.push(program.path);
            }
        }
    }

    // pyOCD's FlashLoader.commit only erases and programs; it performs no read-back verification.
    return { executable, args, verify: false };
}

export function buildSTLinkCommand(request: STLinkFlashRequest): FlashCommand {

    assertVerifyNotWithEraseAll(request, 'STLink');

    const options = request.options;
    const executable = requiredString(options.executable, 'STLink executable');
    const protocol = options.protocol ?? DEFAULT_STLINK_PROTOCOL;
    const frequency = String(options.frequencyKhz ?? DEFAULT_STLINK_FREQUENCY_KHZ);
    const resetMode = options.resetMode ?? 'default';
    const runAfterProgram = options.runAfterProgram ?? true;
    const verify = request.verify !== false;
    const programs = programsOf(request, request.eraseAll !== true);

    if (!request.eraseAll && programs.length > 1) {
        throw invalidRequest("STLink supports a single program file per invocation");
    }

    switch (options.variant) {

        case 'stlink-cli': {
            const args = ['-c', protocol, `FREQ=${frequency}`, 'UR'];
            if (resetMode !== 'default') {
                const resetModeMap: { [key: string]: string } = { SWrst: 'Srst', HWrst: 'Hrst' };
                args.push(resetModeMap[resetMode] ?? resetMode);
            }

            if (!request.eraseAll) {
                const program = programs[0];
                args.push('-P', program.path);
                if (/\.bin$/i.test(program.path)) {
                    const address = program.address ?? request.address;
                    if (address !== undefined && address.trim() !== '') {
                        args.push(address);
                    }
                }
                if (options.externalLoader) {
                    args.push('-EL', options.externalLoader);
                }
                if (options.optionBytes && options.optionBytes.length > 0) {
                    args.push('-OB', ...options.optionBytes, '-rOB');
                }
                if (verify) {
                    args.push('-V', 'after_programming');
                }
            } else {
                args.push('-ME');
            }

            args.push('-NoPrompt', '-TVolt');
            if (runAfterProgram) {
                args.push('-Run');
            }
            if (options.extraArgs && options.extraArgs.length > 0) {
                args.push(...options.extraArgs);
            }
            return { executable, args, verify: !request.eraseAll && verify };
        }

        case 'cube-programmer': {
            const args = ['-c', `port=${protocol}`, `freq=${frequency}`];
            if (resetMode !== 'default') {
                args.push(`reset=${resetMode}`);
            }

            if (!request.eraseAll) {
                if (options.externalLoader) {
                    args.push('-el', options.externalLoader);
                }
                if (options.optionBytes && options.optionBytes.length > 0) {
                    args.push('-ob', ...options.optionBytes, '-ob', 'displ');
                }

                const program = programs[0];
                args.push('--download', program.path);
                if (/\.bin$/i.test(program.path)) {
                    const address = program.address ?? request.address;
                    if (address !== undefined && address.trim() !== '') {
                        args.push(address);
                    }
                }
                if (verify) {
                    args.push('-v');
                }
            } else {
                args.push('-e', 'all');
            }

            if (runAfterProgram) {
                args.push('--go');
            }
            if (options.extraArgs && options.extraArgs.length > 0) {
                args.push(...options.extraArgs);
            }
            return { executable, args, verify: !request.eraseAll && verify };
        }

        default:
            throw invalidRequest(`unknown STLink CLI variant '${options.variant}'`);
    }
}

export function buildProbeRSCommand(request: ProbeRSFlashRequest): FlashCommand {

    assertVerifyNotWithEraseAll(request, 'probe-rs');

    if (request.eraseAll) {
        throw unsupported("eraseAll is not supported for 'probe-rs'");
    }

    const options = request.options;
    const executable = requiredString(options.executable, 'probe-rs executable');
    const chip = requiredString(options.chip, 'probe-rs chip');
    const programs = programsOf(request, true);

    if (programs.length > 1) {
        throw invalidRequest('probe-rs supports a single program file per invocation');
    }

    const program = programs[0];
    const args = [
        '--chip', chip,
        '--protocol', options.protocol ?? DEFAULT_PROBE_RS_PROTOCOL
    ];

    if (options.workDir) {
        args.push('--work-dir', options.workDir);
    }
    args.push('--path', program.path);
    if (/\.bin$/i.test(program.path)) {
        const address = program.address ?? request.address;
        if (address === undefined || address.trim() === '') {
            throw invalidRequest(
                `probe-rs requires an address for the .bin program '${program.path}': `
                + 'set the project baseAddr or use a "file.bin,0x..." program entry');
        }
        args.push('--binary-format', 'bin', '--base-address', address);
    }

    const verify = request.verify !== false;
    if (verify) {
        args.push('--verify');
    }
    if (options.speedKhz) {
        args.push('--speed', String(options.speedKhz));
    }
    if (options.extraArgs && options.extraArgs.length > 0) {
        args.push(...options.extraArgs);
    }

    return { executable, args, verify };
}

export function buildFlashCommand(request: FlashRequest): FlashCommand {
    switch (request.uploader) {
        case 'JLink':
            return buildJLinkCommand(request);
        case 'OpenOCD':
            return buildOpenOCDCommand(request);
        case 'pyOCD':
            return buildPyOCDCommand(request);
        case 'STLink':
            return buildSTLinkCommand(request);
        case 'probe-rs':
            return buildProbeRSCommand(request);
        default:
            throw unsupported(`'${request.uploader}' is not supported by the headless flash layer`);
    }
}

function tool(uploader: FlashUploaderName, capabilities: Omit<FlashCapabilities, 'uploader'>): FlashTool {
    return {
        uploader,
        capabilities: { uploader, ...capabilities }
    };
}

export const FLASH_TOOLS: Record<FlashUploaderName, FlashTool> = {
    JLink: tool('JLink', {
        supported: true,
        program: true,
        eraseAll: true,
        verify: 'always',
        readback: false
    }),
    OpenOCD: tool('OpenOCD', {
        supported: true,
        program: true,
        eraseAll: false,
        verify: 'optional',
        readback: false
    }),
    pyOCD: tool('pyOCD', {
        supported: true,
        program: true,
        eraseAll: true,
        verify: 'unsupported',
        readback: false
    }),
    STLink: tool('STLink', {
        supported: true,
        program: true,
        eraseAll: true,
        verify: 'optional',
        readback: false
    }),
    'probe-rs': tool('probe-rs', {
        supported: true,
        program: true,
        eraseAll: false,
        verify: 'optional',
        readback: false
    }),
    STVP: tool('STVP', {
        supported: false,
        program: false,
        eraseAll: false,
        verify: 'unsupported',
        readback: false,
        reason: "STVP command-line flashing is not supported by the headless flash layer"
    }),
    stcgal: tool('stcgal', {
        supported: false,
        program: false,
        eraseAll: false,
        verify: 'unsupported',
        readback: false,
        reason: "stcgal flashing is not supported by the headless flash layer"
    }),
    Custom: tool('Custom', {
        supported: false,
        program: false,
        eraseAll: false,
        verify: 'unsupported',
        readback: false,
        reason: "custom flash commands are not supported by the headless flash layer"
    })
};

export function getFlashCapabilities(uploader: FlashUploaderName): FlashCapabilities {
    return FLASH_TOOLS[uploader].capabilities;
}

export function listFlashTools(): FlashTool[] {
    return Object.values(FLASH_TOOLS);
}
