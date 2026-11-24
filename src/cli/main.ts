#!/usr/bin/env node
import { classifyError, createCommandKernel } from '../core/command_kernel';
import { EideBuildService } from '../headless/build_service';
import { StderrLogger } from '../core/logger';
import { NodeProcessRunner } from '../core/process_runner';
import { BuildRequest } from '../core/types';
import { bundledResourcesDir } from '../headless/package_paths';
import { createProject } from '../headless/project_creator';
import { CliOptions, CliUsageError, cliHelp, parseCliArgs } from './args';

export interface CliIo {
    stdout(text: string): void;
    stderr(text: string): void;
}

export const processIo: CliIo = {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text)
};

function usageError(message: string): CliUsageError {
    return new CliUsageError(message);
}

function toRequest(options: CliOptions): BuildRequest {
    return {
        projectPath: options.projectPath,
        workspaceFile: options.workspaceFile,
        target: options.target,
        mode: options.mode,
        dryRun: options.dryRun,
        overrides: options.overrides
    };
}

export function writeJson(io: CliIo, value: unknown): void {
    io.stdout(JSON.stringify(value) + '\n');
}

export function errorPayload(
    command: string | null,
    error: Error,
    kind: 'usage' | 'config' | 'tool' | 'internal'
): unknown {
    const failure = classifyError(error, command);
    return {
        ...failure,
        error: { ...failure.error, kind }
    };
}

function exitCodeFor(result: unknown): number {
    const value = result as { success?: boolean; error?: { kind?: string } };
    if (value.success === true) {
        return 0;
    }
    if (value.error) {
        return value.error.kind === 'usage' || value.error.kind === 'config' ? 3 : 4;
    }
    return value.success === false ? 2 : 3;
}

export async function main(argv: string[], io: CliIo = processIo): Promise<number> {
    let command = '';
    try {
        const parsed = parseCliArgs(argv);
        if (parsed.kind === 'help') {
            io.stdout(cliHelp + '\n');
            return 0;
        }
        if (parsed.kind === 'create') {
            command = 'create';
            const result = createProject({
                name: parsed.options.name,
                outputDir: parsed.options.outputDir,
                template: parsed.options.template,
                resourcesDir: parsed.options.resourcesDir ?? bundledResourcesDir(),
                projectName: parsed.options.projectName
            });
            writeJson(io, result);
            return 0;
        }
        const options = parsed.options;
        command = options.command;
        if (command === 'clean' && options.dryRun) {
            throw usageError('--dry-run is not supported for clean.');
        }

        if (command === 'clean') {
            const kernel = createCommandKernel({ runner: new NodeProcessRunner() });
            const result = await kernel.clean({
                command: 'clean',
                projectPath: options.projectPath,
                workspaceFile: options.workspaceFile,
                target: options.target
            });
            writeJson(io, result);
            return exitCodeFor(result);
        }

        if (command === 'flash') {
            const kernel = createCommandKernel({ runner: new NodeProcessRunner() });
            const result = await kernel.flash({
                command: 'flash',
                projectPath: options.projectPath,
                workspaceFile: options.workspaceFile,
                target: options.target,
                flasherExecutable: options.flasherExecutable,
                timeoutMs: options.timeoutMs,
                eraseAll: options.eraseAll,
                verify: options.verify,
                artifact: options.artifact,
                dryRun: options.dryRun
            });
            writeJson(io, result);
            return exitCodeFor(result);
        }

        const service = new EideBuildService({
            resourcesDir: options.resourcesDir ?? bundledResourcesDir(),
            extensionRoot: options.extensionRoot,
            toolchainPath: options.toolchainPath,
            settingsFile: options.settingsFile,
            builderThreads: options.threads,
            runner: new NodeProcessRunner(),
            timeoutMs: options.timeoutMs,
            logger: new StderrLogger()
        });
        const request = toRequest(options);

        if (command === 'plan' || options.dryRun) {
            const plan = await service.plan(request);
            writeJson(io, {
                success: true,
                command: 'plan',
                configHash: plan.configHash,
                outDir: plan.outDir,
                builder: plan.file,
                args: plan.args,
                paramsFile: plan.paramsPath,
                params: plan.params
            });
            return exitCodeFor({ success: true });
        }

        const result = await service.build(request);
        writeJson(io, { command, ...result });
        return exitCodeFor(result);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        io.stderr(`error: ${err.message}\n`);
        if (err instanceof CliUsageError) {
            io.stderr(cliHelp + '\n');
            writeJson(io, errorPayload(command || null, err, 'usage'));
            return 3;
        }
        const failure = classifyError(err, command || null);
        writeJson(io, failure);
        return exitCodeFor(failure);
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then(
        code => { process.exitCode = code; },
        error => {
            const err = error instanceof Error ? error : new Error(String(error));
            process.stderr.write(`${err.message}\n`);
            writeJson(processIo, errorPayload(null, err, 'internal'));
            process.exitCode = 4;
        }
    );
}
