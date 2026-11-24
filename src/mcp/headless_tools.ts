import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as NodePath from 'path';
import { BuildStatistics, queryCallgraph, summarizeStackUsage } from '../BuildStatistics';
import { EideBuildService, ProjectRequest } from '../headless/build_service';
import { validateBuildOverrides } from '../core/build_overrides';
import { createFlashPlan } from '../core/flash/plan';
import { ProcessFlashService } from '../core/flash/service';
import { Logger, ProcessRunner } from '../core/adapters';
import { loadProjectSnapshot } from '../core/project_snapshot';
import { BuildOverrides } from '../core/types';
import { MiSpawn } from '../core/debug/mi';
import { HeadlessDebugSession } from './headless_debug';
import { HeadlessProject } from './headless_project';
import { classifyError, createCommandKernel, CommandResult } from '../core/command_kernel';

const DEFAULT_TOOL_WATCHDOG_MS = 120_000;
const TOOL_TIMEOUT_GRACE_MS = 30_000;

export interface HeadlessToolExecutorRunner {
    execute(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface HeadlessToolOptions {
    projectPaths: string[];
    target?: string;
    resourcesDir: string;
    extensionRoot?: string;
    toolchainPath?: string;
    settingsFile?: string;
    builderThreads?: number;
    flasherExecutable?: string;
    buildTimeoutMs: number;
    flashTimeoutMs: number;
    runner: ProcessRunner;
    logger?: Logger;
    gdbPath?: string;
    debugSpawn?: MiSpawn;
    debugCommandTimeoutMs?: number;
    debugStopTimeoutMs?: number;
    toolWatchdogMs?: number;
    toolRunner?: HeadlessToolExecutorRunner;
}

function makeTextResult(success: boolean, message: string): CallToolResult {
    return {
        isError: !success,
        content: [{ type: 'text', text: message }]
    };
}

function makeJsonResult(data: unknown, isError = false): CallToolResult {
    return {
        isError,
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
    };
}

function makeEnvelopeResult(envelope: CommandResult<unknown>): CallToolResult {
    return makeJsonResult(envelope, !envelope.success);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toolWatchdogTimeout(tool: string, args: Record<string, unknown>, options: HeadlessToolOptions): number {
    if (options.toolWatchdogMs !== undefined) {
        return options.toolWatchdogMs;
    }
    const ownTimeout = tool === 'eide_build' || tool === 'eide_rebuild'
        ? options.buildTimeoutMs
        : tool === 'eide_flash' ? options.flashTimeoutMs
            : tool.startsWith('eide_debug_') && typeof args.stopTimeoutMs === 'number'
                ? args.stopTimeoutMs : undefined;
    return ownTimeout === undefined ? DEFAULT_TOOL_WATCHDOG_MS : ownTimeout + TOOL_TIMEOUT_GRACE_MS;
}

function readPositiveInt(value: unknown, fallback: number, max: number, name: string): number {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
        throw new Error(`'${name}' must be an integer between 1 and ${max}.`);
    }
    return value;
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`'${name}' must be a boolean.`);
    }
    return value;
}

function readOptionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`'${name}' must be a non-empty string.`);
    }
    return value;
}

function readBuildStatistics(project: HeadlessProject): BuildStatistics {
    const snapshot = project.getSnapshot();
    const file = NodePath.join(
        snapshot.projectPath, snapshot.outDir, snapshot.target, 'statistic.json');
    if (!fs.existsSync(file)) {
        throw new Error(
            `Build statistics not found: ${file}. ` +
            'Build the project with -fstack-usage or -fcallgraph-info first.');
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object'
        || !Array.isArray(data.callgraph) || !Array.isArray(data.stackusage)) {
        throw new Error(`Invalid build statistics: ${file}`);
    }
    return data as BuildStatistics;
}

class HeadlessToolRunner {
    private readonly projects = new Map<string, HeadlessProject>();
    private readonly debug: HeadlessDebugSession;
    private readonly builder: EideBuildService;
    private readonly kernel = createCommandKernel();

    constructor(private readonly options: HeadlessToolOptions) {
        this.builder = new EideBuildService({
            resourcesDir: options.resourcesDir,
            extensionRoot: options.extensionRoot,
            toolchainPath: options.toolchainPath,
            settingsFile: options.settingsFile,
            builderThreads: options.builderThreads,
            runner: options.runner,
            timeoutMs: options.buildTimeoutMs,
            logger: options.logger
        });
        for (const projectPath of options.projectPaths) {
            const absolute = NodePath.resolve(projectPath);
            this.projects.set(absolute, new HeadlessProject(absolute, options.target));
        }
        this.debug = new HeadlessDebugSession({
            gdbPath: options.gdbPath,
            spawn: options.debugSpawn,
            commandTimeoutMs: options.debugCommandTimeoutMs,
            stopTimeoutMs: options.debugStopTimeoutMs
        });
    }

