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

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { ExeModule } from '../../lib/node-utility/Executable';
import { ProjectExplorer } from '../EIDEProjectExplorer';
import { GlobalEvent } from '../GlobalEvents';
import { executeTool } from './mcp_impl';
import {
    appendMcpLog,
    attachFrameReader,
    getHealthUrl,
    getMcpBundleId,
    healthCheckTimeoutMs,
    IpcMessage,
    ipcConnectTimeoutMs,
    ipcPingIntervalMs,
    isMcpHealthCompatible,
    McpHealthResponse,
    McpProjectInfo,
    proxyStartupMaxAttempts,
    proxyStartupTimeoutMs,
    sendMessage,
    getLogPath
} from './mcp_protocol';

let socket: net.Socket | undefined;
let pingTimer: NodeJS.Timeout | undefined;
let projectExplorer: ProjectExplorer | undefined;
let instanceId: string | undefined;

function logInfo(msg: string): void {
    GlobalEvent.log_info(msg);
}

function logError(msg: string, err?: unknown): void {
    GlobalEvent.log_error(msg);
    if (err instanceof Error) {
        GlobalEvent.log_error(err);
    } else if (err !== undefined) {
        GlobalEvent.log_error(String(err));
    }
}

function collectProjects(explorer: ProjectExplorer): McpProjectInfo[] {
    const projects: McpProjectInfo[] = [];
    explorer.foreachProjects((prj) => {
        projects.push({ uid: prj.getUid(), name: prj.getProjectName() });
        return undefined;
    });
    return projects;
}

async function checkProxyHealth(httpPort: number): Promise<McpHealthResponse | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), healthCheckTimeoutMs);
    try {
        const res = await fetch(getHealthUrl(httpPort), { signal: controller.signal });
        if (!res.ok) {
            return undefined;
        }
        const body = await res.json() as McpHealthResponse;
        if (!body.ok || body.httpPort !== httpPort) {
            return undefined;
        }
        return body;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

function waitForProxyHealth(httpPort: number, timeoutMs: number): Promise<McpHealthResponse | undefined> {
    const deadline = Date.now() + timeoutMs;
    return new Promise(resolve => {
        const tick = async () => {
            const health = await checkProxyHealth(httpPort);
            if (health) {
                resolve(health);
                return;
            }
            if (Date.now() >= deadline) {
                resolve(undefined);
                return;
            }
            setTimeout(tick, 200);
        };
        void tick();
    });
}

function spawnEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    return env;
}

function spawnProxy(serverJs: string, httpPort: number, version: string, bundleId: string): ExeModule {

    const exe = new ExeModule();

    const logPath = getLogPath(httpPort);

    exe.on('close', (info) => {
        appendMcpLog(logPath, `exited. code=${info.code}`);
    });
    exe.on('errLine', (line) => {
        appendMcpLog(logPath, line);
    });
    exe.on('error', (err) => {
        appendMcpLog(logPath, `${err.name}: ${err.message}` + (err.stack ? `\n${err.stack}` : ''));
    });

    exe.Run(serverJs, [
        '--port', String(httpPort),
        '--version', version,
        '--bundle-id', bundleId
    ], {
        detached: true,
        stdio: 'pipe',
        env: spawnEnv(),
        execArgv: []
    });

    return exe;
}

async function stopProxy(pid: number): Promise<void> {
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        // already stopped
    }
}

