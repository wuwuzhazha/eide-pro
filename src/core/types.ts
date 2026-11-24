import type { BuildProblem, BuildStage, MemoryRegionUsage } from '../BuildReport';

export type BuildMode = 'incremental' | 'rebuild';

export interface BuildOverrides {
    defines?: string[];
    includeDirs?: string[];
    libDirs?: string[];
    cFlags?: string;
    cxxFlags?: string;
    asmFlags?: string;
    ldFlags?: string;
    options?: { [key: string]: unknown };
    source?: {
        include?: string[];
        exclude?: string[];
    };
    env?: { [key: string]: string };
}

export interface BuildRequest {
    projectPath: string;
    workspaceFile?: string;
    target?: string;
    mode?: BuildMode;
    dryRun?: boolean;
    overrides?: BuildOverrides;
}

export interface EffectiveBuildConfig {
    target: string;
    toolchain: string;
    outDir: string;
    defines: string[];
    includeDirs: string[];
    cFlags: string;
    cxxFlags: string;
    asmFlags: string;
    ldFlags: string;
}

export interface BuildResult {
    success: boolean;
    buildId?: string;
    configHash?: string;
    failureKind?: 'timeout' | 'signal' | 'build';
    stage: BuildStage;
    problems: BuildProblem[];
    memory: { [region: string]: MemoryRegionUsage };
    artifacts: string[];
    compileCommands?: string;
    effectiveConfig?: EffectiveBuildConfig;
    logTail?: string;
    analysisError?: string;
}
