import * as fs from 'fs';
import * as NodePath from 'path';
import { randomUUID } from 'node:crypto';
import type { AbstractProject } from '../EIDEProject';
import type { BuilderOptions } from '../EIDETypeDefine';
import type { BuildOptions } from '../CodeBuilder';
import { Logger, ProcessResult, ProcessRunner } from '../core/adapters';
import { BuildProblem, parseToolchainProblems } from '../core/problems';
import { BuildExecutionError } from '../core/build_service';
import { collectArtifacts, createConfigHash, writeBuildManifest } from '../core/build_manifest';
import { ProcessTimeoutError } from '../core/process_runner';
import { BuildPlan, BuildService, CleanResult } from '../core/services';
import { BuildRequest, BuildResult, EffectiveBuildConfig } from '../core/types';
import { detectBuildStage, makeLogTail, parseMemoryUsage } from '../BuildReport';
import { HeadlessHostOptions, openHeadlessProject } from './host';

export interface EideBuildServiceOptions {
    resourcesDir: string;
    extensionRoot?: string;
    toolchainPath?: string;
    settingsFile?: string;
    builderThreads?: number;
    runner: ProcessRunner;
    timeoutMs: number;
    logger?: Logger;
}

interface BuildInvocation {
    file: string;
    args: string[];
    paramsPath: string;
}

export type ProjectRequest = Pick<BuildRequest, 'projectPath' | 'workspaceFile' | 'target'>;

