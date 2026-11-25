const fs = require('fs');
const NodePath = require('path');
const { spawnSync } = require('child_process');

// mirrors the importer enumeration in EIDEProjectExplorer.ImportSourceFromExtProject
const IMPORTER_LIST_FILTER = /^(?:[^\.]+)\.(?:[^\.]+)\.js$/i;
const IMPORTER_NAME_PARTS = /^(?<type>[^\.]+)\.(?<suffix>[^\.]+)\.js$/i;

const ARCH_IDS: { [arch: string]: string } = { x64: 'x86_64', arm64: 'arm64' };

interface VirtualFileInfo { path: string }
interface VirtualFolderInfo { name: string; files: VirtualFileInfo[]; folders: VirtualFolderInfo[] }
interface ImportedProject {
    name: string;
    target?: string;
    incList: string[];
    defineList: string[];
    files: VirtualFolderInfo;
    excludeList?: { [target: string]: string[] };
}

const repoRoot = NodePath.join(__dirname, '..', '..', '..', '..');
const scriptsDir = NodePath.join(repoRoot, 'res', 'scripts');
const importerDir = NodePath.join(scriptsDir, 'importer');
const fixtureDir = NodePath.join(repoRoot, 'test', 'fixtures', 'iar-import');
const fixtureFile = NodePath.join(fixtureDir, 'demo.ewp');

function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

function skip(msg: string): void {
    console.log('SKIPPED:', msg);
}

//
// vendored importer layout
//

assert(fs.existsSync(importerDir), 'importer: res/scripts/importer exists');
assert(fs.existsSync(NodePath.join(scriptsDir, 'lib', 'x2js', 'x2js.js')),
    'importer: bundled x2js is present (index.js imports lib/x2js/x2js.js)');
assert(fs.existsSync(fixtureFile), 'fixture: IAR project file exists');

const importerFiles: string[] = (fs.readdirSync(importerDir) as string[])
    .filter((f: string) => IMPORTER_LIST_FILTER.test(f)).sort();
assert(JSON.stringify(importerFiles) === JSON.stringify([
    'IAR_For_ARM.ewp.js',
    'IAR_For_STM8_Or_8051.ewp.js',
    'Segger_Embedded_Studio.emProject.js'
]), `importer: enumerated ${JSON.stringify(importerFiles)}`);

assert(!IMPORTER_LIST_FILTER.test('index.js'), 'importer: index.js is not offered as an importer');

const qjsRoot = NodePath.join(scriptsDir, 'qjs');
const runtimeDirs: string[] = (fs.readdirSync(qjsRoot) as string[]).sort();
assert(runtimeDirs.length > 0, 'qjs: at least one bundled runtime');
for (const dir of runtimeDirs) {
    assert(/^(?:win32|linux)-[a-z0-9_]+$/.test(dir), `qjs: runtime dir '${dir}' is named <os>-<arch>`);
    const exes: string[] = (fs.readdirSync(NodePath.join(qjsRoot, dir)) as string[])
        .filter((f: string) => /^qjs(?:\.exe)?$/.test(f));
    assert(exes.length === 1, `qjs: '${dir}' ships exactly one qjs executable`);
}

for (const file of importerFiles) {
    const m = IMPORTER_NAME_PARTS.exec(file);
    assert(m !== null && m.groups !== undefined, `importer: '${file}' matches the '<type>.<suffix>.js' rule`);
    const label = m!.groups!['type'].replace(/\-/g, ' ').replace(/_/g, ' ');
    assert(label.trim() !== '', `importer: '${file}' yields a non-empty label`);
    assert(['ewp', 'emProject'].includes(m!.groups!['suffix']), `importer: '${file}' suffix is a project file suffix`);
}

//
// importer run on a real project file
//

const platformId = `${process.platform}-${ARCH_IDS[process.arch] || process.arch}`;
const qjsExe = NodePath.join(scriptsDir, 'qjs', platformId, `qjs${process.platform === 'win32' ? '.exe' : ''}`);

if (!fs.existsSync(qjsExe)) {
    skip(`no bundled QuickJS runtime for '${platformId}' at res/scripts/qjs/${platformId}`);
} else {
    const run = spawnSync(qjsExe, ['--std', './importer/index.js', 'IAR_For_ARM.ewp', fixtureFile], {
        cwd: scriptsDir,
        encoding: 'utf8'
    });
    assert(run.error === undefined, `qjs: '${qjsExe}' is executable (${run.error ? run.error.message : 'ok'})`);

    let prjList: ImportedProject[];
    try {
        prjList = JSON.parse(run.stdout);
    } catch (error) {
        throw new Error(`qjs: importer output is not JSON: ${run.stdout}${run.stderr}`);
    }

    assert(Array.isArray(prjList) && prjList.length === 2, 'qjs: importer returns one entry per ICCARM target');
    assert(prjList[0].name === 'demo:Debug' && prjList[0].target === 'Debug',
        'qjs: target name is <project>:<configuration>');
    assert(prjList[1].name === 'demo:Release' && prjList[1].target === 'Release',
        'qjs: second target is parsed');

    const debug = prjList[0];
    assert(JSON.stringify(debug.defineList) === JSON.stringify(['USE_HAL_DRIVER', 'STM32F103xB']),
        'qjs: CCDefines are parsed and blank entries dropped');

    const norm = (path: string): string => NodePath.posix.normalize(path.replace(/\\/g, '/'));
    const fixtureRoot = norm(fixtureDir);
    assert(JSON.stringify(debug.incList.map(norm)) === JSON.stringify([
        `${fixtureRoot}/include`,
        NodePath.posix.normalize(`${fixtureRoot}/../drivers/inc`)
    ]), 'qjs: CCIncludePath2 entries are resolved against $PROJ_DIR$');

    assert(JSON.stringify(debug.files.files.map((f: VirtualFileInfo) => norm(f.path))) ===
        JSON.stringify([`${fixtureRoot}/src/main.c`]), 'qjs: root-level files are parsed');
    assert(debug.files.name === '<virtual_root>', 'qjs: file tree root is <virtual_root>');

    const appFolder = debug.files.folders.find((f: VirtualFolderInfo) => f.name === 'App');
    assert(appFolder !== undefined, 'qjs: top-level group is parsed');
    assert(JSON.stringify(appFolder.files.map((f: VirtualFileInfo) => norm(f.path))) ===
        JSON.stringify([`${fixtureRoot}/src/app.c`]), 'qjs: group files are parsed');

    const driversFolder = debug.files.folders[0].folders[0];
    assert(debug.files.folders[0].folders.length === 1 && driversFolder.name === 'Drivers',
        'qjs: nested group is parsed');
    assert(JSON.stringify(driversFolder.files.map((f: VirtualFileInfo) => norm(f.path))) ===
        JSON.stringify([`${fixtureRoot}/src/drv.c`]), 'qjs: nested group files are parsed');

    assert(JSON.stringify(prjList[1].defineList) === JSON.stringify(['NDEBUG']),
        'qjs: defines are per target');
}
