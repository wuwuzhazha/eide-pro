const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const { spawnSync } = require('child_process');
const yaml = require('yaml');

require('../../../src/headless/vscode').installVscodeShim();

const { KeilParser } = require('../../../src/KeilXmlParser');
const { importKeilProject } = require('../../../src/EIDEProjectExplorer');
const { initHeadlessRuntime, openHeadlessProject } = require('../../../src/headless/host');
const { loadHeadlessSettings } = require('../../../src/headless/settings');
const { EideBuildService } = require('../../../src/headless/build_service');
const { NodeProcessRunner } = require('../../../src/core/process_runner');
const { AbstractProject } = require('../../../src/EIDEProject');
const { getGlobalState } = require('../../../src/Platform');
const { File } = require('../../../lib/node-utility/File');

function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg.split('\n')[0]);
}

function skip(msg: string): void {
    if (process.env.EIDE_REQUIRE_ARM_GCC === '1') {
        console.error(`FAIL: required ARM GCC build cannot run: ${msg}`);
        process.exit(1);
    }
    console.log('SKIPPED:', msg);
}

interface BuildFailureInfo {
    stage: string;
    failureKind?: 'timeout' | 'signal' | 'build';
    analysisError?: string;
    logTail?: string;
    effectiveConfig?: { outDir?: string };
}

function readLogTail(path: string): string {
    try {
        return fs.readFileSync(path, 'utf8').split(/\r\n|\n/).slice(-40).join('\n').trim();
    } catch {
        return '';
    }
}

function buildDiagnostics(result: BuildFailureInfo): string {
    const outDir = result.effectiveConfig?.outDir;
    const compilerLog = outDir === undefined ? '' : readLogTail(NodePath.join(outDir, 'compiler.log'));
    const builderLog = outDir === undefined ? '' : readLogTail(NodePath.join(outDir, 'unify_builder.log'));
    const tail = result.logTail ?? compilerLog;
    const lines = [
        `stage: ${result.stage}`,
        `failureKind: ${result.failureKind ?? 'none'}`,
        `analysisError: ${result.analysisError ?? 'none'}`,
        'logTail:',
        tail.length > 0 ? tail : '(no build log)'
    ];
    if (builderLog.length > 0) {
        lines.push('builderLog:', builderLog);
    }
    return lines.join('\n');
}

function memento(): any {
    return {
        get: () => undefined,
        update: async () => undefined,
        keys: () => [],
        setKeysForSync: () => undefined
    };
}

const repoRoot = NodePath.join(__dirname, '..', '..', '..', '..');
const resourcesDir = NodePath.join(repoRoot, 'res');
const fixtureDir = NodePath.join(repoRoot, 'test', 'fixtures', 'keil-import');
const root = NodePath.join(os.tmpdir(), `eide-import-keil-e2e-${process.pid}-${Date.now()}`);
const projectDir = NodePath.join(root, 'project');
const workspaceFile = NodePath.join(projectDir, 'demo.code-workspace');
const eideFile = NodePath.join(projectDir, '.eide', 'eide.yml');
const filesOptionsFile = NodePath.join(projectDir, '.eide', 'files.options.yml');
const envFile = NodePath.join(projectDir, '.eide', 'env.ini');
const targetName = 'Target 1';
const exe = process.platform === 'win32' ? '.exe' : '';

function readConfig(): any {
    return yaml.parse(fs.readFileSync(eideFile, 'utf8'));
}

function readFilesOptions(): any {
    return yaml.parse(fs.readFileSync(filesOptionsFile, 'utf8'));
}

function findArmGccDir(): string | undefined {
    const configured = process.env.ARM_GCC_DIR;
    if (configured) {
        const dir = NodePath.resolve(configured);
        const gcc = NodePath.join(dir, 'bin', `arm-none-eabi-gcc${exe}`);
        if (!fs.existsSync(gcc)) {
            throw new Error(`ARM_GCC_DIR does not contain bin/arm-none-eabi-gcc: ${configured}`);
        }
        return dir;
    }
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which',
        ['arm-none-eabi-gcc'], { encoding: 'utf8' });
    if (probe.status !== 0) {
        return undefined;
    }
    const found = (probe.stdout || '').split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)[0];
    return found ? NodePath.dirname(NodePath.dirname(found)) : undefined;
}

