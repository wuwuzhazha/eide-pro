/*
    MIT License

    Copyright (c) 2019 github0null

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
*/

import { CallToolResult } from '@modelcontextprotocol/sdk/types';
import { ProjectExplorer } from '../EIDEProjectExplorer';
import { AbstractProject } from '../EIDEProject';
import { BuilderOptions, ProjectConfiguration } from '../EIDETypeDefine';
import { BuildOptions } from '../CodeBuilder';
import { FlashCommandResult } from '../HexUploader';
import { loadBuilderOptionsSchema, validateBuilderOptions } from './mcp_builder_opts_validate';
import { selectBuilderOptionsSchema } from '../core/builder_options_schema_view';
import { File } from '../../lib/node-utility/File';
import { parseCompilerLog } from '../ProblemMatcher';
import { BuildProblem, detectBuildStage, makeLogTail, parseMemoryUsage, toBuildProblems } from '../BuildReport';
import { BuildStatistics, queryCallgraph, summarizeStackUsage } from '../BuildStatistics';
import { validateBuildOverrides } from '../core/build_overrides';
import { BuildOverrides } from '../core/types';

function resolveProject(
    explorer: ProjectExplorer,
    uid: string | null | undefined
): AbstractProject | undefined {
    if (uid) {
        return explorer.getProjectByUid(uid);
    }
    return undefined;
}

function projectNotFound(uid: string | null | undefined): CallToolResult {
    return {
        isError: true,
        content: [{
            type: 'text',
            text: uid ? `Error. Not such project (uid=${uid}).` : `Error. Params 'uid' cannot be empty.`
        }]
    };
}

function makeTextResult(success: boolean, message: string, err?: Error): CallToolResult {
    return {
        isError: !success,
        content: [{
            type: 'text',
            text: message + (err ? '\n\nError: ' + err.message : '')
        }]
    };
}

function makeJsonResult(data: unknown, isError = false): CallToolResult {
    return {
        isError,
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
    };
}

function readCustomDependence(prj: AbstractProject) {
    return prj.GetConfiguration().GetDependence(
        ProjectConfiguration.CUSTOM_GROUP_NAME, 'default');
}

function makeBuildResult(
    prj: AbstractProject,
    success: boolean,
    message: string,
    failureKind?: 'timeout' | 'signal' | 'build'
): CallToolResult {
    const logFile = File.from(prj.getOutputFolder().path, 'compiler.log');
    let logText = '';
    let problems: BuildProblem[] = [];
    let analysisError: string | undefined;
    try {
        if (logFile.IsFile()) {
            logText = logFile.Read();
            problems = toBuildProblems(parseCompilerLog(prj.getToolchain().name, prj, logFile));
        } else {
            analysisError = `Build log not found: ${logFile.path}`;
        }
    } catch (error) {
        analysisError = error.message;
    }
    const compileCommands = File.from(prj.getOutputFolder().path, 'compile_commands.json');
    const report = {
        success,
        ...(failureKind ? { failureKind } : {}),
        stage: detectBuildStage(logText, success),
        problems,
        memory: parseMemoryUsage(logText),
        ...(compileCommands.IsFile() ? { compileCommands: compileCommands.path } : {}),
        ...(success ? {} : { logTail: makeLogTail(message) }),
        ...(analysisError ? { analysisError } : {})
    };
    return makeJsonResult(report, !success);
}

