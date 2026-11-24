import { OverridableBuilderParams } from './build_overrides';
import { BuildRequest, BuildResult } from './types';

export interface BuilderParamsData extends OverridableBuilderParams {
    name: string;
    target: string;
    toolchain: string;
    toolchainCfgFile: string;
    toolchainLocation: string;
    buildMode: string;
    showRepathOnLog: boolean;
    threadNum: number;
    dumpPath: string;
    outDir: string;
    rootDir: string;
    sourceParams: { [name: string]: string };
    env: { [name: string]: any };
    sysPaths: string[];
    alwaysInBuildSources: string[];
}

export interface BuildPlan {
    params: BuilderParamsData;
    paramsPath: string;
    file: string;
    args: string[];
    outDir: string;
    configHash: string;
}

export interface CleanResult {
    success: boolean;
    message?: string;
}

export interface BuildService {
    plan(request: BuildRequest): Promise<BuildPlan>;
    build(request: BuildRequest): Promise<BuildResult>;
    clean(request: BuildRequest): Promise<CleanResult>;
}
