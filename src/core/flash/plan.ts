import * as fs from 'fs';
import * as ini from 'ini';
import * as NodePath from 'path';
import { createProjectEnvironment, resolveEnvironmentVariables } from '../project_env';
import { ProjectSnapshot } from '../project_snapshot';
import { buildFlashCommand } from './builders';
import { ConfigError } from '../errors';
import {
    FlashCommand,
    FlashProgram,
    FlashRequest,
    FlashUploaderName,
    JLinkInterface,
    ProbeRSProtocol,
    STLinkCLIVariant,
    STLinkProtocol
} from './types';

export interface FlashEnvironment {
    flasherExecutable?: string;
    timeoutMs: number;
    eraseAll: boolean;
    verify?: boolean;
    artifact?: string;
}

export interface FlashPlan {
    uploader: FlashUploaderName;
    request: FlashRequest;
    command: FlashCommand;
}

const DEFAULT_JLINK_SPEED_KHZ = 4000;
const DEFAULT_STLINK_FREQUENCY_KHZ = 4000;
const JLINK_COMMAND_TEMPLATE = NodePath.join('.eide', 'jlink.flasher.cmd.template');

function splitCommandLine(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: string | undefined;
    let started = false;
    for (const char of input) {
        if (quote !== undefined) {
            if (char === quote) {
                quote = undefined;
            } else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            started = true;
            continue;
        }
        if (/\s/.test(char)) {
            if (started) {
                args.push(current);
                current = '';
                started = false;
            }
            continue;
        }
        current += char;
        started = true;
    }
    if (quote !== undefined) {
        throw new ConfigError(`Unterminated quote in command line: ${input}`);
    }
    if (started) {
        args.push(current);
    }
    return args;
}

function resolveProjectPath(snapshot: ProjectSnapshot, value: string): string {
    const environment = createProjectEnvironment(snapshot, NodePath.join(snapshot.outDir, snapshot.target));
    const resolved = resolveEnvironmentVariables(value, environment);
    if (/\$\{[^}]+\}/.test(resolved)) {
        throw new ConfigError(`Unresolved environment variable in flash path: ${value}`);
    }
    return NodePath.isAbsolute(resolved)
        ? NodePath.resolve(resolved)
        : NodePath.resolve(snapshot.projectPath, resolved);
}

function defaultArtifact(snapshot: ProjectSnapshot, uploader: FlashUploaderName): string {
    const extension = uploader === 'probe-rs' ? '.elf' : '.hex';
    return NodePath.resolve(
        snapshot.projectPath, snapshot.outDir, snapshot.target, snapshot.name + extension);
}

function parsePrograms(snapshot: ProjectSnapshot, raw: string): FlashProgram[] {
    const programs: FlashProgram[] = [];
    for (const item of raw.split(';')) {
        if (item.trim().length === 0) {
            continue;
        }
        const match = /^(.*?)(?:,(0x[0-9a-f]+))?$/i.exec(item.trim());
        if (!match || match[1].trim().length === 0) {
            throw new ConfigError(`Invalid flash program entry: ${item}`);
        }
        programs.push({ path: match[1].trim(), address: match[2] });
    }
    return programs;
}

function flashPrograms(
    snapshot: ProjectSnapshot, uploader: FlashUploaderName, environment: FlashEnvironment): FlashProgram[] {
    if (environment.eraseAll) {
        return [];
    }
    if (environment.artifact) {
        return parsePrograms(snapshot, environment.artifact).map(program => ({
            ...program,
            path: resolveProjectPath(snapshot, program.path)
        }));
    }
    const configured = snapshot.uploadConfig.bin;
    if (typeof configured === 'string' && configured.trim().length > 0) {
        return parsePrograms(snapshot, configured).map(program => ({
            ...program,
            path: resolveProjectPath(snapshot, program.path)
        }));
    }
    return [{ path: defaultArtifact(snapshot, uploader) }];
}

function executableFor(
    uploader: FlashUploaderName, environment: FlashEnvironment): string {
    if (environment.flasherExecutable) {
        return environment.flasherExecutable;
    }
    if (uploader === 'pyOCD') {
        return 'pyocd';
    }
    if (uploader === 'probe-rs') {
        return 'cargo-flash';
    }
    throw new ConfigError(`--flasher-exe is required for uploader '${uploader}'.`);
}

function jlinkInterface(value: unknown): JLinkInterface {
    switch (value) {
        case undefined:
        case null:
        case '':
        case 1:
        case '1':
        case 'SWD':
            return 'SWD';
        case 0:
        case '0':
        case 'JTAG':
            return 'JTAG';
        case 3:
        case '3':
        case 'FINE':
            return 'FINE';
        case 7:
        case '7':
        case 'cJTAG':
            return 'cJTAG';
        default:
            throw new ConfigError(`Invalid JLink interface: ${String(value)}`);
    }
}

function stlinkProtocol(value: unknown): STLinkProtocol {
    if (value === undefined || value === null || value === '' || value === 'SWD') {
        return 'SWD';
    }
    if (value === 'JTAG') {
        return 'JTAG';
    }
    throw new ConfigError(`Invalid STLink protocol: ${String(value)}`);
}

