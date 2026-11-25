const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');

require('../../../src/headless/vscode').installVscodeShim();

const { ProjectConfiguration } = require('../../../src/EIDETypeDefine');
const { ensureProjectUid } = require('../../../src/EIDEProjectExplorer');
const { KeilParser } = require('../../../src/KeilXmlParser');
const { openHeadlessProject } = require('../../../src/headless/host');
const { File } = require('../../../lib/node-utility/File');

function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

const repoRoot = NodePath.join(__dirname, '..', '..', '..', '..');
const resourcesDir = NodePath.join(repoRoot, 'res');
const keilSample = NodePath.join(resourcesDir, 'template', 'ARM.uvprojx');
const root = NodePath.join(os.tmpdir(), `eide-import-keil-uid-${process.pid}-${Date.now()}`);
const projectDir = NodePath.join(root, 'project');
const eideFile = NodePath.join(projectDir, '.eide', 'eide.yml');

function projectConfig(): any {
    return {
        version: '4.1',
        name: 'imported',
        type: 'ARM',
        mode: 'Target 1',
        srcDirs: ['src'],
        outDir: 'build',
        dependenceList: [],
        miscInfo: {},
        targets: {
            'Target 1': {
                toolchain: 'GCC',
                toolchainConfigMap: {
                    GCC: {
                        cpuType: 'Cortex-M3',
                        floatingPointHardware: 'default',
                        archExtensions: '',
                        scatterFilePath: 'link.ld',
                        options: {
                            version: 5,
                            global: {},
                            'c/cpp-compiler': { C_FLAGS: '', CXX_FLAGS: '' },
                            'asm-compiler': { ASM_FLAGS: '' },
                            linker: { LD_FLAGS: '', LIB_FLAGS: '' }
                        }
                    }
                },
                uploader: 'JLink',
                uploadConfigMap: { JLink: {} },
                excludeList: [],
                cppPreprocessAttrs: { name: 'default', incList: [], libList: [], defineList: [] },
                settings: {}
            }
        }
    };
}

async function openError(): Promise<string> {
    try {
        const session = await openHeadlessProject({
            projectPath: projectDir,
            resourcesDir,
            extensionRoot: repoRoot
        });
        session.close();
        return '';
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

async function run(): Promise<void> {
    fs.mkdirSync(NodePath.join(projectDir, '.eide'), { recursive: true });
    fs.copyFileSync(keilSample, NodePath.join(projectDir, 'ARM.uvprojx'));
    fs.writeFileSync(eideFile, yaml.stringify(projectConfig()));

    const targets = KeilParser.NewInstance(File.from(NodePath.join(projectDir, 'ARM.uvprojx')), 'arm').ParseData();
    assert(targets.length === 1 && targets[0].type === 'ARM',
        `import: repo Keil sample parses (${targets.length} target)`);

    const memento = {
        get: () => undefined,
        update: async () => undefined,
        keys: () => [],
        setKeysForSync: () => undefined
    };
    const prjConfig = new ProjectConfiguration(File.from(eideFile), memento, 'ARM').load();
    assert(prjConfig.config.miscInfo.uid === undefined,
        'import: project config has no uid before initialization');

    ensureProjectUid(prjConfig);
    prjConfig.Save();

    const saved = yaml.parse(fs.readFileSync(eideFile, 'utf8'));
    assert(typeof saved.miscInfo.uid === 'string' && saved.miscInfo.uid.length > 0,
        `import: eide.yml stores miscInfo.uid (${saved.miscInfo.uid})`);

    const withUid = await openError();
    assert(!withUid.includes('requires an initialized project with miscInfo.uid'),
        `headless: uid gate cleared (error: ${withUid || 'none'})`);

    const stripped = yaml.parse(fs.readFileSync(eideFile, 'utf8'));
    delete stripped.miscInfo.uid;
    fs.writeFileSync(eideFile, yaml.stringify(stripped));

    const withoutUid = await openError();
    assert(withoutUid.includes('requires an initialized project with miscInfo.uid'),
        `headless: missing uid is rejected again (error: ${withoutUid})`);
}

run()
    .then(() => {
        console.log('All import keil uid tests passed.');
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        process.exit(0);
    })
    .catch(error => {
        console.error(error);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        process.exit(1);
    });
export {};