function readBuildStatistics(prj: AbstractProject): BuildStatistics {
    const file = File.from(prj.getOutputFolder().path, 'statistic.json');
    if (!file.IsFile()) {
        throw new Error(
            `Build statistics not found: ${file.path}. ` +
            'Build the project with -fstack-usage or -fcallgraph-info first.');
    }
    const data = JSON.parse(file.Read());
    if (!data || typeof data !== 'object' ||
        !Array.isArray(data.callgraph) || !Array.isArray(data.stackusage)) {
        throw new Error(`Invalid build statistics: ${file.path}`);
    }
    return data as BuildStatistics;
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

export async function executeTool(
    tool: string,
    args: Record<string, unknown>,
    explorer: ProjectExplorer
): Promise<CallToolResult> {
    const uid = args.uid as string | null | undefined;

    switch (tool) {
        case 'eide_build':
        case 'eide_rebuild': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const overrides = args.overrides as BuildOverrides | undefined;
            const overrideError = validateBuildOverrides(overrides);
            if (overrideError) {
                return makeTextResult(false, `Invalid overrides: ${overrideError}`);
            }
            const options: BuildOptions = {
                notRebuild: tool === 'eide_build',
                otherArgs: ['--no-color'],
                overrides
            };
            if (args.dryRun === true) {
                const planned = await explorer.planProject(prj, options);
                if (!planned.success) {
                    return makeTextResult(false, planned.message);
                }
                const paramsFile = File.from(prj.getOutputFolder().path, 'builder.params');
                if (!paramsFile.IsFile()) {
                    return makeTextResult(false, `Builder params not found: ${paramsFile.path}`);
                }
                return makeJsonResult({
                    success: true,
                    dryRun: true,
                    command: planned.message,
                    outDir: prj.getOutputFolder().path,
                    paramsFile: paramsFile.path,
                    params: JSON.parse(paramsFile.Read())
                });
            }
            const res = await explorer.buildProject(prj, options, true);
            if (res.message === 'Builder busy ! Please wait !') {
                return makeTextResult(false, res.message);
            }
            return makeBuildResult(prj, res.success, res.message, res.failureKind);
        }
        case 'eide_clean': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const res = await explorer.cleanProject(prj, true);
            return makeTextResult(res.success, res.message);
        }
        case 'eide_flash': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const eraseAll = Boolean(args.eraseAll);
            let res: FlashCommandResult | void;
            if (eraseAll) {
                res = await explorer.programFlashProject(prj, true, true);
                if (!res || !res.success)
                    return makeTextResult(false, res ? res.message : 'Failed to erase chip.');
            }
            res = await explorer.programFlashProject(prj, false, true);
            if (res) {
                return makeTextResult(res.success, res.message, res.error);
            } else {
                return makeTextResult(false, 'Unknown Error.');
            }
        }
        case 'eide_reload': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            await new Promise(r => setTimeout(r, 1500)); // delay before reload project.
            const ok = await explorer.reloadProject(prj.getUid());
            const result = makeTextResult(ok, ok ? 'Succeed.' : 'Failed.');
            await new Promise(r => setTimeout(r, ok ? 2000 : 500)); // delay after reload project.
            return result;
        }
        case 'eide_switch_target': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const targetName = args.targetName as string;
            const targets = prj.getTargets();
            if (!targets.includes(targetName))
                return makeTextResult(false, `Project '${prj.getProjectName()}' (uid=${uid}) not have this target: '${targetName}'`);
            await prj.switchTarget(targetName);
            await new Promise(r => setTimeout(r, 1500));
            return makeTextResult(true, 'Succeed.');
        }
        case 'eide_add_src_dir': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const srcDir = args.path as string;
            const absSrcDir = prj.ToAbsolutePath(srcDir);
            const res = prj.getNormalSourceManager().verify(absSrcDir);
            if (!res.valid) {
                return makeTextResult(false, res.message);
            }
            prj.GetConfiguration().AddSrcDir(absSrcDir);
            return makeTextResult(true, 'Succeed.');
        }
        case 'eide_del_src_dir': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const absSrcDir = prj.ToAbsolutePath(args.path as string);
            const srcDirs = prj.GetConfiguration().config.srcDirs;
            if (!srcDirs.includes(absSrcDir)) {
                return makeTextResult(false, `Source directory not in project: ${args.path}`);
            }
            prj.GetConfiguration().RemoveSrcDir(absSrcDir);
            return makeTextResult(true, 'Succeed.');
        }
        case 'eide_get_src_dirs': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const srcList = prj.getNormalSourceManager()
                .getRootFolderList().map(info => prj.toRelativePath(info.fileWatcher.file.path));
            return makeJsonResult(srcList);
        }
        case 'eide_exclude_src_file': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const filePath = args.path as string;
            prj.excludeSourceFile(prj.ToAbsolutePath(filePath));
            return makeTextResult(true, 'Succeed.');
        }
        case 'eide_include_src_file': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const filePath = args.path as string;
            prj.unexcludeSourceFile(prj.ToAbsolutePath(filePath));
            return makeTextResult(true, 'Succeed.');
        }
        case 'eide_get_inc_dirs': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const dep = readCustomDependence(prj);
            const incList = (dep ? dep.incList : []).map(p => {
                const rel = prj.toRelativePath(p);
                return rel !== undefined ? rel : p;
            });
            return makeJsonResult(incList);
        }
        case 'eide_set_inc_dirs': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const paths = args.paths as string[];
            if (!Array.isArray(paths)) {
                return makeTextResult(false, 'paths must be an array of strings.');
            }
            const dep = prj.GetConfiguration().CustomDep_getDependence();
            dep.incList = paths.map(p => prj.ToAbsolutePath(p));
            prj.GetConfiguration().CustomDep_NotifyChanged();
            return makeTextResult(true, 'Succeed.');
        }
        case 'eide_get_defines': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const dep = readCustomDependence(prj);
            return makeJsonResult(dep ? dep.defineList : []);
        }
        case 'eide_set_defines': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const defines = args.defines as string[];
            if (!Array.isArray(defines)) {
                return makeTextResult(false, 'defines must be an array of strings.');
            }
            const dep = prj.GetConfiguration().CustomDep_getDependence();
            dep.defineList = defines.map(d => d.trim()).filter(d => d.length > 0);
            prj.GetConfiguration().CustomDep_NotifyChanged();
            return makeTextResult(true, 'Succeed.');
        }
        case 'eide_get_builder_opts': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const builderOpts = prj.GetConfiguration().toolchainConfigModel.getOptions();
            return makeJsonResult(builderOpts);
        }
        case 'eide_get_builder_opts_schema': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            try {
                const path = args.path === undefined || args.path === null
                    ? undefined : String(args.path);
                return makeJsonResult(selectBuilderOptionsSchema(loadBuilderOptionsSchema(prj), path));
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                return makeTextResult(false, 'Failed to load builder options schema.', error);
            }
        }
        case 'eide_get_targets': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            return makeJsonResult({
                actived: prj.getCurrentTarget(),
                targets: prj.getTargets()
            });
        }
        case 'eide_set_builder_opts': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const options = args.options;
            if (!options || typeof options !== 'object' || Array.isArray(options)) {
                return makeTextResult(false, 'options must be a BuilderOptions JSON object.');
            }
            const validateErr = validateBuilderOptions(prj, options);
            if (validateErr) {
                return makeTextResult(false, `Builder options validation failed:\n${validateErr}`);
            }
            try {
                prj.GetConfiguration().toolchainConfigModel.setOptions(options as BuilderOptions);
                prj.onBuilderConfigChanged();
                return makeTextResult(true, 'Succeed.');
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                return makeTextResult(false, 'Failed to set builder options.', error);
            }
        }
        case 'eide_get_stack_usage': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            let topN: number;
            try {
                topN = readPositiveInt(args.topN, 20, 500, 'topN');
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                return makeTextResult(false, error.message);
            }
            let stats: BuildStatistics;
            try {
                stats = readBuildStatistics(prj);
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                return makeJsonResult({ available: false, reason: error.message });
            }
            return makeJsonResult(summarizeStackUsage(stats.stackusage, topN));
        }
        case 'eide_query_callgraph': {
            const prj = resolveProject(explorer, uid);
            if (!prj)
                return projectNotFound(uid);
            const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
            if (symbol.length === 0) {
                return makeTextResult(false, `Params 'symbol' cannot be empty.`);
            }
            let depth: number;
            try {
                depth = readPositiveInt(args.depth, 2, 6, 'depth');
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                return makeTextResult(false, error.message);
            }
            let stats: BuildStatistics;
            try {
                stats = readBuildStatistics(prj);
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                return makeJsonResult({ available: false, reason: error.message });
            }
            return makeJsonResult(queryCallgraph(stats.callgraph, symbol, depth));
        }
        default:
            return makeTextResult(false, `Unknown tool: ${tool}`);
    }
}
