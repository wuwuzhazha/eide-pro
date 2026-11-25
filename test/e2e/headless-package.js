#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.resolve(__dirname, '..', '..');
const packageJson = require(path.join(root, 'package.json'));
const tarball = process.env.EIDE_HEADLESS_TARBALL
    || path.join(root, 'artifacts', `eide-pro-headless-${packageJson.version}.tgz`);
const toolchainRoot = process.env.ARM_GCC_ROOT || '/usr';

function fail(message) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
}

function assert(condition, message) {
    if (!condition) {
        fail(message);
    }
    console.log(`OK: ${message}`);
}

function runNpm(args, cwd) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return spawnSync(npm, args, {
        cwd,
        encoding: 'utf8',
        shell: process.platform === 'win32'
    });
}

function runNode(args, cwd) {
    return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
}

async function verifyMcp(serverPath, project, workspace) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath, '--project', project, '--toolchain-path', toolchainRoot],
        cwd: workspace,
        stderr: 'pipe'
    });
    const client = new Client({ name: 'eide-headless-e2e', version: '1.0.0' });
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert(tools.tools.length === 42, 'installed MCP server exposes 42 tools');
        const result = await client.callTool({
            name: 'eide_get_targets',
            arguments: { uid: 'headless-e2e' }
        });
        const data = JSON.parse(result.content[0].text);
        assert(data.actived === 'Debug', 'installed MCP server opens the project with bundled resources');
    } finally {
        await client.close();
    }
}

async function main() {
    if (!fs.existsSync(tarball)) {
        fail(`headless package not found: ${tarball}`);
    }
    const gcc = process.platform === 'win32' ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc';
    if (!fs.existsSync(path.join(toolchainRoot, 'bin', gcc))) {
        fail(`ARM GCC not found under ${toolchainRoot}/bin; set ARM_GCC_ROOT.`);
    }

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'eide-headless-e2e-'));
    try {
        const installRoot = path.join(workspace, 'install');
        const installed = runNpm(['install', '--prefix', installRoot, tarball], workspace);
        assert(installed.status === 0, `npm installs the headless package\n${installed.stderr}`);

        const installedRoot = path.join(installRoot, 'node_modules', 'eide-pro-headless');
        const cli = path.join(installedRoot, 'dist', 'eide_cli.js');
        const mcp = path.join(installedRoot, 'dist', 'eide_mcp.js');
        assert(fs.existsSync(cli), 'installed package contains eide-cli');
        assert(fs.existsSync(mcp), 'installed package contains eide-mcp');
        assert(!fs.existsSync(path.join(installedRoot, 'res', 'html')),
            'installed package excludes editor-only res/html');
        const skill = path.join(installedRoot, 'skills', 'eide-mcp-tools', 'SKILL.md');
        assert(fs.existsSync(skill), 'installed package contains the MCP skill');

        const help = runNode([cli, '--help'], workspace);
        assert(help.status === 0 && help.stdout.includes('Usage:'), 'installed eide-cli starts');
        assert(help.stdout.includes('-v, --version'), 'installed eide-cli documents --version');

        const installedVersion = runNode([cli, '--version'], workspace);
        assert(installedVersion.status === 0, `installed eide-cli reports a version\n${installedVersion.stderr}`);
        assert(installedVersion.stdout === `${packageJson.version}\n`,
            `installed eide-cli version matches package.json (${installedVersion.stdout.trim()})`);

        const printedSkill = runNode([mcp, '--print-skill'], workspace);
        const bundledSkill = fs.readFileSync(skill);
        assert(printedSkill.status === 0, `installed eide-mcp prints the skill\n${printedSkill.stderr}`);
        assert(Buffer.compare(Buffer.from(printedSkill.stdout), bundledSkill) === 0,
            'installed eide-mcp --print-skill matches the bundled skill byte for byte');
        assert(printedSkill.stdout.includes('name: eide-mcp-tools'),
            'installed eide-mcp --print-skill contains the skill frontmatter');

        const project = path.join(workspace, 'project');
        fs.cpSync(path.join(__dirname, 'fixtures', 'cortex-m3'), project, { recursive: true });
        const build = runNode([
            cli, 'build', '--project', project, '--toolchain-path', toolchainRoot,
            '--timeout', '120000'
        ], workspace);
        assert(build.status === 0, `installed eide-cli builds the fixture\n${build.stderr}`);
        let result;
        try {
            result = JSON.parse(build.stdout);
        } catch (error) {
            fail(`build did not return one JSON object: ${error.message}\n${build.stdout}`);
        }
        assert(result.success === true, 'installed eide-cli reports a successful build');
        const elf = (result.artifacts || []).find(file => file.endsWith('.elf'));
        assert(typeof elf === 'string' && fs.existsSync(elf), 'installed eide-cli produces an ELF');

        const createParent = path.join(workspace, 'created');
        fs.mkdirSync(createParent);
        const create = runNode([
            cli, 'create', '--name', 'from-template', '--template', 'stm32f1xx_gcc',
            '--output', createParent, '--project-name', 'from-template'
        ], workspace);
        assert(create.status === 0, `installed eide-cli creates a project\n${create.stderr}`);
        const created = JSON.parse(create.stdout);
        assert(created.success === true && created.type === 'ARM',
            'installed eide-cli create returns project metadata');
        const createdConfig = path.join(created.projectPath, '.eide', 'eide.yml');
        assert(fs.existsSync(createdConfig), 'installed eide-cli create writes eide.yml');
        const createPlan = runNode([
            cli, 'plan', '--project', created.projectPath, '--toolchain-path', toolchainRoot
        ], workspace);
        assert(createPlan.status === 0,
            `installed eide-cli plans a created project\n${createPlan.stderr}`);
        const createResult = JSON.parse(createPlan.stdout);
        assert(createResult.success === true && createResult.command === 'plan',
            'created project generates a build plan');
        assert(fs.existsSync(createResult.paramsFile), 'created project writes builder params');
        assert(createResult.params.toolchain === 'GCC', 'created project selects the template toolchain');

        await verifyMcp(mcp, project, workspace);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

main().then(
    () => console.log('Headless package E2E passed.'),
    error => {
        console.error(error);
        process.exitCode = 1;
    }
);
