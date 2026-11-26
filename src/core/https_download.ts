import * as fs from 'fs';
import * as https from 'https';
import type { ClientRequest, IncomingMessage } from 'http';

const DEFAULT_REDIRECT_LIMIT = 6;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

interface IdleWatch {
    arm: () => void;
    cancel: () => void;
}

function idleWatch(current: string, timeoutMs: number, fail: (error: Error) => void): IdleWatch {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    return {
        arm: () => {
            cancel();
            timer = setTimeout(() => {
                fail(new Error(`Download from ${current} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
        },
        cancel
    };
}

export function downloadHttpsFile(
    url: string,
    dest: string,
    onProgress?: (received: number, total: number) => void,
    timeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
    get: typeof https.get = https.get
): Promise<void> {
    return new Promise((resolve, reject) => {
        let activeRequest: ClientRequest | undefined;
        let activeResponse: IncomingMessage | undefined;
        const settle = (error: Error): void => {
            activeResponse?.destroy();
            activeRequest?.destroy();
            reject(error);
        };
        const follow = (current: string, redirectsLeft: number) => {
            if (redirectsLeft <= 0) {
                reject(new Error(`Too many redirects: ${url}`));
                return;
            }
            const watch = idleWatch(current, timeoutMs, settle);
            watch.arm();
            activeRequest = get(current, { headers: { 'user-agent': 'eide-pro' } }, res => {
                activeResponse = res;
                watch.arm();
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    watch.cancel();
                    follow(new URL(res.headers.location, current).toString(), redirectsLeft - 1);
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    watch.cancel();
                    reject(new Error(`Download failed: HTTP ${status} for ${current}`));
                    return;
                }
                const total = parseInt(res.headers['content-length'] || '');
                let received = 0;
                res.on('data', (buf: Buffer) => {
                    received += buf.length;
                    watch.arm();
                    onProgress?.(received, total);
                });
                res.once('error', error => {
                    watch.cancel();
                    reject(error);
                });
                res.once('end', () => watch.cancel());
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.once('finish', () => file.close(() => {
                    watch.cancel();
                    if (!Number.isNaN(total) && received !== total) {
                        fs.rmSync(dest, { force: true });
                        reject(new Error(`Truncated download: received ${received} of ${total} bytes`));
                        return;
                    }
                    resolve();
                }));
                file.once('error', error => {
                    watch.cancel();
                    reject(error);
                });
            }).once('error', error => {
                watch.cancel();
                reject(error);
            });
        };
        follow(url, DEFAULT_REDIRECT_LIMIT);
    });
}

export function fetchHttpsText(
    url: string,
    timeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
    get: typeof https.get = https.get
): Promise<string> {
    return new Promise((resolve, reject) => {
        let activeRequest: ClientRequest | undefined;
        let activeResponse: IncomingMessage | undefined;
        const settle = (error: Error): void => {
            activeResponse?.destroy();
            activeRequest?.destroy();
            reject(error);
        };
        const follow = (current: string, redirectsLeft: number) => {
            if (redirectsLeft <= 0) {
                reject(new Error(`Too many redirects: ${url}`));
                return;
            }
            const watch = idleWatch(current, timeoutMs, settle);
            watch.arm();
            activeRequest = get(current, { headers: { 'user-agent': 'eide-pro' } }, res => {
                activeResponse = res;
                watch.arm();
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    watch.cancel();
                    follow(new URL(res.headers.location, current).toString(), redirectsLeft - 1);
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    watch.cancel();
                    reject(new Error(`Download failed: HTTP ${status} for ${current}`));
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    body += chunk;
                    watch.arm();
                });
                res.once('end', () => {
                    watch.cancel();
                    resolve(body);
                });
                res.once('error', error => {
                    watch.cancel();
                    reject(error);
                });
            }).once('error', error => {
                watch.cancel();
                reject(error);
            });
        };
        follow(url, DEFAULT_REDIRECT_LIMIT);
    });
}
