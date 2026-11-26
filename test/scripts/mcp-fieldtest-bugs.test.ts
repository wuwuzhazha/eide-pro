const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');

require('../../../src/headless/vscode').installVscodeShim();

const { executeTool } = require('../../../src/mcp/mcp_impl');
const { createHeadlessToolExecutor } = require('../../../src/mcp/headless_tools');
const { openHeadlessProject } = require('../../../src/headless/host');

const failures: string[] = [];

function check(cond: boolean, msg: string): void {
    if (cond) {
        console.log('OK:', msg);
    } else {
        console.error('FAIL:', msg);
        failures.push(msg);
    }
}

function payload(result: any): any {
    const text = result.content[0].text;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

const repoRoot = NodePath.join(__dirname, '..', '..', '..', '..');
const resourcesDir = NodePath.join(repoRoot, 'res');
const fixture = NodePath.join(repoRoot, 'test', 'e2e', 'fixtures', 'cortex-m3');
const root = NodePath.join(os.tmpdir(), `eide-mcp-fieldtest-${process.pid}-${Date.now()}`);
const projectDir = NodePath.join(root, 'project');
const eideFile = NodePath.join(projectDir, '.eide', 'eide.yml');

const stubToolchain = NodePath.join(root, 'toolchain');
const stubGcc = NodePath.join(stubToolchain, 'bin',
    `arm-none-eabi-gcc${process.platform === 'win32' ? '.exe' : ''}`);

function createStubToolchain(): void {
    fs.mkdirSync(NodePath.join(stubToolchain, 'bin'), { recursive: true });
    fs.writeFileSync(stubGcc, '');
}

function readConfig(): any {
    return yaml.parse(fs.readFileSync(eideFile, 'utf8'));
}

function writeConfig(config: any): void {
    fs.writeFileSync(eideFile, yaml.stringify(config));
}

function seedJlinkConfig(): void {
    const config = readConfig();
    config.targets.Debug.uploadConfigMap.JLink = {
        bin: '',
        baseAddr: '0x08000000',
        cpuInfo: { cpuName: 'STM32F103C8', vendor: 'ST' },
        proType: 1,
        speed: 4000,
        otherCmds: ''
    };
    writeConfig(config);
}

function seedPreprocessAttrs(): void {
    const config = readConfig();
    config.targets.Debug.cppPreprocessAttrs.incList = ['include/app'];
    config.targets.Debug.cppPreprocessAttrs.defineList = ['BOARD_M3'];
    writeConfig(config);
}

class CountingRunner {
    calls: Array<{ file: string; args: string[] }> = [];

    async run(file: string, args: string[]): Promise<any> {
        this.calls.push({ file, args });
        return { code: 0, stdout: 'Programmed successfully', stderr: '' };
    }
}

function headlessResources(): string {
    const dir = NodePath.join(root, 'res');
    fs.cpSync(NodePath.join(repoRoot, 'res', 'data'), NodePath.join(dir, 'data'), { recursive: true });
    fs.mkdirSync(NodePath.join(dir, 'tools'), { recursive: true });
    return dir;
}

// BUG-1: eide_flash with dryRun=true must not reach the hardware path.
async function checkFlashDryRunExtension(prj: any, uid: string): Promise<void> {
    let programFlashCalls = 0;
    const explorer = {
        getProjectByUid: (id: string) => id === uid ? prj : undefined,
        programFlashProject: async () => {
            programFlashCalls++;
            return { success: true, message: 'flashed' };
        }
    };

    const dry = await executeTool('eide_flash', { uid, eraseAll: false, dryRun: true }, explorer);
    const data = payload(dry);
    check(programFlashCalls === 0,
        `BUG-1 ext: programFlashProject not called on dryRun (calls=${programFlashCalls})`);
    check(dry.isError !== true && data.success === true && data.dryRun === true,
        `BUG-1 ext: dryRun result shape (${JSON.stringify({ isError: dry.isError, success: data.success, dryRun: data.dryRun })})`);
    check(typeof data.command === 'string' && data.command.length > 0,
        `BUG-1 ext: dryRun carries a command/plan description (${JSON.stringify(data.command ?? null).slice(0, 80)})`);
    check(data.invocation !== undefined && data.invocation.executable !== undefined
        && data.command.includes('-Device'),
        `BUG-1 ext: configured JLink project yields the planned invocation (${JSON.stringify(data.invocation ? data.invocation.executable : null)})`);
    check(data !== null && typeof data === 'object' && !('stdout' in data) && !('stderr' in data),
        'BUG-1 ext: dryRun result has no execution output fields');

    const dryEraseData = payload(await executeTool('eide_flash', { uid, eraseAll: true, dryRun: true }, explorer));
    check(programFlashCalls === 0 && dryEraseData !== null && typeof dryEraseData === 'object'
        && dryEraseData.dryRun === true,
        'BUG-1 ext: eraseAll dryRun still does not program');

    const real = await executeTool('eide_flash', { uid, eraseAll: false }, explorer);
    check(programFlashCalls >= 1 && real.isError !== true,
        `BUG-1 ext control: non-dryRun flash DOES reach programFlashProject (calls=${programFlashCalls})`);
}

async function checkFlashDryRunFallback(prj: any, uid: string): Promise<void> {
    // empty JLink config (no cpuInfo) can never produce a command plan, but the
    // dry-run must still stay off the hardware and report the planning failure.
    let programFlashCalls = 0;
    const explorer = {
        getProjectByUid: (id: string) => id === uid ? prj : undefined,
        programFlashProject: async () => {
            programFlashCalls++;
            return { success: true, message: 'flashed' };
        }
    };
    const result = await executeTool('eide_flash', { uid, eraseAll: false, dryRun: true }, explorer);
    const data = payload(result);
    check(programFlashCalls === 0 && data.dryRun === true,
        'BUG-1 ext: unplannable project still stays off hardware on dryRun');
    check(typeof data.planningError === 'string' && data.planningError.length > 0,
        `BUG-1 ext: unplannable project reports planningError (${JSON.stringify(data.planningError ?? null).slice(0, 90)})`);
    check(typeof data.command === 'string' && data.command.includes('JLink'),
        'BUG-1 ext: fallback command is a plan description');
}

async function checkFlashDryRunHeadless(): Promise<void> {
    const runner = new CountingRunner();
    const execute = createHeadlessToolExecutor({
        projectPaths: [projectDir],
        resourcesDir: headlessResources(),
        flasherExecutable: process.platform === 'win32' ? 'C:/tools/JLink.exe' : '/opt/jlink/JLinkExe',
        buildTimeoutMs: 10000,
        flashTimeoutMs: 10000,
        runner
    });
    const result = await execute('eide_flash', { uid: 'headless-e2e', eraseAll: false, dryRun: true });
    const data = payload(result);
    check(data !== null && typeof data === 'object' && data.success === true && data.dryRun === true,
        `BUG-1 headless: flash dryRun reports dryRun:true (${JSON.stringify({ success: data?.success, dryRun: data?.dryRun })})`);
    check(runner.calls.length === 0,
        `BUG-1 headless: no process spawned on dryRun (calls=${runner.calls.length})`);
}

// BUG-2: list tools must return structuredContent objects with an items array.
async function checkArrayContract(execute: (tool: string, args: any) => Promise<any>,
    uid: string, label: string): Promise<void> {
    for (const tool of ['eide_get_src_dirs', 'eide_get_inc_dirs', 'eide_get_defines']) {
        const result = await execute(tool, { uid });
        const structured = result.structuredContent;
        check(structured !== undefined && typeof structured === 'object' && !Array.isArray(structured),
            `BUG-2 ${label}: ${tool} structuredContent is an object (${Array.isArray(structured) ? 'array' : typeof structured})`);
        check(structured !== undefined && Array.isArray((structured as any).items),
            `BUG-2 ${label}: ${tool} structuredContent.items is an array`);
        const text = payload(result);
        check(text !== null && typeof text === 'object' && !Array.isArray(text) && Array.isArray(text.items),
            `BUG-2 ${label}: ${tool} text payload carries the same object shape`);
    }
}

// BUG-3: eide_get_environment must be implemented on the extension side too.
// Regression guard: zod strips undeclared keys, so dryRun must be declared in
// the non-headless schema or the safety parameter never reaches the
// implementation over the VS Code HTTP transport.
async function checkTransportDryRunDelivery(): Promise<void> {
    const { createMcpServer } = require('../../../src/mcp/mcp_proxy_tools');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

    for (const headless of [false, true]) {
        let received: any = null;
        const server = createMcpServer(async (_tool: string, args: any) => {
            received = args;
            return { content: [{ type: 'text', text: 'ok' }] };
        }, { version: 'test', headless });
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        await server.connect(serverT);
        const client = new Client({ name: 't', version: '1' });
        await client.connect(clientT);
        try {
            await client.callTool({
                name: 'eide_flash',
                arguments: { uid: 'x', eraseAll: false, dryRun: true }
            });
            check(received !== null && received.dryRun === true,
                `transport (${headless ? 'headless' : 'extension'}): dryRun survives zod validation (got ${JSON.stringify(received)})`);
        } finally {
            await client.close();
            await server.close();
        }
    }
}

async function checkEnvironmentExtension(prj: any, uid: string): Promise<void> {
    const explorer = { getProjectByUid: (id: string) => id === uid ? prj : undefined };
    const result = await executeTool('eide_get_environment', { uid }, explorer);
    const data = payload(result);
    check(result.isError !== true && data !== null && typeof data === 'object',
        `BUG-3 ext: eide_get_environment implemented (isError=${result.isError})`);
    check(data !== null && typeof data === 'object'
        && typeof data.target === 'string' && data.target.length > 0
        && typeof data.toolchain === 'string' && data.toolchain.length > 0
        && Array.isArray(data.tools) && Array.isArray(data.searched),
        `BUG-3 ext: environment report shape (${JSON.stringify({ target: data?.target, toolchain: data?.toolchain })})`);
    const gcc = data !== null && typeof data === 'object' && Array.isArray(data.tools)
        ? data.tools.find((tool: any) => tool.name.includes('gcc'))
        : undefined;
    check(gcc !== undefined && gcc.source === 'settings'
        && typeof gcc.path === 'string' && NodePath.resolve(gcc.path) === NodePath.resolve(stubGcc),
        `BUG-3 ext: gcc resolved from settings into the stub toolchain (${JSON.stringify(gcc)})`);
    check(data !== null && typeof data === 'object' && Array.isArray(data.searched)
        && data.searched.some((entry: string) => entry.includes('ARM.GCC.InstallDirectory')),
        'BUG-3 ext: searched evidence chain names the settings key');

    const bad = await executeTool('eide_get_environment', { uid, target: 'NoSuchTarget' }, explorer);
    check(bad.isError === true && bad.content[0].text.includes('NoSuchTarget'),
        'BUG-3 ext: unknown target fails explicitly');
}

async function run(): Promise<void> {
    fs.cpSync(fixture, projectDir, { recursive: true });
    fs.rmSync(NodePath.join(projectDir, 'build'), { recursive: true, force: true });
    seedPreprocessAttrs();
    createStubToolchain();

    const session = await openHeadlessProject({
        projectPath: projectDir,
        resourcesDir,
        extensionRoot: repoRoot,
        toolchainPath: stubToolchain
    });
    try {
        const prj = session.project;
        const uid = prj.getUid();
        const explorer = { getProjectByUid: (id: string) => id === uid ? prj : undefined };

        // fixture ships an empty JLink config: cover the unplannable fallback first
        await checkFlashDryRunFallback(prj, uid);

        // then seed a complete flash configuration for the planned-invocation path
        // (the flash plan reads eide.yml from disk, no project reload needed)
        seedJlinkConfig();
        await checkFlashDryRunExtension(prj, uid);
        await checkFlashDryRunHeadless();

        await checkArrayContract(
            (tool, args) => executeTool(tool, args, explorer), uid, 'ext');

        const headlessExecute = createHeadlessToolExecutor({
            projectPaths: [projectDir],
            resourcesDir: headlessResources(),
            toolchainPath: stubToolchain,
            buildTimeoutMs: 10000,
            flashTimeoutMs: 10000,
            runner: new CountingRunner()
        });
        await checkArrayContract(
            (tool, args) => headlessExecute(tool, args), 'headless-e2e', 'headless');

        await checkEnvironmentExtension(prj, uid);

        await checkTransportDryRunDelivery();
    } finally {
        session.close();
    }

    if (failures.length > 0) {
        throw new Error(`${failures.length} assertion(s) failed.`);
    }
}

run()
    .then(() => {
        console.log('All mcp fieldtest bug regression tests passed.');
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        process.exit(0);
    })
    .catch(error => {
        console.error(error);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        process.exit(1);
    });
export {};
