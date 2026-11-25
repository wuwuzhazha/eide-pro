const net = require('net');
const {
    ensureIpcPortAvailable,
    getIpcPort,
    probeLocalPort
} = require('../../../src/mcp/mcp_protocol') as any;

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Could not allocate a free port')));
                return;
            }
            server.close(() => resolve(address.port));
        });
    });
}

function listen(server: any, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
}

function close(server: any): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

async function run(): Promise<void> {
    assert(getIpcPort(8940) === 8941, 'ipc port remains httpPort + 1');

    const port = await freePort();
    assert(await probeLocalPort(port) === 'available', 'probe reports an available port');
    const blocker = net.createServer();
    await listen(blocker, port);
    try {
        assert(await probeLocalPort(port) === 'occupied', 'probe reports an occupied port');
        let message = '';
        try {
            await ensureIpcPortAvailable(port - 1);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        assert(message.includes(String(port))
            && message.includes('EIDE.MCP.Server.Port')
            && message.includes('+ 1'),
        `ipc conflict error is explicit: ${message}`);
    } finally {
        await close(blocker);
    }
    assert(await probeLocalPort(port) === 'available', 'probe reports released port as available');
    console.log('mcp ipc port tests passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
export {};
