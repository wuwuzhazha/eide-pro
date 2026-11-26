import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as NodePath from 'path';

const { downloadHttpsFile, fetchHttpsText } = require('../../../src/core/https_download');

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

function guard<T>(promise: Promise<T>, name: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => setTimeout(
            () => reject(new Error(`FAIL: ${name} exceeded 5s guard`)), 5000))
    ]);
}

async function withServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    run: (base: string) => Promise<void>
): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('failed to allocate local HTTP port');
    }
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

async function run(): Promise<void> {
    const get = http.get as any;

    await withServer((_req, res) => {
        res.writeHead(200, { 'content-length': '10' });
    }, async base => {
        const dest = NodePath.join(fs.mkdtempSync(NodePath.join(os.tmpdir(), 'https-download-')), 'partial');
        const started = Date.now();
        let message = '';
        try {
            await guard(downloadHttpsFile(`${base}/stall`, dest, undefined, 200, get), 'idle timeout');
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        assert(message.includes('timed out after 200 ms') && message.includes(`${base}/stall`),
            `idle timeout: explicit error with URL (${message})`);
        assert(Date.now() - started < 2000, `idle timeout: fails promptly (${Date.now() - started}ms)`);
    });

    await withServer((_req, res) => {
        res.writeHead(200, { 'content-length': '10' });
        res.write('abc');
    }, async base => {
        let message = '';
        try {
            await guard(fetchHttpsText(`${base}/half`, 200, get), 'partial timeout');
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        assert(message.includes('timed out after 200 ms') && message.includes(`${base}/half`),
            `partial response: explicit timeout (${message})`);
    });

    await withServer((_req, res) => {
        res.writeHead(200, { 'content-length': '5' });
        res.end('hello');
    }, async base => {
        const dest = NodePath.join(fs.mkdtempSync(NodePath.join(os.tmpdir(), 'https-download-')), 'ok.bin');
        await guard(downloadHttpsFile(`${base}/ok`, dest, undefined, 500, get), 'normal download');
        assert(fs.readFileSync(dest, 'utf8') === 'hello', 'normal download: content is correct');
        assert(await guard(fetchHttpsText(`${base}/ok`, 500, get), 'normal text') === 'hello',
            'normal text: content is correct');
    });

    await withServer((req, res) => {
        if (req.url === '/redirect') {
            res.writeHead(302, { location: '/target' });
            res.end();
            return;
        }
        res.writeHead(200, { 'content-length': '6' });
        res.end('target');
    }, async base => {
        assert(await guard(fetchHttpsText(`${base}/redirect`, 500, get), 'redirect') === 'target',
            'redirect: follows one hop and returns target body');
    });

    console.log('All https download tests passed.');
}

run().catch(error => {
    console.error('FAIL:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
