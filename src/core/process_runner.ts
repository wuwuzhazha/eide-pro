import { spawn } from 'child_process';
import { ProcessOptions, ProcessResult, ProcessRunner } from './adapters';

export class ProcessTimeoutError extends Error {
    constructor(
        public readonly timeoutMs: number,
        public readonly stdout: string,
        public readonly stderr: string
    ) {
        super(`Process timed out after ${timeoutMs} ms`);
        this.name = 'ProcessTimeoutError';
    }
}

export class NodeProcessRunner implements ProcessRunner {
    run(file: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
        return new Promise((resolve, reject) => {
            const child = spawn(file, args, {
                cwd: options.cwd,
                env: options.env,
                windowsHide: true,
                detached: process.platform !== 'win32'
            });
            let stdout = '';
            let stderr = '';
            let timer: NodeJS.Timeout | undefined;
            let settled = false;

            const finish = (fn: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer !== undefined) {
                    clearTimeout(timer);
                }
                fn();
            };

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });

            child.on('error', error => finish(() => reject(error)));
            child.on('close', code => finish(() => resolve({ code, stdout, stderr })));

            if (options.timeoutMs !== undefined) {
                if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
                    child.kill();
                    finish(() => reject(new Error(`Invalid process timeout: ${options.timeoutMs}`)));
                    return;
                }
                timer = setTimeout(() => {
                    if (process.platform === 'win32') {
                        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
                    } else {
                        process.kill(-child.pid!, 'SIGKILL');
                    }
                    finish(() => reject(new ProcessTimeoutError(options.timeoutMs!, stdout, stderr)));
                }, options.timeoutMs);
            }
        });
    }
}
