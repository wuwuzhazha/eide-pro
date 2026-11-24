import { cleanProject } from './build_service';

export type CommandName = 'clean';
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

export interface CleanCommandRequest {
    projectPath: string;
    workspaceFile?: string;
    target?: string;
    command: 'clean';
}

export interface CommandKernel {
    clean(request: CleanCommandRequest): Promise<CommandResult<{ message: string }>>;
}

export function classifyError(error: unknown, command: CommandName | string | null): CommandFailure {
    const err = error instanceof Error ? error : new Error(String(error));
    const kind: ErrorKind = err.name === 'CliUsageError'
        ? 'usage'
        : err.name === 'BuildExecutionError' ? 'tool' : 'config';
    return {
        success: false,
        command,
        error: { kind, name: err.name, message: err.message }
    };
}

function cleanFailure(error: unknown): CommandFailure {
    return classifyError(error, 'clean');
}

export function createCommandKernel(): CommandKernel {
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
        }
    };
}
