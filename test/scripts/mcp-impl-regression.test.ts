const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');
const { deepStrictEqual } = require('assert');

require('../../../src/headless/vscode').installVscodeShim();

const { executeTool, makeBuildResult } = require('../../../src/mcp/mcp_impl');
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

function checkDeepEqual(actual: unknown, expected: unknown, msg: string): void {
    try {
        deepStrictEqual(actual, expected);
        console.log('OK:', msg);
    } catch (error) {
        console.error('FAIL:', msg, '\n  ' + (error instanceof Error ? error.message : String(error)));
        failures.push(msg);
    }
}

function payload(result: any): any {
    return JSON.parse(result.content[0].text);
}

function depSnapshot(prj: any): any {
    return prj.GetConfiguration().config.dependenceList.map((group: any) => ({
        group: group.groupName,
        deps: group.depList.map((dep: any) => ({
            name: dep.name,
            inc: dep.incList.length,
            lib: dep.libList.length,
            define: dep.defineList.length
        }))
    }));
}

function customDep(prj: any): any {
    return prj.GetConfiguration().GetDependence('custom', 'default');
}

const repoRoot = NodePath.join(__dirname, '..', '..', '..', '..');
const resourcesDir = NodePath.join(repoRoot, 'res');
const fixture = NodePath.join(repoRoot, 'test', 'e2e', 'fixtures', 'cortex-m3');
const root = NodePath.join(os.tmpdir(), `eide-mcp-impl-${process.pid}-${Date.now()}`);
const projectDir = NodePath.join(root, 'project');
const eideFile = NodePath.join(projectDir, '.eide', 'eide.yml');

const abs = (rel: string) => NodePath.join(projectDir, rel);

const stubToolchain = NodePath.join(root, 'toolchain');
const stubGcc = NodePath.join(stubToolchain, 'bin',
    `arm-none-eabi-gcc${process.platform === 'win32' ? '.exe' : ''}`);

function createStubToolchain(): void {
    fs.mkdirSync(NodePath.join(stubToolchain, 'bin'), { recursive: true });
    fs.writeFileSync(stubGcc, '');
    if (!fs.existsSync(stubGcc)) {
        throw new Error(`Stub toolchain was not created: ${stubGcc}`);
    }
    console.log('OK: stub toolchain created at', stubToolchain);
}

