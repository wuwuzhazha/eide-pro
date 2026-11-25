import { BuildMode, BuildOverrides } from '../core/types';

export type CliCommandName = 'build' | 'rebuild' | 'clean' | 'plan' | 'flash' | 'create';

export interface CliOptions {
    command: CliCommandName;
    projectPath: string;
    workspaceFile?: string;
    target?: string;
    mode?: BuildMode;
    dryRun: boolean;
    timeoutMs: number;
    threads?: number;
    resourcesDir?: string;
    extensionRoot?: string;
    toolchainPath?: string;
    settingsFile?: string;
    overrides: BuildOverrides;
    flasherExecutable?: string;
    eraseAll: boolean;
    verify?: boolean;
    artifact?: string;
}

export interface CreateCliOptions {
    command: 'create';
    name: string;
    outputDir: string;
    template: string;
    resourcesDir?: string;
    projectName?: string;
}

export type ParsedCli =
    | { kind: 'help' }
    | { kind: 'version' }
    | { kind: 'run'; options: CliOptions }
    | { kind: 'create'; options: CreateCliOptions };

export const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_FLASH_TIMEOUT_MS = 2 * 60 * 1000;

export { CliUsageError } from '../core/errors';
import { CliUsageError } from '../core/errors';

export const cliHelp = [
    'Usage:',
    '  eide-cli <build|rebuild|clean|plan|flash> --project <path> [options]',
    '  eide-cli create --name <name> --template <template> [--output <dir>]',
    '',
    'Build/flash options:',
    '  -p, --project <path>         Project root directory (required)',
    '      --workspace <file>       .code-workspace file',
    '  -t, --target <name>          Build target (defaults to project active target)',
    '      --mode <mode>            incremental | rebuild',
    '      --dry-run                Generate build plan without executing',
    '  -D, --define <NAME[=VAL]>    Add a preprocessor define (repeatable)',
    '      --include <dir>          Add an include directory (repeatable)',
    '      --lib <dir>              Add a library directory (repeatable)',
    '      --cflag <flags>          Append C compiler flags (repeatable)',
    '      --cxxflag <flags>        Append C++ compiler flags (repeatable)',
    '      --asmflag <flags>        Append assembler flags (repeatable)',
    '      --ldflag <flags>         Append linker flags (repeatable)',
    '      --resources <dir>        EIDE resources directory (default: bundled res folder)',
    '      --extension-root <dir>   Extension root (default: parent of --resources)',
    '      --toolchain-path <dir>   Toolchain installation directory',
    '      --settings <file>        JSON file with EIDE.* settings overrides',
    '      --timeout <ms>           Operation timeout (default: build 1800000, flash 120000)',
    '      --threads <n>            Build worker threads (default: EIDE setting)',
    '      --flasher-exe <path>     Flash tool executable',
    '      --erase-all              Erase the whole chip before flashing',
    '      --verify                 Verify after flashing (already the default for tools that can verify)',
    '      --no-verify              Skip post-flash verification; rejected for JLink, which always verifies',
    '      --artifact <path[,addr]> Override the flash artifact (default: project output)',
    '',
    'Create options:',
    '      --name <name>            New project folder name',
    '      --template <name>        Built-in template name (see docs/headless.md)',
    '      --output <dir>           Parent directory for the new project (default: .)',
    '      --project-name <name>    Display name (default: --name)',
    '  -v, --version                Print the CLI version',
    '  -h, --help                   Show this help'
].join('\n');

function readValue(argv: string[], index: number, option: string): string {
    const value = argv[index + 1];
    if (value === undefined) {
        throw new CliUsageError(`Option '${option}' requires a value.`);
    }
    return value;
}

function appendFlag(current: string | undefined, value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new CliUsageError('Flag values cannot be empty.');
    }
    return current && current.length > 0 ? `${current} ${trimmed}` : trimmed;
}

function parseCreateArgs(argv: string[]): ParsedCli {
    let name: string | undefined;
    let template: string | undefined;
    let outputDir = '.';
    let resourcesDir: string | undefined;
    let projectName: string | undefined;

    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '-h':
            case '--help':
                return { kind: 'help' };
            case '--name':
                name = readValue(argv, i, arg);
                i++;
                break;
            case '--template':
                template = readValue(argv, i, arg);
                i++;
                break;
            case '--output':
                outputDir = readValue(argv, i, arg);
                i++;
                break;
            case '--resources':
                resourcesDir = readValue(argv, i, arg);
                i++;
                break;
            case '--project-name':
                projectName = readValue(argv, i, arg);
                i++;
                break;
            default:
                throw new CliUsageError(`Unknown option: ${arg}`);
        }
    }
    if (!name) {
        throw new CliUsageError('Missing required option: --name');
    }
    if (!template) {
        throw new CliUsageError('Missing required option: --template');
    }
    return {
        kind: 'create',
        options: { command: 'create', name, template, outputDir, resourcesDir, projectName }
    };
}