async function waitForProxyGone(httpPort: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const health = await checkProxyHealth(httpPort);
        if (!health) {
            return;
        }
        await new Promise(r => setTimeout(r, 200));
    }

    const health = await checkProxyHealth(httpPort);
    if (health) {
        try {
            process.kill(health.pid, 'SIGKILL');
        } catch {
            // ignore
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

async function startProxy(
    httpPort: number,
    serverJs: string,
    extensionVersion: string,
    bundleId: string
): Promise<McpHealthResponse | undefined> {
    const startTime = Date.now();
    const proc = spawnProxy(serverJs, httpPort, extensionVersion, bundleId);

    let health = await waitForProxyHealth(httpPort, proxyStartupTimeoutMs);
    if (!health) {
        health = await checkProxyHealth(httpPort);
    }

    if (health) {
        logInfo(`MCP proxy started in ${Date.now() - startTime} ms (pid=${health.pid})`);
        return health;
    }

    logError(
        `MCP proxy did not become healthy after ${Date.now() - startTime} ms ` +
        `(pid=${proc.pid() ?? 'unknown'}), see ${getLogPath(httpPort)}`
    );

    if (!proc.IsExit()) {
        await Promise.race([
            proc.Kill(),
            new Promise<void>(resolve => setTimeout(resolve, ipcConnectTimeoutMs))
        ]);
    }
    await waitForProxyGone(httpPort, ipcConnectTimeoutMs);

    return undefined;
}

async function ensureProxyRunning(
    httpPort: number,
    serverJs: string,
    extensionVersion: string,
    bundleId: string,
    force = false
): Promise<McpHealthResponse> {
    let health = await checkProxyHealth(httpPort);

    if (force && health) {
        logInfo(`Restarting MCP proxy on port ${httpPort} (forced).`);
        await stopProxy(health.pid);
        await waitForProxyGone(httpPort, ipcConnectTimeoutMs);
        health = undefined;
    }

    if (health && !isMcpHealthCompatible(health, extensionVersion, bundleId)) {
        logInfo(
            `MCP proxy outdated (running=${health.version ?? 'unknown'}/${health.bundleId ?? 'unknown'}, ` +
            `expected=${extensionVersion}/${bundleId}), restarting...`
        );
        await stopProxy(health.pid);
        await waitForProxyGone(httpPort, ipcConnectTimeoutMs);
        health = undefined;
    }

    if (!health) {
        for (let attempt = 1; attempt <= proxyStartupMaxAttempts; attempt++) {
            if (attempt > 1) {
                logInfo(`Retrying MCP proxy startup (attempt ${attempt}/${proxyStartupMaxAttempts}) ...`);
            }
            health = await startProxy(httpPort, serverJs, extensionVersion, bundleId);
            if (health) {
                break;
            }
        }
        if (!health) {
            throw new Error(
                `MCP proxy failed to start after ${proxyStartupMaxAttempts} attempts, ` +
                `see log: ${getLogPath(httpPort)}`
            );
        }
    }

    if (!isMcpHealthCompatible(health, extensionVersion, bundleId)) {
        throw new Error(
            `MCP proxy version mismatch after restart (running=${health.version}/${health.bundleId}, ` +
            `expected=${extensionVersion}/${bundleId})`
        );
    }

    return health;
}

export function makeIpcUnreachableError(
    httpPort: number,
    ipcPort: number,
    lastError?: Error
): Error {
    return new Error(
        `MCP proxy answered on HTTP port ${httpPort} but its IPC port ${ipcPort} is unreachable, ` +
        `and the IPC connection still failed after restarting the proxy once` +
        (lastError ? ` (last error: ${lastError.message})` : '') +
        `. Check 'EIDE.MCP.Server.Port' and see log: ${getLogPath(httpPort)}`
    );
}

export async function connectWithOneRestart(deps: {
    connect: () => Promise<void>;
    restart: () => Promise<void>;
}): Promise<'connected' | 'restarted' | 'failed'> {
    const connected = await deps.connect().then(() => true, () => false);
    if (connected) {
        return 'connected';
    }
    const restarted = await deps.restart().then(() => true, () => false);
    if (!restarted) {
        return 'failed';
    }
    const reconnected = await deps.connect().then(() => true, () => false);
    return reconnected ? 'restarted' : 'failed';
}

async function connectIpc(ipcPort: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const s = net.connect({ host: '127.0.0.1', port: ipcPort });
        const timer = setTimeout(() => {
            s.destroy();
            reject(new Error('IPC connect timeout'));
        }, ipcConnectTimeoutMs);

        s.once('connect', () => {
            clearTimeout(timer);
            resolve(s);
        });
        s.once('error', err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function sendRegister(sock: net.Socket, explorer: ProjectExplorer): void {
    sendMessage(sock, {
        type: 'register',
        instanceId: instanceId!,
        projects: collectProjects(explorer)
    });
}

function startPing(sock: net.Socket): void {
    if (pingTimer) {
        clearInterval(pingTimer);
    }
    pingTimer = setInterval(() => {
        sendMessage(sock, { type: 'ping' });
    }, ipcPingIntervalMs);
}

function setupMessageHandler(sock: net.Socket, explorer: ProjectExplorer): void {
    attachFrameReader(sock, async (msg: IpcMessage) => {
        if (msg.type === 'toolCall') {
            try {
                const result = await executeTool(msg.tool, msg.args, explorer);
                sendMessage(sock, { type: 'toolResult', requestId: msg.requestId, result });
            } catch (err) {
                sendMessage(sock, {
                    type: 'toolResult',
                    requestId: msg.requestId,
                    result: {
                        isError: true,
                        content: [{ type: 'text', text: `Tool error: ${err}` }]
                    }
                });
            }
        } else if (msg.type === 'ping') {
            sendMessage(sock, { type: 'pong' });
        }
    });
}

function setupProjectSync(explorer: ProjectExplorer): void {
    const pushProjects = () => {
        if (!socket || socket.destroyed) {
            return;
        }
        sendMessage(socket, { type: 'projects', projects: collectProjects(explorer) });
    };
    GlobalEvent.on('project.opened', pushProjects);
    GlobalEvent.on('project.closed', pushProjects);
    GlobalEvent.on('project.activeStatusChanged', pushProjects);
}

export function mcpClientInit(explorer: ProjectExplorer, sessionId: string): void {
    if (projectExplorer === explorer && instanceId === sessionId) {
        return;
    }
    projectExplorer = explorer;
    instanceId = sessionId;
    setupProjectSync(explorer);
}

export async function mcpClientConnect(
    httpPort: number,
    extensionPath: string,
    extensionVersion: string
): Promise<void> {
    if (!projectExplorer || !instanceId) {
        throw new Error('mcp client not inited');
    }

    const serverJs = path.join(extensionPath, 'dist', 'mcp_server.js');
    if (!fs.existsSync(serverJs)) {
        throw new Error(`MCP proxy not found: ${serverJs}`);
    }

    const bundleId = getMcpBundleId(serverJs);
    let health = await ensureProxyRunning(httpPort, serverJs, extensionVersion, bundleId);
    let pendingSocket: net.Socket | undefined;
    let lastError: Error | undefined;

    const outcome = await connectWithOneRestart({
        connect: async () => {
            try {
                pendingSocket = await connectIpc(health.ipcPort);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                throw error;
            }
        },
        restart: async () => {
            logInfo(
                `MCP proxy IPC port ${health.ipcPort} is unreachable, restarting proxy on port ${httpPort} ...`);
            try {
                health = await ensureProxyRunning(
                    httpPort, serverJs, extensionVersion, bundleId, true);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                throw error;
            }
        }
    });

    if (outcome === 'failed' || pendingSocket === undefined) {
        throw makeIpcUnreachableError(httpPort, health.ipcPort, lastError);
    }

    socket = pendingSocket;
    setupMessageHandler(socket, projectExplorer);
    sendRegister(socket, projectExplorer);
    startPing(socket);

    socket.on('close', () => {
        logInfo('Disconnected from MCP proxy');
    });
    socket.on('error', (err) => {
        logError('MCP proxy connection error', err);
    });

    logInfo(`Connected to MCP proxy (ipc=${health.ipcPort})`);
}

export async function mcpClientDisconnect(): Promise<void> {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = undefined;
    }
    if (socket) {
        const s = socket;
        socket = undefined;
        return new Promise(resolve => {
            s.once('close', resolve);
            s.destroy();
            setTimeout(resolve, 500);
        });
    }
}
