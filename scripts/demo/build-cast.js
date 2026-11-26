const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const cli = path.join(repoRoot, 'dist', 'eide_cli.js');
const mcp = path.join(repoRoot, 'dist', 'eide_mcp.js');
const workRoot = path.join(repoRoot, '.demo-work');
const outDir = path.join(workRoot, 'demo-out');
const projectDir = path.join(outDir, 'demo');
const castPath = process.argv[2] || path.join(repoRoot, 'docs', 'media', 'headless-demo.cast');
fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function resolveToolchainRoot() {
    const candidates = [];
    if (process.env.EIDE_DEMO_GCC) {
        candidates.push(process.env.EIDE_DEMO_GCC);
    }
    candidates.push('D:/GNU Arm Embedded Toolchain/10 2021.10');
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'bin', 'arm-none-eabi-gcc.exe'))
            || fs.existsSync(path.join(candidate, 'bin', 'arm-none-eabi-gcc'))) {
            return candidate;
        }
    }
    const probe = spawnSync('arm-none-eabi-gcc', ['--version'], { encoding: 'utf8', timeout: 30000 });
    if (probe.status === 0) {
        console.error('arm-none-eabi-gcc found on PATH but its toolchain root cannot be derived; set EIDE_DEMO_GCC to the toolchain root.');
        process.exit(1);
    }
    console.error('No ARM GCC toolchain root found. Checked EIDE_DEMO_GCC and the default install path.');
    process.exit(1);
}

const toolchainRoot = resolveToolchainRoot();

function runCli(command, args) {
    const result = spawnSync(process.execPath, [cli, command, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120000
    });
    if (result.status !== 0 || !(result.stdout || '').trim()) {
        console.error(`command failed: eide-cli ${command} ${args.join(' ')}`);
        console.error(`exit: ${result.status}`);
        console.error(((result.stdout || '') + (result.stderr || '')).slice(0, 2000));
        process.exit(1);
    }
    return result.stdout.trim();
}

function normalizeJsonLine(text) {
    const start = text.indexOf('{');
    return JSON.parse(text.slice(start));
}

const events = [];
let elapsed = 0;

function addEvent(delaySeconds, text) {
    elapsed += delaySeconds;
    events.push([elapsed.toFixed(2), 'o', text + '\r\n']);
}

const createOut = runCli('create', ['--name', 'demo', '--template', 'stm32f1xx_gcc', '--output', outDir]);
const createJson = normalizeJsonLine(createOut);
const projectUid = createJson.uid;

function mcpCall(requests) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [mcp, '--project', projectDir, '--toolchain-path', toolchainRoot]);
        let buffer = '';
        const responses = new Map();
        child.stdout.on('data', data => {
            buffer += data;
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                if (!line.trim()) {
                    continue;
                }
                try {
                    const message = JSON.parse(line);
                    if (message.id !== undefined && requests.has(message.id)) {
                        responses.set(message.id, message);
                    }
                } catch {
                    reject(new Error(`unparsable MCP response: ${line.slice(0, 200)}`));
                    child.kill();
                    return;
                }
            }
        });
        child.stderr.on('data', () => {});
        child.on('exit', () => resolve(responses));
        child.stdin.write(JSON.stringify(requests.get(1)) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        setTimeout(() => {
            for (const request of requests.values()) {
                child.stdin.write(JSON.stringify(request) + '\n');
            }
        }, 500);
        setTimeout(() => {
            if (responses.size < requests.size) {
                reject(new Error(`MCP server answered ${responses.size} of ${requests.size} requests`));
            }
            child.kill();
        }, 120000);
    });
}

async function main() {
    addEvent(0.5, 'EIDE Pro - an AI agent builds a firmware project over MCP (real captured output)');
    addEvent(0.8, '$ eide-cli create --name demo --template stm32f1xx_gcc --output ./demo-out');
    addEvent(1.2, JSON.stringify({ ...createJson, projectPath: './demo-out/demo', workspaceFile: './demo-out/demo/demo.code-workspace', uid: '<generated>' }));

    const buildRequest = { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'eide_build', arguments: { uid: projectUid } } };
    const envRequest = { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'eide_get_environment', arguments: { uid: projectUid } } };
    const initRequest = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eide-demo-agent', version: '0' } } };
    const responses = await mcpCall(new Map([[1, initRequest], [10, buildRequest], [11, envRequest]]));

    const initResponse = responses.get(1);
    if (!initResponse || initResponse.result.protocolVersion !== '2025-11-25') {
        console.error('MCP protocol negotiation failed');
        process.exit(1);
    }

    addEvent(0.8, '$ eide-mcp --project ./demo-out/demo  (protocol 2025-11-25)');
    const buildMessage = responses.get(10);
    const buildJson = JSON.parse(buildMessage.result.content[0].text);
    if (!buildJson.success || (buildJson.artifacts || []).length === 0) {
        console.error(`MCP build failed: ${JSON.stringify(buildJson).slice(0, 1000)}`);
        process.exit(1);
    }
    addEvent(0.6, '> tools/call eide_build {uid}');
    addEvent(1.5, `{"success":true,"stage":"${buildJson.stage}","problems":[… ${(buildJson.problems || []).length} entries …],"memory":{"FLASH":{"used":${buildJson.memory.FLASH.used}…}},"artifacts":[… ${(buildJson.artifacts || []).length} files …],"… truncated for display …}`);

    const envMessage = responses.get(11);
    const envJson = JSON.parse(envMessage.result.content[0].text);
    const gccEntry = (envJson.tools || []).find(tool => tool.name.startsWith('arm-none-eabi-gcc'));
    if (!gccEntry || !gccEntry.path) {
        console.error('environment tool did not resolve arm-none-eabi-gcc');
        process.exit(1);
    }
    addEvent(0.6, '> tools/call eide_get_environment {uid}');
    addEvent(1.5, `{"target":"${envJson.target}","toolchain":"${envJson.toolchain}","tools":[{"name":"${gccEntry.name}","path":"<toolchain>\\bin\\arm-none-eabi-gcc.exe","source":"${gccEntry.source}"},… truncated for display …]}`);

    const cast = JSON.stringify({ version: 2, width: 100, height: 30, timestamp: 0, env: { SHELL: '/bin/bash', TERM: 'xterm-256color' } })
        + '\n' + events.map(event => JSON.stringify(event)).join('\n') + '\n';
    fs.writeFileSync(castPath, cast);
    console.log(`cast written: ${castPath} (${events.length} events)`);
    fs.rmSync(workRoot, { recursive: true, force: true });
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