export function parseCliArgs(argv: string[]): ParsedCli {
    if (argv.length === 0) {
        throw new CliUsageError('Missing command.');
    }
    if (argv.includes('-v') || argv.includes('--version')) {
        return { kind: 'version' };
    }
    if (argv[0] === '-h' || argv[0] === '--help') {
        return { kind: 'help' };
    }
    const command = argv[0] as CliCommandName;
    if (!['build', 'rebuild', 'clean', 'plan', 'flash', 'create'].includes(command)) {
        throw new CliUsageError(`Unknown command: ${command}`);
    }
    if (command === 'create') {
        return parseCreateArgs(argv);
    }

    const overrides: BuildOverrides = {};
    let projectPath: string | undefined;
    let workspaceFile: string | undefined;
    let target: string | undefined;
    let mode: BuildMode | undefined = command === 'rebuild' ? 'rebuild' : undefined;
    let dryRun = command === 'plan';
    let timeoutMs = command === 'flash' ? DEFAULT_FLASH_TIMEOUT_MS : DEFAULT_BUILD_TIMEOUT_MS;
    let threads: number | undefined;
    let resourcesDir: string | undefined;
    let extensionRoot: string | undefined;
    let toolchainPath: string | undefined;
    let settingsFile: string | undefined;
    let flasherExecutable: string | undefined;
    let eraseAll = false;
    let verify: boolean | undefined;
    let verifyOption: '--verify' | '--no-verify' | undefined;
    let artifact: string | undefined;

    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '-h':
            case '--help':
                return { kind: 'help' };
            case '-v':
            case '--version':
                return { kind: 'version' };
            case '-p':
            case '--project':
                projectPath = readValue(argv, i, arg);
                i++;
                break;
            case '--workspace':
                workspaceFile = readValue(argv, i, arg);
                i++;
                break;
            case '-t':
            case '--target':
                target = readValue(argv, i, arg);
                i++;
                break;
            case '--mode': {
                const value = readValue(argv, i, arg);
                i++;
                if (value !== 'incremental' && value !== 'rebuild') {
                    throw new CliUsageError(`Invalid mode: ${value}`);
                }
                mode = value;
                break;
            }
            case '--dry-run':
                dryRun = true;
                break;
            case '-D':
            case '--define':
                (overrides.defines ??= []).push(readValue(argv, i, arg));
                i++;
                break;
            case '--include':
                (overrides.includeDirs ??= []).push(readValue(argv, i, arg));
                i++;
                break;
            case '--lib':
                (overrides.libDirs ??= []).push(readValue(argv, i, arg));
                i++;
                break;
            case '--cflag':
                overrides.cFlags = appendFlag(overrides.cFlags, readValue(argv, i, arg));
                i++;
                break;
            case '--cxxflag':
                overrides.cxxFlags = appendFlag(overrides.cxxFlags, readValue(argv, i, arg));
                i++;
                break;
            case '--asmflag':
                overrides.asmFlags = appendFlag(overrides.asmFlags, readValue(argv, i, arg));
                i++;
                break;
            case '--ldflag':
                overrides.ldFlags = appendFlag(overrides.ldFlags, readValue(argv, i, arg));
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
            case '--timeout': {
                const value = readValue(argv, i, arg);
                i++;
                const parsed = Number(value);
                if (!Number.isInteger(parsed) || parsed <= 0) {
                    throw new CliUsageError(`Invalid timeout: ${value}`);
                }
                timeoutMs = parsed;
                break;
            }
            case '--threads': {
                const value = readValue(argv, i, arg);
                i++;
                const parsed = Number(value);
                if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 256) {
                    throw new CliUsageError(`Invalid thread count: ${value}`);
                }
                threads = parsed;
                break;
            }
            case '--flasher-exe':
                flasherExecutable = readValue(argv, i, arg);
                i++;
                break;
            case '--erase-all':
                eraseAll = true;
                break;
            case '--verify':
            case '--no-verify':
                if (verifyOption !== undefined && verifyOption !== arg) {
                    throw new CliUsageError('--verify and --no-verify cannot be combined.');
                }
                verifyOption = arg;
                verify = arg === '--verify';
                break;
            case '--artifact':
                artifact = readValue(argv, i, arg);
                i++;
                break;
            default:
                throw new CliUsageError(`Unknown option: ${arg}`);
        }
    }

    if (!projectPath) {
        throw new CliUsageError('Missing required option: --project');
    }

    const flashOptionsUsed = flasherExecutable !== undefined || eraseAll
        || verify !== undefined || artifact !== undefined;
    if (command !== 'flash' && flashOptionsUsed) {
        throw new CliUsageError('Flash options require the flash command.');
    }
    if (command === 'flash') {
        if (mode !== undefined) {
            throw new CliUsageError('--mode is not supported for flash.');
        }
        if (threads !== undefined) {
            throw new CliUsageError('--threads is not supported for flash.');
        }
        if (Object.keys(overrides).length > 0) {
            throw new CliUsageError('Build overrides are not supported for flash.');
        }
        if (eraseAll && artifact !== undefined) {
            throw new CliUsageError('--artifact cannot be combined with --erase-all.');
        }
    }

    return {
        kind: 'run',
        options: {
            command,
            projectPath,
            workspaceFile,
            target,
            mode,
            dryRun,
            timeoutMs,
            threads,
            resourcesDir,
            extensionRoot,
            toolchainPath,
            settingsFile,
            overrides,
            flasherExecutable,
            eraseAll,
            verify,
            artifact
        }
    };
}
