import * as fs from 'fs';
import * as NodePath from 'path';
import { loadProjectSnapshot, ProjectSnapshot, resolveOutputDir } from './project_snapshot';
import { CleanResult } from './services';
import { BuildRequest } from './types';
import { ConfigError } from './errors';

export class BuildExecutionError extends Error {
    constructor(message: string, public readonly original: unknown) {
        super(message);
        this.name = 'BuildExecutionError';
    }
}

export function cleanOutputDir(snapshot: ProjectSnapshot): CleanResult {
    const outDir = resolveOutputDir(snapshot);
    const relative = NodePath.relative(snapshot.projectPath, outDir);
    if (relative.length === 0 || relative === '..' || relative.startsWith(`..${NodePath.sep}`)
        || NodePath.isAbsolute(relative)) {
        throw new ConfigError(`Refusing to clean output directory outside project: ${outDir}`);
    }
    if (!fs.existsSync(outDir)) {
        return { success: true, message: 'Output directory does not exist.' };
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    return { success: true, message: `Removed ${outDir}` };
}

export function cleanProject(request: BuildRequest): CleanResult {
    return cleanOutputDir(loadProjectSnapshot(request.workspaceFile ?? request.projectPath, request.target));
}