function probeProtocol(value: unknown): ProbeRSProtocol {
    if (value === undefined || value === null || value === '' || value === 'swd') {
        return 'swd';
    }
    if (value === 'jtag') {
        return 'jtag';
    }
    throw new ConfigError(`Invalid probe-rs protocol: ${String(value)}`);
}

function parseInteger(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        return parseInt(value, 10);
    }
    return undefined;
}

function optionBytes(snapshot: ProjectSnapshot, value: unknown): string[] | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }
    const path = resolveProjectPath(snapshot, value);
    if (!fs.existsSync(path)) {
        return undefined;
    }
    const config = ini.parse(fs.readFileSync(path, 'utf8'));
    const entries: string[] = [];
    for (const key of Object.keys(config)) {
        entries.push(`${key}=${config[key]}`);
    }
    return entries.length > 0 ? entries : undefined;
}

function stlinkVariant(executable: string): STLinkCLIVariant {
    return NodePath.basename(executable).toLowerCase().startsWith('st-link_cli')
        ? 'stlink-cli'
        : 'cube-programmer';
}

function buildRequest(
    snapshot: ProjectSnapshot,
    uploader: FlashUploaderName,
    environment: FlashEnvironment,
    executable: string,
    programs: FlashProgram[]
): FlashRequest {
    const config = snapshot.uploadConfig;
    const base = {
        programs,
        address: typeof config.baseAddr === 'string' && config.baseAddr.length > 0
            ? config.baseAddr
            : undefined,
        eraseAll: environment.eraseAll,
        verify: environment.verify,
        timeoutMs: environment.timeoutMs,
        cwd: snapshot.projectPath,
        env: process.env
    };

    switch (uploader) {
        case 'JLink': {
            const device = String(config.cpuInfo?.cpuName || '');
            if (device.length === 0 || device === 'null') {
                throw new ConfigError('JLink device is not configured (cpuInfo.cpuName).');
            }
            const templateFile = NodePath.join(snapshot.projectPath, JLINK_COMMAND_TEMPLATE);
            const commandTemplate = fs.existsSync(templateFile)
                ? resolveEnvironmentVariables(
                    fs.readFileSync(templateFile, 'utf8'),
                    createProjectEnvironment(snapshot, NodePath.join(snapshot.outDir, snapshot.target)))
                : undefined;
            return {
                ...base,
                uploader,
                options: {
                    executable,
                    device,
                    interface: jlinkInterface(config.proType),
                    speedKhz: parseInteger(config.speed) ?? DEFAULT_JLINK_SPEED_KHZ,
                    extraArgs: splitCommandLine(String(config.otherCmds || '')),
                    commandTemplate
                }
            };
        }
        case 'OpenOCD':
            return {
                ...base,
                uploader,
                options: {
                    executable,
                    interfaceConfig: String(config.interface || ''),
                    targetConfig: String(config.target || ''),
                    searchDir: snapshot.projectPath
                }
            };
        case 'pyOCD': {
            const configFile = typeof config.config === 'string' && config.config.trim().length > 0
                ? resolveProjectPath(snapshot, config.config)
                : undefined;
            return {
                ...base,
                uploader,
                options: {
                    executable,
                    target: String(config.targetName || ''),
                    configFile: configFile && fs.existsSync(configFile) ? configFile : undefined,
                    frequency: typeof config.speed === 'string' ? config.speed : undefined,
                    extraArgs: splitCommandLine(String(config.otherCmds || ''))
                }
            };
        }
        case 'STLink': {
            const loader = typeof config.elFile === 'string' && config.elFile !== 'None'
                ? resolveProjectPath(snapshot, config.elFile.replace(
                    '<stlink>', NodePath.join(NodePath.dirname(executable), 'ExternalLoader')))
                : undefined;
            return {
                ...base,
                uploader,
                options: {
                    executable,
                    variant: stlinkVariant(executable),
                    protocol: stlinkProtocol(config.proType),
                    frequencyKhz: parseInteger(config.speed) ?? DEFAULT_STLINK_FREQUENCY_KHZ,
                    resetMode: typeof config.resetMode === 'string' ? config.resetMode : 'default',
                    runAfterProgram: config.runAfterProgram !== false,
                    externalLoader: loader,
                    optionBytes: optionBytes(snapshot, config.optionBytes),
                    extraArgs: splitCommandLine(String(config.otherCmds || ''))
                }
            };
        }
        case 'probe-rs':
            return {
                ...base,
                uploader,
                options: {
                    executable,
                    chip: String(config.target || ''),
                    protocol: probeProtocol(config.protocol),
                    speedKhz: parseInteger(config.speed) || undefined,
                    workDir: snapshot.projectPath,
                    extraArgs: splitCommandLine(String(config.otherOptions || ''))
                }
            };
        default:
            throw new ConfigError(`'${uploader}' is not supported by the headless flash layer.`);
    }
}

export function createFlashPlan(
    snapshot: ProjectSnapshot, environment: FlashEnvironment): FlashPlan {
    const uploader = snapshot.uploader as FlashUploaderName;
    if (!uploader) {
        throw new ConfigError('Project target has no uploader configured.');
    }
    const executable = executableFor(uploader, environment);
    const request = buildRequest(
        snapshot, uploader, environment, executable, flashPrograms(snapshot, uploader, environment));
    return { uploader, request, command: buildFlashCommand(request) };
}
