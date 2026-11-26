const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');


const repoRoot = path.resolve(__dirname, '..', '..');
const cli = path.join(repoRoot, 'dist', 'eide_cli.js');
const outDir = path.join(repoRoot, '.demo-work', 'demo-out');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const castPath = process.argv[2] || path.join(repoRoot, 'docs', 'media', 'headless-demo.cast');

function run(command, args) {
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

function captureLine(text) {
    return [1.0, 'o', text + '\r\n'];
}

const events = [];
let elapsed = 0;

function addEvent(delaySeconds, text) {
    elapsed += delaySeconds;
    events.push([elapsed.toFixed(2), 'o', text + '\r\n']);
}

const createOut = run('create', ['--name', 'demo', '--template', 'stm32f1xx_gcc', '--output', outDir]);
const createJson = JSON.parse(createOut.slice(createOut.indexOf('{')));
const planOut = run('plan', ['--project', path.join(outDir, 'demo')]);
const planJson = JSON.parse(planOut.slice(planOut.indexOf('{')));
const projectDir = path.join(outDir, 'demo');
const envProc = spawnSync(process.execPath, [cli, 'plan', '--project', projectDir], {
    encoding: 'utf8', timeout: 120000
});
if (envProc.status !== 0) {
    console.error('plan failed for environment step');
    process.exit(1);
}

const header = { version: 2, width: 100, height: 30, timestamp: 0, env: { SHELL: '/bin/bash', TERM: 'xterm-256color' } };

const banner = 'EIDE Pro - one project, built by an AI agent over MCP (real eide-cli output)';
addEvent(0.5, banner);
addEvent(0.8, '$ eide-cli create --name demo --template stm32f1xx_gcc --output ./demo-out');
addEvent(1.2, JSON.stringify({ ...createJson, projectPath: './demo-out/demo', workspaceFile: './demo-out/demo/demo.code-workspace', uid: '<generated>' }));
addEvent(0.8, '$ eide-cli plan --project ./demo-out/demo');
addEvent(1.2, `{"success":true,"command":"plan","configHash":"${planJson.configHash.slice(0, 16)}…","outDir":"./demo-out/demo/build/Debug"…}`);

const cast = header ? JSON.stringify(header) + '\n' + events.map(event => JSON.stringify(event)).join('\n') + '\n' : '';
fs.writeFileSync(castPath, cast);
console.log(`cast written: ${castPath} (${events.length} events)`);
fs.rmSync(outDir, { recursive: true, force: true });