    resolveProject(uid: string | null | undefined): HeadlessProject {
        if (this.projects.size === 1) {
            const project = Array.from(this.projects.values())[0];
            const projectUid = project.getUid();
            if (uid && projectUid && projectUid !== uid) {
                throw new Error(`Not such project (uid=${uid}).`);
            }
            return project;
        }
        if (!uid) {
            throw new Error("Params 'uid' cannot be empty.");
        }
        for (const project of this.projects.values()) {
            if (project.getUid() === uid) {
                return project;
            }
        }
        throw new Error(`Not such project (uid=${uid}).`);
    }

    private projectRequest(project: HeadlessProject): ProjectRequest {
        return {
            projectPath: project.projectPath,
            target: project.getTargetName()
        };
    }

    async execute(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
        const uid = args.uid as string | null | undefined;
        let project: HeadlessProject;
        try {
            project = this.resolveProject(uid);
        } catch (error) {
            return makeEnvelopeResult(classifyError(error, tool === 'eide_clean' ? 'clean' : null));
        }

        switch (tool) {
            case 'eide_build':
            case 'eide_rebuild': {
                const overrides = args.overrides as BuildOverrides | undefined;
                const overrideError = validateBuildOverrides(overrides);
                if (overrideError) {
                    return makeTextResult(false, `Invalid overrides: ${overrideError}`);
                }
                const request = {
                    projectPath: project.projectPath,
                    target: project.getTargetName(),
                    mode: tool === 'eide_rebuild' ? 'rebuild' as const : undefined,
                    overrides
                };
                if (args.dryRun === true) {
                    const plan = await this.builder.plan(request);
                    return makeJsonResult({
                        success: true,
                        dryRun: true,
                        configHash: plan.configHash,
                        outDir: plan.outDir,
                        builder: plan.file,
                        args: plan.args,
                        paramsFile: plan.paramsPath,
                        params: plan.params
                    });
                }
                const result = await this.builder.build(request);
                return makeJsonResult(result, !result.success);
            }
            case 'eide_clean': {
                const result = await this.kernel.clean({
                    command: 'clean',
                    ...this.projectRequest(project)
                });
                return makeEnvelopeResult(result);
            }
            case 'eide_flash': {
                const artifact = readOptionalString(args.artifact, 'artifact');
                const verify = readOptionalBoolean(args.verify, 'verify');
                const dryRun = readOptionalBoolean(args.dryRun, 'dryRun') === true;
                if (artifact !== undefined && args.eraseAll === true) {
                    throw new Error("'artifact' cannot be combined with 'eraseAll'.");
                }
                const snapshot = loadProjectSnapshot(
                    project.projectPath, project.getTargetName());
                const plan = createFlashPlan(snapshot, {
                    flasherExecutable: this.options.flasherExecutable,
                    timeoutMs: this.options.flashTimeoutMs,
                    eraseAll: args.eraseAll === true,
                    verify,
                    artifact
                });
                if (dryRun) {
                    return makeJsonResult({
                        uploader: plan.uploader,
                        command: plan.command,
                        request: plan.request
                    });
                }
                const result = await new ProcessFlashService(this.options.runner).flash(plan.request);
                return makeJsonResult({ uploader: plan.uploader, ...result }, !result.success);
            }
            case 'eide_reload':
                return makeTextResult(true, 'Succeed.');
            case 'eide_get_targets':
                return makeJsonResult({
                    actived: project.getTargetName(),
                    targets: project.getTargetNames()
                });
            case 'eide_switch_target': {
                const targetName = typeof args.targetName === 'string' ? args.targetName : '';
                project.selectTarget(targetName);
                return makeTextResult(true, 'Succeed.');
            }
            case 'eide_get_src_dirs':
                return makeJsonResult(project.getSrcDirs());
            case 'eide_add_src_dir':
                project.addSrcDir(String(args.path));
                return makeTextResult(true, 'Succeed.');
            case 'eide_del_src_dir':
                project.removeSrcDir(String(args.path));
                return makeTextResult(true, 'Succeed.');
            case 'eide_exclude_src_file':
                project.excludeSourceFile(String(args.path));
                return makeTextResult(true, 'Succeed.');
            case 'eide_include_src_file':
                project.includeSourceFile(String(args.path));
                return makeTextResult(true, 'Succeed.');
            case 'eide_get_inc_dirs':
                return makeJsonResult(project.getIncludeDirs());
            case 'eide_set_inc_dirs': {
                const paths = args.paths;
                if (!Array.isArray(paths)) {
                    return makeTextResult(false, 'paths must be an array of strings.');
                }
                project.setIncludeDirs(paths as string[]);
                return makeTextResult(true, 'Succeed.');
            }
            case 'eide_get_defines':
                return makeJsonResult(project.getDefines());
            case 'eide_set_defines': {
                const defines = args.defines;
                if (!Array.isArray(defines)) {
                    return makeTextResult(false, 'defines must be an array of strings.');
                }
                project.setDefines(defines as string[]);
                return makeTextResult(true, 'Succeed.');
            }
            case 'eide_get_builder_opts_schema':
                return makeJsonResult(
                    await this.builder.getBuilderOptionsSchema(this.projectRequest(project)));
            case 'eide_get_builder_opts':
                return makeJsonResult(await this.builder.getBuilderOptions(
                    this.projectRequest(project)));
            case 'eide_set_builder_opts':
                await this.builder.setBuilderOptions(
                    this.projectRequest(project), args.options);
                return makeTextResult(true, 'Succeed.');
            case 'eide_get_stack_usage': {
                const topN = readPositiveInt(args.topN, 20, 500, 'topN');
                const stats = readBuildStatistics(project);
                return makeJsonResult(summarizeStackUsage(stats.stackusage, topN));
            }
            case 'eide_query_callgraph': {
                const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
                if (symbol.length === 0) {
                    return makeTextResult(false, "Params 'symbol' cannot be empty.");
                }
                const depth = readPositiveInt(args.depth, 2, 6, 'depth');
                const stats = readBuildStatistics(project);
                return makeJsonResult(queryCallgraph(stats.callgraph, symbol, depth));
            }
            case 'eide_debug_connect':
                return makeJsonResult(await this.debug.connect(project, args));
            case 'eide_debug_disconnect':
                return makeJsonResult(await this.debug.disconnect());
            case 'eide_debug_read_register':
                return makeJsonResult(await this.debug.readRegister(args.name));
            case 'eide_debug_read_memory':
                return makeJsonResult(await this.debug.readMemory(args.address, args.length));
            case 'eide_debug_write_memory':
                return makeJsonResult(await this.debug.writeMemory(args.address, args.hex));
            case 'eide_debug_set_breakpoint':
                return makeJsonResult(await this.debug.setBreakpoint(args));
            case 'eide_debug_remove_breakpoint':
                return makeJsonResult(await this.debug.removeBreakpoint(args.id));
            case 'eide_debug_backtrace':
                return makeJsonResult(await this.debug.backtrace(args.maxDepth));
            case 'eide_debug_list_breakpoints':
                return makeJsonResult(await this.debug.listBreakpoints());
            case 'eide_debug_list_threads':
                return makeJsonResult(await this.debug.listThreads());
            case 'eide_debug_select_thread':
                return makeJsonResult(await this.debug.selectThread(args.id));
            case 'eide_debug_select_frame':
                return makeJsonResult(await this.debug.selectFrame(args.level));
            case 'eide_debug_list_variables':
                return makeJsonResult(await this.debug.listVariables(args));
            case 'eide_debug_continue':
                return makeJsonResult(await this.debug.continue(args.stopTimeoutMs));
            case 'eide_debug_step_over':
                return makeJsonResult(await this.debug.stepOver(args.stopTimeoutMs));
            case 'eide_debug_step_into':
                return makeJsonResult(await this.debug.stepInto(args.stopTimeoutMs));
            case 'eide_debug_step_out':
                return makeJsonResult(await this.debug.stepOut(args.stopTimeoutMs));
            case 'eide_debug_interrupt':
                return makeJsonResult(await this.debug.interrupt());
            case 'eide_debug_evaluate':
                return makeJsonResult(await this.debug.evaluate(args.expression));
            case 'eide_debug_fault':
                return makeJsonResult(await this.debug.fault(args));
            case 'eide_debug_svd_lookup':
                return makeJsonResult(await this.debug.svdLookup(project, args));
            default:
                return makeTextResult(false, `Unknown tool: ${tool}`);
        }
    }
}

