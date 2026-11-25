import * as NodePath from 'path';

export interface ToolingState {
    cliVersion?: string;
    nodeVersion?: string;
    dotnetMajor?: number;
    dismissedVersion?: string;
}

export type InstallDecision =
    | { action: 'prompt'; missingPrereqs: string[] }
    | { action: 'skip'; reason: 'installed' | 'dismissed' | 'unsupported' };

export interface InstallResult {
    ok: boolean;
    message: string;
}

export interface InstallOptions {
    version: string;
    repositoryUrl: string;
    workDir: string;
    download: (url: string, dest: string) => Promise<void>;
    run: (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
}

const supportedPlatforms = ['win32', 'darwin', 'linux'];
const downloadTimeoutMs = 120000;
const installTimeoutMs = 180000;

export function decideInstallPrompt(state: ToolingState, extensionVersion: string, platform: string): InstallDecision {
    if (state.cliVersion === extensionVersion) {
        return { action: 'skip', reason: 'installed' };
    }
    if (!supportedPlatforms.includes(platform)) {
        return { action: 'skip', reason: 'unsupported' };
    }
    if (state.dismissedVersion === extensionVersion) {
        return { action: 'skip', reason: 'dismissed' };
    }
    if (state.cliVersion === extensionVersion) {
        return { action: 'prompt', missingPrereqs: [] };
    }

    const missingPrereqs: string[] = [];
    if (state.nodeVersion === undefined) {
        missingPrereqs.push('node');
    }
    if (state.dotnetMajor === undefined || state.dotnetMajor < 6) {
        missingPrereqs.push('dotnet');
    }
    return { action: 'prompt', missingPrereqs };
}

export function releaseTarballUrl(version: string, repositoryUrl: string): string {
    const repository = repositoryUrl.replace(/\/+$/, '');
    return `${repository}/releases/download/v${version}/eide-pro-headless-${version}.tgz`;
}

export function installCommand(tarballPath: string, platform: string): { file: string; args: string[] } {
    return {
        file: platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['install', '-g', tarballPath]
    };
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, step: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${step} timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function commandFailure(result: { code: number; stdout: string; stderr: string }): string {
    return `code ${result.code}; stdout: ${result.stdout}; stderr: ${result.stderr}`;
}

export async function installHeadlessTooling(options: InstallOptions): Promise<InstallResult> {
    const tarballName = `eide-pro-headless-${options.version}.tgz`;
    const tarballPath = NodePath.join(options.workDir, tarballName);
    const url = releaseTarballUrl(options.version, options.repositoryUrl);

    try {
        await withTimeout(options.download(url, tarballPath), downloadTimeoutMs, 'download');
    } catch (error) {
        return { ok: false, message: `download failed: ${errorMessage(error)}` };
    }

    const npm = installCommand(tarballPath, process.platform);
    try {
        const result = await options.run(npm.file, npm.args, installTimeoutMs);
        if (result.code !== 0) {
            return { ok: false, message: `npm install failed: ${commandFailure(result)}` };
        }
    } catch (error) {
        return { ok: false, message: `npm install failed: ${errorMessage(error)}` };
    }

    try {
        const result = await options.run('eide-cli', ['--version'], installTimeoutMs);
        if (result.code !== 0) {
            return { ok: false, message: `verify failed: ${commandFailure(result)}` };
        }
    } catch (error) {
        return { ok: false, message: `verify failed: ${errorMessage(error)}` };
    }

    return { ok: true, message: `Installed eide-cli ${options.version}` };
}
