import { spawn } from 'child_process';
import type { ChildProcess as ChildProcessType } from 'child_process';

const windowsMissingMessage = 'is not recognized as an internal or external command';

export type ProbeResult =
    | { status: 'ok'; value: string }
    | { status: 'missing' }
    | { status: 'failed'; message: string };

export type Spawner = (
    file: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean; encoding: string }
) => ChildProcessType;

export interface ProbeOptions {
    platform: NodeJS.Platform;
    timeoutMs: number;
    run?: Spawner;
}

export function commandProbeInvocation(
    file: string,
    args: string[],
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv = process.env
): { file: string; args: string[] } {
    if (platform === 'win32') {
        return {
            file: env.ComSpec ?? 'cmd.exe',
            args: ['/d', '/s', '/c', file, ...args]
        };
    }
    return { file, args: [...args] };
}

export function probeCommand(
    file: string,
    args: string[],
    options: ProbeOptions
): Promise<ProbeResult> {
    const run = options.run ?? spawn;
    const invocation = commandProbeInvocation(file, args, options.platform);
    return new Promise(resolve => {
        let child: ChildProcessType;
        try {
            child = run(invocation.file, invocation.args, {
                timeout: options.timeoutMs,
                windowsHide: true,
                encoding: 'utf8'
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') {
                resolve({ status: 'missing' });
            } else {
                resolve({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
            }
            return;
        }

        child.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
                resolve({ status: 'missing' });
            } else {
                resolve({ status: 'failed', message: error.message });
            }
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer | string) => stdout += String(chunk));
        child.stderr?.on('data', (chunk: Buffer | string) => stderr += String(chunk));
        child.once('close', (code: number | null) => {
            const text = stdout.split(/\r?\n/, 1)[0].trim();
            if (code !== 0) {
                if (options.platform === 'win32' && stderr.includes(windowsMissingMessage)) {
                    resolve({ status: 'missing' });
                    return;
                }
                resolve({ status: 'failed', message: `Command exited with code ${code}: ${stderr.trim()}` });
            } else if (/^\d+\.\d+\.\d+/.test(text)) {
                resolve({ status: 'ok', value: text });
            } else {
                resolve({ status: 'failed', message: `Invalid version output: ${text || stderr.trim()}` });
            }
        });
    });
}

export function probeProcessOutput(result: { code: number; stdout: string; stderr: string }): ProbeResult {
    if (result.code !== 0) {
        return { status: 'failed', message: `Command exited with code ${result.code}: ${result.stderr.trim()}` };
    }
    const value = result.stdout.split(/\r?\n/, 1)[0].trim();
    if (/^\d+\.\d+\.\d+/.test(value)) {
        return { status: 'ok', value };
    }
    return { status: 'failed', message: `Invalid version output: ${value || result.stderr.trim()}` };
}