export function createHeadlessToolExecutor(
    options: HeadlessToolOptions
): (tool: string, args: Record<string, unknown>) => Promise<CallToolResult> {
    const runner = options.toolRunner ?? new HeadlessToolRunner(options);
    let queue: Promise<void> = Promise.resolve();
    return (tool, args) => {
        const execution = queue.then(async () => {
            try {
                let timer: NodeJS.Timeout | undefined;
                try {
                    return await Promise.race([
                        runner.execute(tool, args),
                        new Promise<CallToolResult>(resolve => {
                            timer = setTimeout(() => {
                                resolve({
                                    isError: true,
                                    content: [{
                                        type: 'text',
                                        text: JSON.stringify({
                                            success: false,
                                            error: {
                                                kind: 'timeout',
                                                message: `Tool call timed out: ${tool}`
                                            }
                                        })
                                    }]
                                });
                            }, toolWatchdogTimeout(tool, args, options));
                        })
                    ]);
                } finally {
                    if (timer !== undefined) {
                        clearTimeout(timer);
                    }
                }
            } catch (error) {
                return makeTextResult(false, errorMessage(error));
            }
        });
        queue = execution.then(() => undefined, () => undefined);
        return execution;
    };
}

export async function executeHeadlessTool(
    tool: string,
    args: Record<string, unknown>,
    options: HeadlessToolOptions
): Promise<CallToolResult> {
    return createHeadlessToolExecutor(options)(tool, args);
}
