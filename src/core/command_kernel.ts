import { cleanProject } from './build_service';
import { createFlashPlan } from './flash/plan';
import { ProcessFlashService } from './flash/service';
import { loadProjectSnapshot } from './project_snapshot';
import type { FlashResult } from './flash/types';
import type { FlashProgram } from './flash/types';
import type { ProcessRunner } from './adapters';
import { CliUsageError } from '../cli/args';
import { BuildExecutionError } from './build_service';
import { FlashBuildError } from './flash/builders';

export type CommandName = 'clean' | 'flash';
export type FailureKind = 'timeout' | 'signal' | 'build';
export type ErrorKind = 'usage' | 'config' | 'tool' | 'internal';

export interface CommandError {
    kind: ErrorKind;
    name: string;
    message: string;
}

export type CommandSuccess<T> = T & {
    success: true;
    command: CommandName;
};

export type CommandFailure = {
    success: false;
    command: string | null;
    failureKind?: FailureKind;
    error: CommandError;
};

export type CommandResult<T> = CommandSuccess<T> | CommandFailure;

export interface ProjectCommandRequest {
    projectPath: string;
    workspaceFile?: string;
    target?: string;
}

export interface CleanCommandRequest extends ProjectCommandRequest {
    command: 'clean';
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

export function classifyError(error: unknown, command: CommandName | string | null): CommandFailure {
    const err = error instanceof Error ? error : new Error(String(error));
    const kind: ErrorKind = err instanceof CliUsageError
        ? 'usage'
        : err instanceof ConfigError || err instanceof FlashBuildError
            ? 'config'
            : err instanceof BuildExecutionError ? 'tool' : 'internal';
    return {
        success: false,
        command,
        error: { kind, name: err.name, message: err.message }
    };
}

export interface CommandKernel {
    clean(request: CleanCommandRequest): Promise<CommandResult<{ message: string }>>;
    flash(request: FlashCommandRequest): Promise<CommandResult<FlashResultData>>;
}

export interface FlashCommandRequest extends ProjectCommandRequest {
    command: 'flash';
    flasherExecutable?: string;
    timeoutMs?: number;
    eraseAll?: boolean;
    verify?: boolean;
    artifact?: string;
    dryRun?: boolean;
}

export interface FlashResultData {
    uploader: string;
    invocation?: {
        executable: string;
        args: string[];
        script?: FlashResultScript;
    };
    verify?: boolean;
    eraseAll?: boolean;
    programs?: FlashProgram | FlashProgram[];
    code?: FlashResult['code'];
    stdout?: string;
    stderr?: string;
    verified?: boolean;
}

export interface FlashResultScript {
    contents: string;
    extension: string;
}

export interface CommandKernelOptions {
    runner: ProcessRunner;
}

function cleanFailure(error: unknown): CommandFailure {
    return classifyError(error, 'clean');
}

export function createCommandKernel(options: CommandKernelOptions): CommandKernel {
    return {
        async clean(request) {
            try {
                const result = cleanProject(request);
                return {
                    success: true,
                    command: 'clean',
                    message: result.message ?? ''
                };
            } catch (error) {
                return cleanFailure(error);
            }
        },
        async flash(request) {
            try {
                const snapshot = loadProjectSnapshot(
                    request.workspaceFile ?? request.projectPath, request.target);
                const plan = createFlashPlan(snapshot, {
                    flasherExecutable: request.flasherExecutable,
                    timeoutMs: request.timeoutMs ?? 120_000,
                    eraseAll: request.eraseAll ?? false,
                    verify: request.verify ?? false,
                    artifact: request.artifact
                });
                if (request.dryRun) {
                    return {
                        success: true,
                        command: 'flash',
                        uploader: plan.uploader,
                        invocation: {
                            executable: plan.command.executable,
                            args: plan.command.args,
                            script: plan.command.script
                        },
                        verify: plan.request.verify,
                        eraseAll: plan.request.eraseAll,
                        programs: plan.request.programs
                    };
                }
                const result = await new ProcessFlashService(options.runner).flash(plan.request);
                if (!result.success && (result.code === 'not_supported' || result.code === 'invalid_request')) {
                    throw new ConfigError(result.reason ?? `Flash request failed: ${result.code}`);
                }
                return {
                    success: result.success,
                    command: 'flash',
                    uploader: plan.uploader,
                    code: result.code,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    verified: result.verified
                } as CommandSuccess<FlashResultData>;
            } catch (error) {
                return classifyError(error, 'flash');
            }
        }
    };
}