async function openError(toolchainPath: string): Promise<string> {
    try {
        const session = await openHeadlessProject({
            projectPath: projectDir,
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

async function run(): Promise<void> {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.cpSync(fixtureDir, projectDir, { recursive: true });

    // fixture sanity: the Keil project must be a real two group ARM target
    const keilTargets = KeilParser.NewInstance(
        File.from(NodePath.join(projectDir, 'demo.uvprojx')), 'arm').ParseData();
    assert(keilTargets.length === 1 && keilTargets[0].type === 'ARM',
        `fixture: Keil project parses into one ARM target (${keilTargets.length} target)`);
    assert(keilTargets[0].fileGroups.length === 2
        && keilTargets[0].fileGroups.map((group: any) => group.files.length).join(',') === '1,1',
        `fixture: two source groups with one source each (${keilTargets[0].fileGroups.map((group: any) => group.name).join(', ')})`);
    assert(keilTargets[0].rte_deps === undefined,
        'fixture: empty <RTE> section yields no RTE dependencies');

    assert(NodePath.posix.basename(File.ToUnixPath('.\\src\\main.c')) === 'main.c',
        `posix: ToUnixPath + basename splits a backslash Keil path (${NodePath.posix.basename(File.ToUnixPath('.\\src\\main.c'))})`);
    const foptKeys = Object.keys(keilTargets[0].fileOptions ?? {});
    assert(foptKeys.length === 1 && foptKeys[0] === '<virtual_root>/App/main.c',
        `posix: parser file option key uses the file name (${foptKeys.join(', ')})`);

    const settings = loadHeadlessSettings(repoRoot, workspaceFile, undefined);
    initHeadlessRuntime({
        resourcesDir,
        extensionRoot: repoRoot,
        workspaceRoot: projectDir,
        workspaceFile,
        settings,
        workspaceState: memento(),
        globalState: memento()
    });

    // full Keil import, the same entry the extension dispatch uses
    await importKeilProject({
        type: 'mdk',
        mdk_prod: 'arm',
        projectFile: File.from(NodePath.join(projectDir, 'demo.uvprojx')),
        outDir: File.from(projectDir),
        createNewFolder: false
    });

    assert(fs.existsSync(eideFile), `import: writes .eide/eide.yml`);
    const imported = readConfig();
    assert(typeof imported.miscInfo?.uid === 'string' && imported.miscInfo.uid.length > 0,
        `import: assigns miscInfo.uid (${imported.miscInfo?.uid})`);

    const virtualFiles = imported.virtualFolder.folders
        .map((folder: any) => folder.files.map((file: any) => file.path).join(','))
        .join(',');
    assert(virtualFiles === 'src/main.c,src/startup.c',
        `import: keeps both source files in their Keil groups (${virtualFiles})`);

    const importedTarget = imported.targets[targetName];
    assert(importedTarget.toolchain === 'AC5',
        `import: keeps the Keil toolchain for the target (${importedTarget.toolchain})`);
    assert(importedTarget.cppPreprocessAttrs.defineList.includes('TARGET_DEFINE=3'),
        `import: keeps the target define (${importedTarget.cppPreprocessAttrs.defineList.join(' ')})`);

    const mainOptions = readFilesOptions().options[targetName].virtualPathFiles['<virtual_root>/App/main.c'];
    assert(typeof mainOptions === 'string'
        && mainOptions.includes('-Iinclude') && mainOptions.includes('-DGROUP_DEFINE=7'),
        `import: keeps the group define and include path for the group file (${mainOptions})`);
    assert(typeof mainOptions === 'string' && mainOptions.includes('-DFILE_DEFINE=11'),
        `import: keeps the file define (${mainOptions})`);

    assert(!fs.existsSync(NodePath.join(projectDir, '.cmsis')),
        'import: does not extract CMSIS headers for an empty <RTE> section');
    assert(!importedTarget.cppPreprocessAttrs.incList.some((inc: string) => inc.startsWith('RTE')),
        `import: does not add a virtual RTE include path (${importedTarget.cppPreprocessAttrs.incList.join(' ') || 'none'})`);
    assert(fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8').includes('KEIL_OUTPUT_DIR=Objects'),
        'import: writes env.ini for the target');

    // user migration: AC5 (not available off Windows/Keil) -> GCC
    const project = AbstractProject.NewProject(getGlobalState());
    await project.LoadForHeadless(File.from(workspaceFile));
    assert(project.getToolchain().name === 'AC5',
        `migrate: project loads headless with the imported toolchain (${project.getToolchain().name})`);
    project.setToolchain('GCC');
    project.GetConfiguration().toolchainConfigModel.SetKeyValue('scatterFilePath', 'link.ld');
    project.Save(true);
    project.Close();

    const migrated = readConfig();
    const migratedTarget = migrated.targets[targetName];
    assert(migratedTarget.toolchain === 'GCC'
        && migratedTarget.toolchainConfigMap.GCC.scatterFilePath === 'link.ld',
        `migrate: eide.yml persists the GCC toolchain and linker script (${migratedTarget.toolchain}, ${migratedTarget.toolchainConfigMap.GCC.scatterFilePath})`);
    assert(migratedTarget.cppPreprocessAttrs.defineList.includes('TARGET_DEFINE=3'),
        `migrate: switching to GCC keeps the imported defines (${migratedTarget.cppPreprocessAttrs.defineList.join(' ')})`);

    // stub toolchain keeps the uid gate proof runnable without ARM GCC
    const stubToolchain = NodePath.join(root, 'stub-toolchain');
    fs.mkdirSync(NodePath.join(stubToolchain, 'bin'), { recursive: true });
    fs.writeFileSync(NodePath.join(stubToolchain, 'bin', `arm-none-eabi-gcc${exe}`), '');

    const openFailure = await openError(stubToolchain);
    assert(openFailure === '',
        `open: openHeadlessProject accepts the imported project (${openFailure || 'no error'})`);

    const armGcc = findArmGccDir();
    const planService = new EideBuildService({
        resourcesDir,
        extensionRoot: repoRoot,
        toolchainPath: armGcc ?? stubToolchain,
        runner: new NodeProcessRunner(),
        timeoutMs: 180000
    });
    const plan = await planService.plan({ projectPath: projectDir });
    const sources: string[] = plan.params.sourceList.map((path: string) => path.replace(/\\/g, '/'));
    assert(sources.includes('src/main.c') && sources.includes('src/startup.c'),
        `plan: both imported sources are compiled (${sources.join(', ')})`);
    assert(plan.params.defines.includes('TARGET_DEFINE=3'),
        `plan: imported target define reaches the build (${plan.params.defines.join(' ')})`);
    const mainParams: string = plan.params.sourceParams['src/main.c'] || '';
    assert(mainParams.includes('-Iinclude') && mainParams.includes('-DGROUP_DEFINE=7')
        && mainParams.includes('-DFILE_DEFINE=11'),
        `plan: imported group/file options reach the build (${mainParams})`);

    if (armGcc === undefined) {
        skip('real ARM GCC build not run: arm-none-eabi-gcc is not on PATH ' +
            '(set ARM_GCC_DIR or install the toolchain; EIDE_REQUIRE_ARM_GCC=1 makes this fatal)');
    } else {
        const runner = new NodeProcessRunner();
        let builderOutput = '';
        const recordingRunner = {
            run: async (...args: Parameters<InstanceType<typeof NodeProcessRunner>['run']>) => {
                const processResult = await runner.run(...args);
                builderOutput = [processResult.stdout, processResult.stderr]
                    .filter(text => text.length > 0)
                    .join('\n');
                return processResult;
            }
        };
        const buildService = new EideBuildService({
            resourcesDir,
            extensionRoot: repoRoot,
            toolchainPath: armGcc,
            runner: recordingRunner,
            timeoutMs: 180000
        });
        const result = await buildService.build({ projectPath: projectDir, mode: 'rebuild' });
        const diagnostics = buildDiagnostics(result);
        assert(result.success === true,
            `build: real ARM GCC build succeeds\n${diagnostics}`);
        const elfFile = NodePath.join(result.effectiveConfig.outDir, 'demo.elf');
        assert(fs.existsSync(elfFile) && fs.statSync(elfFile).size > 0,
            `build: produces demo.elf (${elfFile})\n${diagnostics}`);
        const magic = fs.existsSync(elfFile)
            ? fs.readFileSync(elfFile).subarray(0, 4).toString('latin1')
            : '';
        assert(magic === '\x7fELF',
            `build: demo.elf is an ELF image (magic: ${Buffer.from(magic, 'latin1').toString('hex')})\n${diagnostics}`);
        const hexFiles = result.artifacts.filter((file: string) => file.endsWith('.hex'));
        assert(hexFiles.length > 0,
            `build: produces the hex image (${result.artifacts.map((file: string) => NodePath.basename(file)).join(', ')})` +
            (hexFiles.length > 0 ? '' : `\n${diagnostics}\nbuilder output:\n${builderOutput.slice(-4000)}`));
    }

    // regression: the uid gate must still reject an uninitialized project
    const stripped = readConfig();
    delete stripped.miscInfo.uid;
    fs.writeFileSync(eideFile, yaml.stringify(stripped));
    const uidFailure = await openError(stubToolchain);
    assert(uidFailure.includes('requires an initialized project with miscInfo.uid'),
        `uid gate: removing miscInfo.uid is rejected again (${uidFailure})`);
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
        console.log('All import keil e2e tests passed.');
        cleanup();
        process.exit(0);
    })
    .catch(error => {
        console.error(error);
        cleanup();
        process.exit(1);
    });
export {};
