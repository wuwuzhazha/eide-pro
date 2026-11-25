const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');

require('../../../src/headless/vscode').installVscodeShim();

const { parseIarWorkbench } = require('../../../src/IarProjectParser');
const { importIarProject, importEclipseProject } = require('../../../src/EIDEProjectExplorer');
const { initHeadlessRuntime, openHeadlessProject } = require('../../../src/headless/host');
const { loadHeadlessSettings } = require('../../../src/headless/settings');
const { EideBuildService } = require('../../../src/headless/build_service');
const { NodeProcessRunner } = require('../../../src/core/process_runner');
const { File } = require('../../../lib/node-utility/File');

function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg.split('\n')[0]);
}

function memento(): any {
    return {
        get: () => undefined,
        update: async () => undefined,
        keys: () => [],
        setKeysForSync: () => undefined
    };
}

function virtualPaths(folder: any): string[] {
    const paths: string[] = folder.files.map((file: any) => file.path);
    for (const sub of folder.folders) {
        paths.push(...virtualPaths(sub));
    }
    return paths;
}

const repoRoot = NodePath.join(__dirname, '..', '..', '..', '..');
const resourcesDir = NodePath.join(repoRoot, 'res');
const iarFixtureDir = NodePath.join(repoRoot, 'test', 'fixtures', 'iar-import');
const eclipseFixtureDir = NodePath.join(repoRoot, 'test', 'fixtures', 'eclipse-import');
const root = NodePath.join(os.tmpdir(), `eide-import-iar-eclipse-e2e-${process.pid}-${Date.now()}`);

const iarRoot = NodePath.join(root, 'iar');
const iarProjectDir = NodePath.join(iarRoot, 'demo');
const iarEideFile = NodePath.join(iarProjectDir, '.eide', 'eide.yml');
const iarEnvFile = NodePath.join(iarProjectDir, '.eide', 'env.ini');

const eclipseRoot = NodePath.join(root, 'eclipse');
const eclipseEideFile = NodePath.join(eclipseRoot, '.eide', 'eide.yml');
const eclipseFilesOptions = NodePath.join(eclipseRoot, '.eide', 'files.options.yml');
const eclipseWorkspaceFile = NodePath.join(eclipseRoot, 'eclipse-demo.code-workspace');

const stubIar = NodePath.join(root, 'stub-toolchain-iar');
const stubGcc = NodePath.join(root, 'stub-toolchain-gcc');

function readConfig(path: string) {
    return yaml.parse(fs.readFileSync(path, 'utf8'));
}

function initRuntime(workspaceRoot: string, workspaceFile: string): void {
    const settings = loadHeadlessSettings(repoRoot, workspaceFile, undefined);
    initHeadlessRuntime({
        resourcesDir,
        extensionRoot: repoRoot,
        workspaceRoot,
        workspaceFile,
        settings,
        workspaceState: memento(),
        globalState: memento()
    });
}

