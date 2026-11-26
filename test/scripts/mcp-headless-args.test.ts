import * as fs from 'fs';
import * as NodePath from 'path';

const { main } = require('../../../src/mcp/headless_main') as any;

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

const expectedVersion = JSON.parse(
    fs.readFileSync(NodePath.join(process.cwd(), 'package.json'), 'utf8')
).version as string;

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    process.stdout.write = (chunk: any) => { out.push(String(chunk)); return true; };
    process.stderr.write = (chunk: any) => { err.push(String(chunk)); return true; };
    try {
        const code = await main(argv, NodePath.join(process.cwd(), 'package.json'));
        return { code, stdout: out.join(''), stderr: err.join('') };
    } finally {
        process.stdout.write = stdout;
        process.stderr.write = stderr;
    }
}

async function runCases(): Promise<void> {
    // --version must be a standalone action: no --project, no server startup.
    const version = await run(['--version']);
    assert(version.code === 0, `mcp args: --version exits 0 (${JSON.stringify(version)})`);
    assert(version.stdout === `${expectedVersion}\n`,
        `mcp args: --version prints the package.json version (${JSON.stringify(version.stdout)})`);
    assert(version.stderr.length === 0, 'mcp args: --version reports no diagnostics');

    const short = await run(['-v']);
    assert(short.code === 0 && short.stdout === `${expectedVersion}\n`,
        `mcp args: -v prints the same version (${JSON.stringify(short)})`);

    const help = await run(['--help']);
    assert(help.code === 0 && help.stdout.includes('-v, --version'),
        `mcp args: help lists --version (${JSON.stringify(help.stdout)})`);

    const unknown = await run(['--unknown']);
    assert(unknown.code === 3 && unknown.stderr.includes('Unknown option'),
        `mcp args: unknown options are still rejected (${JSON.stringify(unknown)})`);

    console.log('All mcp headless args tests passed.');
}

runCases().catch(error => {
    console.error('FAIL:', error);
    process.exit(1);
});
export {};