function readText(path: string): string | undefined {
    try {
        return fs.readFileSync(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

function builderOptionsApi(): typeof import('../mcp/mcp_builder_opts_validate') {
    return require('../mcp/mcp_builder_opts_validate') as
        typeof import('../mcp/mcp_builder_opts_validate');
}

function optionString(options: { [key: string]: any }, path: string[]): string {
    let value: any = options;
    for (const key of path) {
        value = value?.[key];
    }
    return typeof value === 'string' ? value : '';
}

function effectiveConfig(
    params: { [key: string]: any }, outDir: string): EffectiveBuildConfig {
    return {
        target: String(params.target ?? ''),
        toolchain: String(params.toolchain ?? ''),
        outDir,
        defines: Array.isArray(params.defines) ? params.defines : [],
        includeDirs: Array.isArray(params.incDirs) ? params.incDirs : [],
        cFlags: optionString(params.options || {}, ['c/cpp-compiler', 'C_FLAGS']),
        cxxFlags: optionString(params.options || {}, ['c/cpp-compiler', 'CXX_FLAGS']),
        asmFlags: optionString(params.options || {}, ['asm-compiler', 'ASM_FLAGS']),
        ldFlags: optionString(params.options || {}, ['linker', 'LD_FLAGS'])
    };
}

function toProblems(
    project: AbstractProject, toolchain: string, compilerLog: string | undefined): BuildProblem[] {
    if (compilerLog === undefined) {
        return [];
    }
    const root = project.getRootDir().path;
    return parseToolchainProblems(toolchain, compilerLog).map(problem => ({
        file: NodePath.isAbsolute(problem.file)
            ? problem.file
            : NodePath.resolve(root, problem.file),
        line: problem.line,
        column: problem.column,
        severity: problem.severity,
        code: problem.code,
        message: problem.message
    }));
}

function cleanOutputDir(project: AbstractProject): CleanResult {
    const root = project.getRootDir().path;
    const outDir = project.getOutputFolder().path;
    const relative = NodePath.relative(root, outDir);
    if (relative.length === 0 || relative === '..' || relative.startsWith(`..${NodePath.sep}`)
        || NodePath.isAbsolute(relative)) {
        throw new Error(`Refusing to clean output directory outside project: ${outDir}`);
    }
    if (!fs.existsSync(outDir)) {
        return { success: true, message: 'Output directory does not exist.' };
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    return { success: true, message: `Removed ${outDir}` };
}

export class EideBuildService implements BuildService {
    constructor(private readonly options: EideBuildServiceOptions) {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
            throw new Error(`Invalid build timeout: ${options.timeoutMs}`);
        }
    }

    async plan(request: BuildRequest): Promise<BuildPlan> {
        const session = await openHeadlessProject(this.hostOptions(request));
        try {
            const invocation = this.invocation(session.project, request);
            const params = JSON.parse(fs.readFileSync(invocation.paramsPath, 'utf8'));
            return {
                params,
                paramsPath: invocation.paramsPath,
                file: invocation.file,
                args: invocation.args,
                outDir: session.project.getOutputFolder().path,
                configHash: createConfigHash(params, request)
            };
        } finally {
            session.close();
        }
    }

    async build(request: BuildRequest): Promise<BuildResult> {
        const session = await openHeadlessProject(this.hostOptions(request));
        const project = session.project;
        try {
            project.Save(true);
            const invocation = this.invocation(project, request);
            const params = JSON.parse(fs.readFileSync(invocation.paramsPath, 'utf8'));
            const buildId = randomUUID();
            const configHash = createConfigHash(params, request);
            const outDir = project.getOutputFolder().path;
            const compilerLogPath = NodePath.join(outDir, 'compiler.log');
            fs.rmSync(compilerLogPath, { force: true });
            this.options.logger?.info(
                `Build ${buildId}: ${invocation.file} ${invocation.args.join(' ')}`);

            let processResult: ProcessResult;
            let timeoutError: string | undefined;
            try {
                processResult = await this.options.runner.run(
                    invocation.file, invocation.args, {
                        cwd: project.getRootDir().path,
                        timeoutMs: this.options.timeoutMs,
                        env: process.env
                    });
            } catch (error) {
                if (!(error instanceof ProcessTimeoutError)) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new BuildExecutionError(`Failed to start builder: ${message}`, error);
                }
                processResult = {
                    code: null,
                    stdout: error.stdout,
                    stderr: error.stderr
                };
                timeoutError = error.message;
            }

            const compilerLog = readText(compilerLogPath);
            const processLog = [processResult.stdout, processResult.stderr]
                .filter(text => text.length > 0)
                .join('\n');
            const logText = compilerLog ?? processLog;
            const toolchain = project.getToolchain().name;
            const problems = toProblems(project, toolchain, compilerLog);
            const success = processResult.code === 0
                && !problems.some(problem => problem.severity === 'error');
            let analysisError = timeoutError;
            if (compilerLog === undefined && processResult.code !== 0 && analysisError === undefined) {
                analysisError = `Build log not found: ${compilerLogPath}`;
            }
            if (!success && analysisError === undefined && processResult.code === null) {
                analysisError = 'Builder process terminated by a signal.';
            }
            const stage = detectBuildStage(logText, success);
            const artifacts = success ? collectArtifacts(outDir) : [];
            const compileCommandsPath = NodePath.join(outDir, 'compile_commands.json');
            const compileCommands = fs.existsSync(compileCommandsPath)
                ? compileCommandsPath
                : undefined;

            writeBuildManifest(outDir, {
                buildId,
                configHash,
                createdAt: new Date().toISOString(),
                request,
                target: String(params.target ?? ''),
                toolchain: String(params.toolchain ?? toolchain),
                outDir,
                defines: Array.isArray(params.defines) ? params.defines : [],
                includeDirs: Array.isArray(params.incDirs) ? params.incDirs : [],
                success,
                artifacts,
                compileCommands
            });

            return {
                success,
                buildId,
                configHash,
                stage,
                problems,
                memory: parseMemoryUsage(logText),
                artifacts,
                compileCommands,
                effectiveConfig: effectiveConfig(params, outDir),
                logTail: success ? undefined : makeLogTail(logText),
                analysisError
            };
        } finally {
            session.close();
        }
    }

    async clean(request: BuildRequest): Promise<CleanResult> {
        const session = await openHeadlessProject(this.hostOptions(request));
        try {
            return cleanOutputDir(session.project);
        } finally {
            session.close();
        }
    }

    async getBuilderOptionsSchema(request: ProjectRequest): Promise<object> {
        const session = await openHeadlessProject(this.hostOptions(request));
        try {
            return builderOptionsApi().loadBuilderOptionsSchema(session.project);
        } finally {
            session.close();
        }
    }

    async getBuilderOptions(request: ProjectRequest): Promise<BuilderOptions> {
        const session = await openHeadlessProject(this.hostOptions(request));
        try {
            return session.project.getBuilderOptions();
        } finally {
            session.close();
        }
    }

    async setBuilderOptions(request: ProjectRequest, options: unknown): Promise<void> {
        const session = await openHeadlessProject(this.hostOptions(request));
        try {
            const validation = builderOptionsApi().validateBuilderOptions(
                session.project, options);
            if (validation) {
                throw new Error(`Builder options validation failed:\n${validation}`);
            }
            session.project.GetConfiguration().toolchainConfigModel.setOptions(
                options as BuilderOptions);
            session.project.onBuilderConfigChanged();
            session.project.Save(true);
        } finally {
            session.close();
        }
    }

    private hostOptions(request: ProjectRequest): HeadlessHostOptions {
        return {
            projectPath: request.projectPath,
            workspaceFile: request.workspaceFile,
            target: request.target,
            resourcesDir: this.options.resourcesDir,
            extensionRoot: this.options.extensionRoot,
            toolchainPath: this.options.toolchainPath,
            settingsFile: this.options.settingsFile,
            builderThreads: this.options.builderThreads
        };
    }

    private invocation(project: AbstractProject, request: BuildRequest): BuildInvocation {
        const { CodeBuilder } = require('../CodeBuilder') as typeof import('../CodeBuilder');
        const options: BuildOptions = {
            notRebuild: request.mode !== 'rebuild',
            otherArgs: ['--no-color'],
            overrides: request.overrides
        };
        const invocation = CodeBuilder.NewBuilder(project).getBuildInvocation(options);
        if (!invocation) {
            throw new Error('Builder did not produce a build command.');
        }
        return invocation;
    }
}