async function openError(projectPath: string, toolchainPath: string): Promise<string> {
    try {
        const session = await openHeadlessProject({
            projectPath,
            resourcesDir,
            extensionRoot: repoRoot,
            toolchainPath
        });
        session.close();
        return '';
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

function buildService(toolchainPath: string) {
    return new EideBuildService({
        resourcesDir,
        extensionRoot: repoRoot,
        toolchainPath,
        runner: new NodeProcessRunner(),
        timeoutMs: 180000
    });
}

async function runIar(): Promise<void> {
    fs.cpSync(iarFixtureDir, iarRoot, { recursive: true });

    // fixture sanity: a real IAR workbench references an ARM project with two configurations
    const workbench = await parseIarWorkbench(
        File.from(NodePath.join(iarRoot, 'demo.eww')),
        File.from(NodePath.join(root, 'missing-iar-toolchain')));
    const projectPaths = Object.keys(workbench.projects);
    assert(projectPaths.length === 1,
        `iar fixture: the .eww references one project (${projectPaths.join(', ')})`);
    const fixtureProject = workbench.projects[projectPaths[0]];
    assert(fixtureProject.name === 'demo' && Object.keys(fixtureProject.targets).join(',') === 'Debug,Release',
        `iar fixture: ARM project with Debug/Release configurations (${Object.keys(fixtureProject.targets).join(', ')})`);

    initRuntime(iarRoot, NodePath.join(iarRoot, 'demo.code-workspace'));

    // full IAR import, the same entry the extension dispatch uses
    const iarWorkspace = await importIarProject({
        type: 'iar',
        projectFile: File.from(NodePath.join(iarRoot, 'demo.eww')),
        outDir: File.from(iarRoot),
        createNewFolder: false
    });

    assert(iarWorkspace.path === NodePath.join(iarProjectDir, 'demo.code-workspace')
        && fs.existsSync(iarWorkspace.path),
        `iar import: returns the single-project workspace file (${iarWorkspace.path})`);
    assert(fs.existsSync(iarEideFile), `iar import: writes .eide/eide.yml`);

    const iarConfig = readConfig(iarEideFile);
    assert(iarConfig.name === 'demo' && iarConfig.type === 'ARM',
        `iar import: project name and type (${iarConfig.name}, ${iarConfig.type})`);
    assert(typeof iarConfig.miscInfo?.uid === 'string' && iarConfig.miscInfo.uid.length > 0,
        `iar import: assigns miscInfo.uid (${iarConfig.miscInfo?.uid})`);

    const iarPaths = virtualPaths(iarConfig.virtualFolder);
    assert(JSON.stringify(iarPaths) === JSON.stringify([
        '${PROJ_DIR}/src/main.c',
        '${PROJ_DIR}/src/app.c',
        '${PROJ_DIR}/src/drv.c'
    ]), `iar import: keeps the root file, group and nested group (${iarPaths.join(', ')})`);

    const iarDebug = iarConfig.targets.Debug;
    assert(iarDebug.toolchain === 'IAR_ARM',
        `iar import: keeps the IAR toolchain (${iarDebug.toolchain})`);
    assert(iarDebug.cppPreprocessAttrs.defineList.join(',') === 'USE_HAL_DRIVER,STM32F103xB',
        `iar import: keeps the Debug defines (${iarDebug.cppPreprocessAttrs.defineList.join(' ')})`);
    assert(iarDebug.cppPreprocessAttrs.incList.join(',') === '${PROJ_DIR}/include,${PROJ_DIR}/../drivers/inc',
        `iar import: keeps the Debug include paths (${iarDebug.cppPreprocessAttrs.incList.join(' ')})`);
    assert(iarDebug.toolchainConfigMap.IAR_ARM.scatterFilePath === 'link.icf'
        && iarDebug.toolchainConfigMap.IAR_ARM.useCustomScatterFile === true,
        `iar import: maps the linker config file (${iarDebug.toolchainConfigMap.IAR_ARM.scatterFilePath})`);
    assert(iarConfig.targets.Release.cppPreprocessAttrs.defineList.join(',') === 'NDEBUG',
        `iar import: keeps per-configuration defines (${iarConfig.targets.Release.cppPreprocessAttrs.defineList.join(' ')})`);
    assert(fs.existsSync(iarEnvFile) && fs.readFileSync(iarEnvFile, 'utf8').includes('PROJ_DIR = ..'),
        'iar import: writes env.ini with PROJ_DIR pointing at the workbench folder');

    // loadability: the uid gate passes
    const iarOpenFailure = await openError(iarProjectDir, stubIar);
    assert(iarOpenFailure === '',
        `iar open: openHeadlessProject accepts the imported project (${iarOpenFailure || 'no error'})`);

    // plan structure: the imported configuration reaches the build model
    const iarPlan = await buildService(stubIar).plan({ projectPath: iarProjectDir });
    const iarSources: string[] = iarPlan.params.sourceList.map((path: string) => path.replace(/\\/g, '/'));
    for (const expected of ['src/main.c', 'src/app.c', 'src/drv.c']) {
        assert(iarSources.some((path: string) => path.endsWith(expected)),
            `iar plan: ${expected} reaches the build (${iarSources.join(', ')})`);
    }
    assert(iarPlan.params.defines.includes('USE_HAL_DRIVER')
        && iarPlan.params.defines.includes('STM32F103xB'),
        `iar plan: imported defines reach the build (${iarPlan.params.defines.join(' ')})`);

    // regression: the uid gate must still reject an uninitialized project
    const stripped = readConfig(iarEideFile);
    delete stripped.miscInfo.uid;
    fs.writeFileSync(iarEideFile, yaml.stringify(stripped));
    const iarUidFailure = await openError(iarProjectDir, stubIar);
    assert(iarUidFailure.includes('requires an initialized project with miscInfo.uid'),
        `iar uid gate: removing miscInfo.uid is rejected again (${iarUidFailure})`);
}

async function runEclipse(): Promise<void> {
    fs.cpSync(eclipseFixtureDir, eclipseRoot, { recursive: true });

    initRuntime(eclipseRoot, eclipseWorkspaceFile);

    // full Eclipse import, the same entry the extension dispatch uses
    const eclipseWorkspace = await importEclipseProject({
        type: 'eclipse',
        projectFile: File.from(NodePath.join(eclipseRoot, '.cproject')),
        outDir: File.from(eclipseRoot),
        createNewFolder: false
    });

    assert(eclipseWorkspace.path === eclipseWorkspaceFile && fs.existsSync(eclipseWorkspaceFile),
        `eclipse import: returns the project workspace file (${eclipseWorkspace.path})`);
    assert(fs.existsSync(eclipseEideFile), `eclipse import: writes .eide/eide.yml`);
    assert(fs.existsSync(eclipseFilesOptions), `eclipse import: writes .eide/files.options.yml`);

    const eclipseConfig = readConfig(eclipseEideFile);
    assert(eclipseConfig.name === 'eclipse-demo' && eclipseConfig.type === 'ARM',
        `eclipse import: project name and type (${eclipseConfig.name}, ${eclipseConfig.type})`);
    assert(typeof eclipseConfig.miscInfo?.uid === 'string' && eclipseConfig.miscInfo.uid.length > 0,
        `eclipse import: assigns miscInfo.uid (${eclipseConfig.miscInfo?.uid})`);
    assert(eclipseConfig.srcDirs.join(',') === 'src',
        `eclipse import: keeps the source entry (${eclipseConfig.srcDirs.join(', ')})`);
    assert(eclipseConfig.virtualFolder.files.map((file: any) => file.path).join(',') === 'main.c',
        `eclipse import: keeps the root virtual source file (${eclipseConfig.virtualFolder.files.map((file: any) => file.path).join(', ')})`);

    const eclipseDebug = eclipseConfig.targets.Debug;
    assert(eclipseDebug.toolchain === 'GCC',
        `eclipse import: keeps the GCC toolchain (${eclipseDebug.toolchain})`);
    assert(eclipseDebug.cppPreprocessAttrs.defineList.includes('ECLIPSE_DEFINE=1'),
        `eclipse import: keeps the defines (${eclipseDebug.cppPreprocessAttrs.defineList.join(' ')})`);
    assert(eclipseDebug.cppPreprocessAttrs.incList.includes('include'),
        `eclipse import: keeps the include paths (${eclipseDebug.cppPreprocessAttrs.incList.join(' ')})`);
    assert(eclipseDebug.toolchainConfigMap.GCC.cpuType === 'Cortex-M4'
        && eclipseDebug.toolchainConfigMap.GCC.floatingPointHardware === 'single',
        `eclipse import: maps the MCU to a CPU and FPU (${eclipseDebug.toolchainConfigMap.GCC.cpuType}, ${eclipseDebug.toolchainConfigMap.GCC.floatingPointHardware})`);
    assert(eclipseDebug.toolchainConfigMap.GCC.scatterFilePath === 'link.ld'
        && eclipseDebug.toolchainConfigMap.GCC.useCustomScatterFile === true,
        `eclipse import: maps the linker script (${eclipseDebug.toolchainConfigMap.GCC.scatterFilePath})`);

    // loadability: the uid gate passes
    const eclipseOpenFailure = await openError(eclipseRoot, stubGcc);
    assert(eclipseOpenFailure === '',
        `eclipse open: openHeadlessProject accepts the imported project (${eclipseOpenFailure || 'no error'})`);

    // plan structure: the imported configuration reaches the build model
    const eclipsePlan = await buildService(stubGcc).plan({ projectPath: eclipseRoot });
    const eclipseSources: string[] = eclipsePlan.params.sourceList.map((path: string) => path.replace(/\\/g, '/'));
    assert(eclipseSources.includes('main.c') && eclipseSources.includes('src/main.c'),
        `eclipse plan: imported sources reach the build (${eclipseSources.join(', ')})`);
    assert(eclipsePlan.params.defines.includes('ECLIPSE_DEFINE=1'),
        `eclipse plan: imported define reaches the build (${eclipsePlan.params.defines.join(' ')})`);

    // regression: the uid gate must still reject an uninitialized project
    const stripped = readConfig(eclipseEideFile);
    delete stripped.miscInfo.uid;
    fs.writeFileSync(eclipseEideFile, yaml.stringify(stripped));
    const eclipseUidFailure = await openError(eclipseRoot, stubGcc);
    assert(eclipseUidFailure.includes('requires an initialized project with miscInfo.uid'),
        `eclipse uid gate: removing miscInfo.uid is rejected again (${eclipseUidFailure})`);
}

async function run(): Promise<void> {
    fs.mkdirSync(NodePath.join(stubIar, 'bin'), { recursive: true });
    fs.mkdirSync(NodePath.join(stubGcc, 'bin'), { recursive: true });
    await runIar();
    await runEclipse();
}

function cleanup(): void {
    try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) {
        fs.writeSync(2,
            `cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
}

run()
    .then(() => {
        console.log('All IAR/Eclipse import e2e tests passed.');
        cleanup();
        process.exit(0);
    })
    .catch(error => {
        console.error(error);
        cleanup();
        process.exit(1);
    });
export {};
