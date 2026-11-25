const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const yaml = require('yaml');
const { loadProjectSnapshot } = require('../../../src/core/project_snapshot') as any;
const { createFlashPlan } = require('../../../src/core/flash/plan') as any;

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

const root = NodePath.join(os.tmpdir(), `eide-flash-plan-${process.pid}-${Date.now()}`);

function write(path: string, content = ''): void {
    fs.mkdirSync(NodePath.dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
}

function writeProject(name: string, uploader: string, uploadConfig: any): string {
    const project = NodePath.join(root, name);
    const config = {
        version: '4.1',
        name: 'demo',
        type: 'ARM',
        deviceName: 'test-device-xyz',
        srcDirs: ['src'],
        outDir: 'build',
        dependenceList: [],
        targets: {
            Debug: {
                toolchain: 'GCC',
                toolchainConfigMap: { GCC: { options: {} } },
                uploader,
                uploadConfigMap: { [uploader]: uploadConfig },
                excludeList: [],
                cppPreprocessAttrs: { name: 'default', incList: [], libList: [], defineList: [] },
                settings: {}
            }
        }
    };
    write(NodePath.join(project, '.eide', 'eide.yml'), yaml.stringify(config));
    return project;
}

function plan(project: string, environment: any): any {
    return createFlashPlan(loadProjectSnapshot(project), {
        timeoutMs: 10000,
        eraseAll: false,
        ...environment
    });
}

try {
    const jlink = writeProject('jlink', 'JLink', {
        bin: '',
        baseAddr: '0x08000000',
        cpuInfo: { cpuName: 'STM32F103C8', vendor: 'ST' },
        proType: 1,
        speed: 8000,
        otherCmds: '--jtagconf'
    });
    const jlinkPlan = plan(jlink, { flasherExecutable: 'C:/tools/JLink.exe' });
    assert(jlinkPlan.command.executable === 'C:/tools/JLink.exe', 'flash plan: JLink executable');
    assert(jlinkPlan.command.args.join('|').includes('-Device|STM32F103C8'),
        'flash plan: JLink device');
    assert(jlinkPlan.command.args.join('|').includes('-If|SWD'), 'flash plan: JLink interface');
    assert(jlinkPlan.command.args.join('|').includes('-Speed|8000'), 'flash plan: JLink speed');
    assert(jlinkPlan.command.args.includes('--jtagconf'), 'flash plan: JLink extra args');
    assert(jlinkPlan.request.programs[0].path.endsWith('demo.hex'),
        'flash plan: JLink default artifact');
    assert(jlinkPlan.command.script.contents.includes('loadfile'), 'flash plan: JLink script');
    assert(jlinkPlan.command.verify === true, 'flash plan: JLink verifies');

    const badJlink = writeProject('bad-jlink', 'JLink', {
        bin: '',
        cpuInfo: { cpuName: 'test-device', vendor: 'ST' },
        proType: 99,
        speed: 8000,
        otherCmds: ''
    });
    let badInterface = false;
    try {
        plan(badJlink, { flasherExecutable: 'C:/tools/JLink.exe' });
    } catch {
        badInterface = true;
    }
    assert(badInterface, 'flash plan: JLink rejects invalid interface');

    let missingExe = false;
    try {
        plan(jlink, {});
    } catch {
        missingExe = true;
    }
    assert(missingExe, 'flash plan: JLink requires explicit executable');

    const noBase = writeProject('no-base', 'JLink', {
        bin: '',
        cpuInfo: { cpuName: 'STM32F103C8', vendor: 'ST' },
        proType: 1,
        speed: 8000,
        otherCmds: ''
    });
    const noBasePlan = plan(noBase, { flasherExecutable: 'C:/tools/JLink.exe' });
    assert(noBasePlan.request.address === undefined, 'flash plan: empty baseAddr stays unset');
    assert(noBasePlan.command.script.contents === 'r\nhalt\nloadfile "' + noBasePlan.request.programs[0].path + '"\nr\ngo\nexit',
        'flash plan: hex artifact loads without an address');

    let missingBinAddr = false;
    try {
        plan(noBase, { flasherExecutable: 'C:/tools/JLink.exe', artifact: 'firmware.bin' });
    } catch (error) {
        missingBinAddr = error instanceof Error && error.message.includes('requires an address');
    }
    assert(missingBinAddr, 'flash plan: JLink bin without address is rejected');

    write(NodePath.join(noBase, '.eide', 'jlink.flasher.cmd.template'),
        'si 1\n${EIDE_JLINK_FLASHER_CMD}\nsavebin "${binFile[0]}" 0x08000000 0x100\nlog "${ConfigName}.log"');
    const templated = plan(noBase, {
        flasherExecutable: 'C:/tools/JLink.exe',
        artifact: 'firmware.bin,0x08000000'
    });
    assert(templated.command.script.contents === [
        'si 1',
        'r', 'halt', `loadfile "${NodePath.join(noBase, 'firmware.bin')}",0x08000000`, 'r', 'go',
        `savebin "${NodePath.join(noBase, 'firmware.bin')}" 0x08000000 0x100`,
        'log "Debug.log"',
        'exit'
    ].join('\n'), 'flash plan: JLink command template is applied with project variables');

    const artifact = plan(jlink, {
        flasherExecutable: 'C:/tools/JLink.exe',
        artifact: 'firmware.bin,0x08004000'
    });
    assert(artifact.request.programs[0].path === NodePath.join(jlink, 'firmware.bin'),
        'flash plan: resolves artifact path');
    assert(artifact.request.programs[0].address === '0x08004000',
        'flash plan: parses artifact address');
    assert(artifact.command.script.contents.includes(',0x08004000'),
        'flash plan: passes bin address to JLink');

    const openocd = writeProject('openocd', 'OpenOCD', {
        bin: '${workspaceFolder}/firmware.hex',
        target: 'stm32f1x',
        interface: 'stlink',
        baseAddr: '0x08000000'
    });
    const openocdPlan = plan(openocd, { flasherExecutable: 'openocd' });
    assert(openocdPlan.request.programs[0].path === NodePath.join(openocd, 'firmware.hex'),
        'flash plan: resolves workspace variable');
    assert(openocdPlan.command.args.join('|').includes('-f|interface/stlink.cfg'),
        'flash plan: OpenOCD interface config');
    assert(openocdPlan.command.args.join('|').includes('-f|target/stm32f1x.cfg'),
        'flash plan: OpenOCD target config');
    assert(openocdPlan.command.args.join('|').includes('firmware.hex'),
        'flash plan: OpenOCD program');
    assert(openocdPlan.command.args.includes(openocd), 'flash plan: OpenOCD search dir');

    const pyocd = writeProject('pyocd', 'pyOCD', {
        bin: '',
        targetName: 'stm32f103c8',
        baseAddr: '0x08000000',
        speed: '4M',
        config: '.eide/pyocd.yaml',
        otherCmds: ''
    });
    write(NodePath.join(pyocd, '.eide', 'pyocd.yaml'), 'pack: test');
    const pyocdPlan = plan(pyocd, {});
    assert(pyocdPlan.command.executable === 'pyocd', 'flash plan: pyOCD default executable');
    assert(pyocdPlan.command.args.join('|').includes('-t|stm32f103c8'),
        'flash plan: pyOCD target');
    assert(pyocdPlan.command.args.join('|').includes('-f|4M'), 'flash plan: pyOCD frequency');
    assert(pyocdPlan.command.args.join('|').includes('--config|' + NodePath.join(pyocd, '.eide', 'pyocd.yaml')),
        'flash plan: pyOCD config file');

    const stlink = writeProject('stlink', 'STLink', {
        bin: '',
        proType: 'JTAG',
        resetMode: 'HWrst',
        runAfterProgram: false,
        speed: 4000,
        address: '0x08000000',
        elFile: 'None',
        optionBytes: '.eide/test.st.option.bytes.ini',
        otherCmds: ''
    });
    write(NodePath.join(stlink, '.eide', 'test.st.option.bytes.ini'), 'nWRP=0x00\nRDP=0xAA\n');
    const stlinkPlan = plan(stlink, { flasherExecutable: 'C:/ST/STM32_Programmer_CLI.exe' });
    assert(stlinkPlan.request.options.variant === 'cube-programmer',
        'flash plan: STLink variant');
    assert(stlinkPlan.command.args.join('|').includes('port=JTAG'), 'flash plan: STLink protocol');
    assert(stlinkPlan.command.args.join('|').includes('reset=HWrst'), 'flash plan: STLink reset');
    assert(stlinkPlan.command.args.join('|').includes('-ob|nWRP=0x00|RDP=0xAA'),
        'flash plan: STLink option bytes');
    assert(!stlinkPlan.command.args.includes('--go'), 'flash plan: STLink run after program');

    const stlinkCli = plan(stlink, { flasherExecutable: 'C:/ST/ST-LINK_CLI.exe' });
    assert(stlinkCli.request.options.variant === 'stlink-cli',
        'flash plan: ST-LINK_CLI variant');

    const probe = writeProject('probe', 'probe-rs', {
        bin: '',
        target: 'STM32F103C8',
        protocol: 'swd',
        speed: 0,
        baseAddr: '0x08000000',
        allowEraseAll: false,
        otherOptions: '--log-level info'
    });
    const probePlan = plan(probe, {});
    assert(probePlan.command.executable === 'cargo-flash',
        'flash plan: probe-rs default executable');
    assert(probePlan.request.programs[0].path.endsWith('demo.elf'),
        'flash plan: probe-rs uses elf');
    assert(probePlan.command.args.join('|').includes('--log-level|info'),
        'flash plan: probe-rs extra args');

    const erase = plan(jlink, { flasherExecutable: 'C:/tools/JLink.exe', eraseAll: true });
    assert(erase.request.programs.length === 0, 'flash plan: erase-all has no programs');
    assert(erase.command.script.contents.includes('erase'), 'flash plan: erase-all script');

    const unknown = writeProject('unknown', 'STVP', {});
    let unsupported = false;
    try {
        plan(unknown, {});
    } catch (error: any) {
        unsupported = error.message.includes('STVP');
    }
    assert(unsupported, 'flash plan: unsupported uploader fails explicitly');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

console.log('All flash plan tests passed.');
export {};
