import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs';
import * as NodePath from 'path';
import { NodeProcessRunner } from '../core/process_runner';
import { StderrLogger } from '../core/logger';
import { bundledResourcesDir } from '../headless/package_paths';
import { createHeadlessToolExecutor, HeadlessToolOptions } from './headless_tools';
import { createMcpServer } from './mcp_proxy_tools';

const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_FLASH_TIMEOUT_MS = 2 * 60 * 1000;

const usage = [
    'Usage: eide-mcp --project <dir> [options]',
    '',
    'Options:',
    '  -p, --project <dir>       Project root (repeatable)',
    '  -t, --target <name>       Active build target',
    '      --resources <dir>     EIDE resources directory (default: bundled res folder)',
    '      --extension-root <dir> Extension root (default: parent of --resources)',
    '      --toolchain-path <dir> Toolchain installation directory (optional with xpack)',
    '      --settings <file>     JSON file with EIDE.* settings overrides',
    '      --flasher-exe <path>  Flash tool executable',
    '      --gdb <path>          GDB executable (default: arm-none-eabi-gdb)',
    '      --build-timeout <ms>  Build timeout (default: 1800000)',
    '      --flash-timeout <ms>  Flash timeout (default: 120000)',
    '      --print-skill        Print the bundled MCP skill and exit',
    '  -h, --help                Show this help'
].join('\n');

class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

function readValue(argv: string[], index: number, option: string): string {
    const value = argv[index + 1];
    if (value === undefined) {
        throw new UsageError(`Option '${option}' requires a value.`);
    }
    return value;
}

function readTimeout(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new UsageError(`Invalid ${name}: ${value}`);
    }
    return parsed;
}

interface ServerArguments {
    projectPaths: string[];
    target?: string;
    resourcesDir: string;
    extensionRoot?: string;
    toolchainPath?: string;
    settingsFile?: string;
    flasherExecutable?: string;
    gdbPath?: string;
    buildTimeoutMs: number;
    flashTimeoutMs: number;
}

function printSkill(): number {
    const candidates = [
        NodePath.resolve(__dirname, '..', 'skills', 'eide-mcp-tools', 'SKILL.md'),
        NodePath.resolve(__dirname, '..', 'docs', 'skills', 'eide-mcp-tools', 'SKILL.md')
    ];
    const skillPath = candidates.find(candidate => fs.existsSync(candidate));
    if (!skillPath) {
        throw new Error(`MCP skill not found. Tried:\n${candidates.join('\n')}`);
    }
    process.stdout.write(fs.readFileSync(skillPath));
    return 0;
}

function parseArguments(argv: string[]): ServerArguments | undefined {
    const projectPaths: string[] = [];
    let target: string | undefined;
    let resourcesDir: string | undefined;
    let extensionRoot: string | undefined;
    let toolchainPath: string | undefined;
    let settingsFile: string | undefined;
    let flasherExecutable: string | undefined;
    let gdbPath: string | undefined;
    let buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS;
    let flashTimeoutMs = DEFAULT_FLASH_TIMEOUT_MS;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--print-skill':
                return undefined;
            case '-h':
            case '--help':
                return undefined;
            case '-p':
            case '--project':
                projectPaths.push(readValue(argv, i, arg));
                i++;
                break;
            case '-t':
            case '--target':
                target = readValue(argv, i, arg);
                i++;
                break;
            case '--resources':
                resourcesDir = readValue(argv, i, arg);
                i++;
                break;
            case '--extension-root':
                extensionRoot = readValue(argv, i, arg);
                i++;
                break;
            case '--toolchain-path':
                toolchainPath = readValue(argv, i, arg);
                i++;
                break;
            case '--settings':
                settingsFile = readValue(argv, i, arg);
                i++;
                break;
            case '--flasher-exe':
                flasherExecutable = readValue(argv, i, arg);
                i++;
                break;
            case '--gdb':
                gdbPath = readValue(argv, i, arg);
                i++;
                break;
            case '--build-timeout':
                buildTimeoutMs = readTimeout(readValue(argv, i, arg), 'build timeout');
                i++;
                break;
            case '--flash-timeout':
                flashTimeoutMs = readTimeout(readValue(argv, i, arg), 'flash timeout');
                i++;
                break;
            default:
                throw new UsageError(`Unknown option: ${arg}`);
        }
    }

    if (projectPaths.length === 0) {
        throw new UsageError("Missing required option: '--project'.");
    }
    if (!resourcesDir) {
        resourcesDir = bundledResourcesDir();
    }
    return {
        projectPaths,
        target,
        resourcesDir,
        extensionRoot,
        toolchainPath,
        settingsFile,
        flasherExecutable,
        gdbPath,
        buildTimeoutMs,
        flashTimeoutMs
    };
}

export async function main(argv: string[]): Promise<number> {
    if (argv.includes('--print-skill')) {
        return printSkill();
    }
    let args: ServerArguments | undefined;
    try {
        args = parseArguments(argv);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage}\n`);
        return 3;
    }
    if (!args) {
        process.stdout.write(usage + '\n');
        return 0;
    }

    const options: HeadlessToolOptions = {
        ...args,
        runner: new NodeProcessRunner(),
        logger: new StderrLogger()
    };
    const server = createMcpServer(
        createHeadlessToolExecutor(options), {
            debugTools: true,
            headless: true,
            singleProject: args.projectPaths.length === 1
        });
    await server.connect(new StdioServerTransport());
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then(
        code => { process.exitCode = code; },
        error => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 4;
        }
    );
}