async function openProject(): Promise<any> {
    try {
        return await openHeadlessProject({
            projectPath: projectDir,
            resourcesDir,
            extensionRoot: repoRoot,
            toolchainPath: stubToolchain
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Toolchain '.*' is not installed|not configured/i.test(message)) {
            throw new Error(
                `openHeadlessProject must receive an explicit toolchainPath (stub: ${stubToolchain}); ` +
                `the host fell back to discovering the toolchain on this machine: ${message}`);
        }
        throw error;
    }
}

function checkToolchainInUse(prj: any): void {
    const { ToolchainManager } = require('../../../src/ToolchainManager');
    const folder = ToolchainManager.getInstance()
        .getToolchainExecutableFolder(prj.getToolchain().name);
    check(folder !== undefined && NodePath.resolve(folder.path) === NodePath.resolve(NodePath.join(stubToolchain, 'bin')),
        `project resolves the stub toolchain (${folder ? folder.path : 'undefined'})`);
}

function seedProjectConfig(): void {
    const config = yaml.parse(fs.readFileSync(eideFile, 'utf8'));
    const target = config.targets[config.mode || 'Debug'];
    target.cppPreprocessAttrs.incList = ['include/app', 'include/driver'];
    target.cppPreprocessAttrs.defineList = ['BOARD_M3', 'DEBUG_LOG'];
    fs.writeFileSync(eideFile, yaml.stringify(config));
}

function seedBuildInDep(prj: any): void {
    const dep = prj.GetConfiguration().GetDependence('build-in', 'toolchain');
    dep.incList.push(abs('include/toolchain'));
    dep.defineList.push('TOOLCHAIN_DEF');
    prj.GetConfiguration().CustomDep_NotifyChanged();
}

async function checkReadWriteSymmetry(prj: any, uid: string, explorer: any): Promise<void> {
    const incBefore = payload(await executeTool('eide_get_inc_dirs', { uid }, explorer)).items;
    const defBefore = payload(await executeTool('eide_get_defines', { uid }, explorer)).items;
    const depBefore = depSnapshot(prj);

    check(incBefore.length === 2 && !incBefore.includes('include/toolchain'),
        `get_inc_dirs reads the custom dep only (${JSON.stringify(incBefore)})`);
    check(defBefore.length === 2 && !defBefore.includes('TOOLCHAIN_DEF'),
        `get_defines reads the custom dep only (${JSON.stringify(defBefore)})`);

    await executeTool('eide_set_inc_dirs', { uid, paths: incBefore }, explorer);
    await executeTool('eide_set_defines', { uid, defines: defBefore }, explorer);

    const incAfter = payload(await executeTool('eide_get_inc_dirs', { uid }, explorer)).items;
    const defAfter = payload(await executeTool('eide_get_defines', { uid }, explorer)).items;
    const depAfter = depSnapshot(prj);

    checkDeepEqual(incAfter, incBefore, 'get -> set -> get keeps inc dirs identical');
    checkDeepEqual(defAfter, defBefore, 'get -> set -> get keeps defines identical');

    checkDeepEqual(depAfter, depBefore,
        'dependenceList groups and entry counts are unchanged by the round trip');

    check(customDep(prj).incList.length === 2 && customDep(prj).defineList.length === 2,
        'custom dep did not absorb entries from the other group');
}

function checkBuildResultShape(prj: any): void {
    const okRes = makeBuildResult(prj, true, 'Succeed.');
    const ok = payload(okRes);
    check(okRes.isError === false && ok.success === true && ok.failureKind === undefined,
        `build result: success shape (${JSON.stringify({ isError: okRes.isError, success: ok.success, failureKind: ok.failureKind, stage: ok.stage })})`);

    const timeoutRes = makeBuildResult(prj, false, 'Failed.\n\nError: build timed out', 'timeout');
    const timeout = payload(timeoutRes);
    check(timeoutRes.isError === true && timeout.success === false && timeout.failureKind === 'timeout',
        `build result: timeout shape (${JSON.stringify({ isError: timeoutRes.isError, success: timeout.success, failureKind: timeout.failureKind, stage: timeout.stage })})`);

    const shared = ['success', 'stage', 'problems', 'memory'];
    const missing = shared.filter(key => !(key in ok) || !(key in timeout));
    check(missing.length === 0, `build result: success and failure share fields (${shared.join(', ')})`);
    check('logTail' in timeout && !('logTail' in ok), 'build result: only failures carry logTail');
}

async function checkBuildPathThreading(uid: string, prj: any): Promise<void> {
    const timeoutExplorer = {
        getProjectByUid: () => prj,
        buildProject: async () => ({
            success: false,
            message: 'Failed.\n\nError: build timed out',
            failureKind: 'timeout'
        })
    };
    const timeoutRes = await executeTool('eide_build', { uid }, timeoutExplorer);
    const timeout = payload(timeoutRes);
    check(timeoutRes.isError === true && timeout.success === false && timeout.failureKind === 'timeout',
        `eide_build: failureKind from the build path reaches the tool result (${timeout.failureKind})`);

    const okExplorer = {
        getProjectByUid: () => prj,
        buildProject: async () => ({ success: true, message: 'Succeed.' })
    };
    const okRes = await executeTool('eide_build', { uid }, okExplorer);
    const ok = payload(okRes);
    check(okRes.isError === false && ok.success === true && ok.failureKind === undefined,
        'eide_build: successful build result has no failureKind');
}

async function run(): Promise<void> {
    fs.cpSync(fixture, projectDir, { recursive: true });
    seedProjectConfig();
    createStubToolchain();

    const session = await openProject();
    try {
        const prj = session.project;
        const uid = prj.getUid();
        const explorer = { getProjectByUid: (id: string) => id === uid ? prj : undefined };

        checkToolchainInUse(prj);
        seedBuildInDep(prj);
        await checkReadWriteSymmetry(prj, uid, explorer);
        checkBuildResultShape(prj);
        await checkBuildPathThreading(uid, prj);
    } finally {
        session.close();
    }

    if (failures.length > 0) {
        throw new Error(`${failures.length} assertion(s) failed.`);
    }
}

run()
    .then(() => {
        console.log('All mcp impl regression tests passed.');
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        process.exit(0);
    })
    .catch(error => {
        console.error(error);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        process.exit(1);
    });
export {};
