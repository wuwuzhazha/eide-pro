#!/usr/bin/env node
import { BuildExecutionError, cleanProject } from '../core/build_service';
import { EideBuildService } from '../headless/build_service';
import { createFlashPlan } from '../core/flash/plan';
import { ProcessFlashService } from '../core/flash/service';
import { StderrLogger } from '../core/logger';
import { NodeProcessRunner } from '../core/process_runner';
import { loadProjectSnapshot } from '../core/project_snapshot';
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
    kind: 'usage' | 'config' | 'internal'
): unknown {
    return {
        success: false,
        command,
        error: { name: error.name, message: error.message, kind }
    };
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
            const result = cleanProject(toRequest(options));
            writeJson(io, { command, ...result });
            return result.success ? 0 : 2;
        }

        if (command === 'flash') {
            const snapshot = loadProjectSnapshot(
                options.workspaceFile ?? options.projectPath, options.target);
            const plan = createFlashPlan(snapshot, {
                flasherExecutable: options.flasherExecutable,
                timeoutMs: options.timeoutMs,
                eraseAll: options.eraseAll,
                verify: options.verify,
                artifact: options.artifact
            });
            if (options.dryRun) {
                writeJson(io, {
                    success: true,
                    command: 'flash',
                    uploader: plan.uploader,
                    executable: plan.command.executable,
                    args: plan.command.args,
                    script: plan.command.script,
                    verify: plan.request.verify,
                    eraseAll: plan.request.eraseAll,
                    programs: plan.request.programs
                });
                return 0;
            }
            const result = await new ProcessFlashService(new NodeProcessRunner()).flash(plan.request);
            writeJson(io, { command, uploader: plan.uploader, ...result });
            if (result.success) {
                return 0;
            }
            return result.code === 'not_supported' || result.code === 'invalid_request' ? 3 : 2;
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
            return 0;
        }

        const result = await service.build(request);
        writeJson(io, { command, ...result });
        return result.success ? 0 : 2;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        io.stderr(`error: ${err.message}\n`);
        if (err instanceof CliUsageError) {
            io.stderr(cliHelp + '\n');
            writeJson(io, errorPayload(command || null, err, 'usage'));
            return 3;
        }
        const kind = err instanceof BuildExecutionError ? 'internal' : 'config';
        writeJson(io, errorPayload(command || null, err, kind));
        return kind === 'internal' ? 4 : 3;
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
