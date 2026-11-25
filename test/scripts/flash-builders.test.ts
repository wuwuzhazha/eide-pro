import {
    FLASH_COMMAND_FILE_PLACEHOLDER,
    FlashBuildError,
    buildFlashCommand,
    buildJLinkCommand,
    buildOpenOCDCommand,
    buildProbeRSCommand,
    buildPyOCDCommand,
    buildSTLinkCommand,
    getFlashCapabilities,
    listFlashTools
} from '../../src/core/flash/builders';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
    const actualText = JSON.stringify(actual);
    const expectedText = JSON.stringify(expected);
    if (actualText !== expectedText) {
        console.error(`FAIL: ${msg}`);
        console.error(`  expected: ${expectedText}`);
        console.error(`  actual:   ${actualText}`);
        process.exit(1);
    }
    console.log('OK:', msg);
}

function assertBuildError(code: 'not_supported' | 'invalid_request', action: () => unknown, msg: string): void {
    try {
        action();
    } catch (error) {
        assert(error instanceof FlashBuildError, `${msg}: throws FlashBuildError`);
        assert(error.code === code, `${msg}: code is ${code}`);
        return;
    }
    assert(false, `${msg}: expected an error`);
}

const jlinkOptions = {
    executable: 'JLinkExe',
    device: 'STM32F103C8',
    interface: 'SWD' as const,
    speedKhz: 4000
};

const jlink = buildJLinkCommand({
    uploader: 'JLink',
    programs: [{ path: 'E:/build/app.hex' }],
    options: { ...jlinkOptions, extraArgs: ['-NoGui'] }
});
assertEqual(jlink.executable, 'JLinkExe', 'JLink: executable');
assertEqual(jlink.args, [
    '-ExitOnError', '1',
    '-AutoConnect', '1',
    '-Device', 'STM32F103C8',
    '-If', 'SWD',
    '-Speed', '4000',
    '-CommandFile', FLASH_COMMAND_FILE_PLACEHOLDER,
    '-NoGui'
], 'JLink: connection and command file args');
assertEqual(jlink.script?.contents, [
    'r', 'halt', 'loadfile "E:/build/app.hex"', 'r', 'go', 'exit'
].join('\n'), 'JLink: program command file');
assert(jlink.verify === true, 'JLink: program verifies through loadfile');

const jlinkBin = buildJLinkCommand({
    uploader: 'JLink',
    programs: [{ path: 'E:/build/app.bin' }],
    address: '0x08000000',
    options: jlinkOptions
});
assertEqual(jlinkBin.script?.contents, [
    'r', 'halt', 'loadfile "E:/build/app.bin",0x08000000', 'r', 'go', 'exit'
].join('\n'), 'JLink: bin uses request address');

assertBuildError('invalid_request', () => buildJLinkCommand({
    uploader: 'JLink',
    programs: [{ path: 'E:/build/app.bin' }],
    options: jlinkOptions
}), 'JLink: bin without address is rejected');

assertBuildError('not_supported', () => buildJLinkCommand({
    uploader: 'JLink',
    programs: [{ path: 'E:/build/app.hex' }],
    verify: false,
    options: jlinkOptions
}), 'JLink: verify cannot be disabled');

const jlinkTemplate = buildJLinkCommand({
    uploader: 'JLink',
    programs: [{ path: 'E:/build/app.bin', address: '0x08004000' }],
    options: {
        ...jlinkOptions,
        commandTemplate: 'si 1\n${EIDE_JLINK_FLASHER_CMD}\nsavebin "${binFile[0]}" 0x08000000 0x100'
    }
});
assertEqual(jlinkTemplate.script?.contents, [
    'si 1',
    'r', 'halt', 'loadfile "E:/build/app.bin",0x08004000', 'r', 'go',
    'savebin "E:/build/app.bin" 0x08000000 0x100',
    'exit'
].join('\n'), 'JLink: user command template is rendered');

const jlinkErase = buildJLinkCommand({
    uploader: 'JLink',
    eraseAll: true,
    programs: [],
    options: jlinkOptions
});
assertEqual(jlinkErase.script?.contents, [
    'r', 'halt', 'erase', 'r', 'exit'
].join('\n'), 'JLink: erase-all command file');
assert(jlinkErase.verify === false, 'JLink: erase-all does not claim verification');

const jlinkJtag = buildJLinkCommand({
    uploader: 'JLink',
    programs: [{ path: 'E:/build/app.hex' }],
    options: { ...jlinkOptions, interface: 'JTAG' }
});
assertEqual(jlinkJtag.args.slice(-2), ['-JTAGConf', '-1,-1'], 'JLink: JTAG configuration args');

const openocd = buildOpenOCDCommand({
    uploader: 'OpenOCD',
    programs: [{ path: 'E:\\build\\app.bin', address: '0x08000000' }],
    options: {
        executable: 'C:/tools/openocd.exe',
        searchDir: 'E:/ws',
        interfaceConfig: 'cmsis-dap',
        targetConfig: 'stm32f4x'
    }
});
assertEqual(openocd.args, [
    '-s', 'E:/ws',
    '-f', 'interface/cmsis-dap.cfg',
    '-f', 'target/stm32f4x.cfg',
    '-c', 'program "E:/build/app.bin" 0x08000000 verify',
    '-c', 'reset run',
    '-c', 'exit'
], 'OpenOCD: program args and unix path conversion');
assert(openocd.verify === true, 'OpenOCD: program verifies');

const openocdNoVerify = buildOpenOCDCommand({
    uploader: 'OpenOCD',
    programs: [{ path: 'E:/build/app.hex' }],
    verify: false,
    options: {
        executable: 'openocd',
        interfaceConfig: 'cmsis-dap',
        targetConfig: 'stm32f4x'
    }
});
assertEqual(openocdNoVerify.args[5], 'program "E:/build/app.hex"', 'OpenOCD: verify=false omits verify keyword');
assert(openocdNoVerify.verify === false, 'OpenOCD: reports no verification');

assertBuildError('invalid_request', () => buildOpenOCDCommand({
    uploader: 'OpenOCD',
    programs: [{ path: 'E:/build/app.bin' }],
    options: {
        executable: 'openocd',
        interfaceConfig: 'cmsis-dap',
        targetConfig: 'stm32f4x'
    }
}), 'OpenOCD: bin without address is rejected');

assertBuildError('not_supported', () => buildOpenOCDCommand({
    uploader: 'OpenOCD',
    eraseAll: true,
    programs: [],
    options: {
        executable: 'openocd',
        interfaceConfig: 'cmsis-dap',
        targetConfig: 'stm32f4x'
    }
}), 'OpenOCD: erase-all is unsupported');

const pyocdOptions = {
    executable: 'pyocd',
    target: 'stm32f103rc',
    frequency: '4M',
    configFile: 'E:/prj/pyocd.yaml',
    extraArgs: ['--no-wait']
};

const pyocd = buildPyOCDCommand({
    uploader: 'pyOCD',
    programs: [
        { path: 'E:/build/app.elf' },
        { path: 'E:/build/app.bin', address: '0x08000000' }
    ],
    options: pyocdOptions
});
assertEqual(pyocd.args, [
    'flash', '--no-wait',
    '--config', 'E:/prj/pyocd.yaml',
    '-t', 'stm32f103rc',
    '-f', '4M',
    'E:/build/app.elf',
    'E:/build/app.bin@0x08000000'
], 'pyOCD: program args');
assert(pyocd.verify === false, 'pyOCD: never claims verification');

const pyocdBinWithoutAddress = buildPyOCDCommand({
    uploader: 'pyOCD',
    programs: [{ path: 'E:/build/app.bin' }],
    options: { executable: 'pyocd', target: 'stm32f103rc' }
});
assertEqual(pyocdBinWithoutAddress.args, [
    'flash', '-t', 'stm32f103rc', 'E:/build/app.bin'
], 'pyOCD: bin without address relies on the documented flash start');

const pyocdErase = buildPyOCDCommand({
    uploader: 'pyOCD',
    eraseAll: true,
    programs: [],
    options: pyocdOptions
});
assertEqual(pyocdErase.args, [
    'erase', '--no-wait', '--chip',
    '--config', 'E:/prj/pyocd.yaml',
    '-t', 'stm32f103rc',
    '-f', '4M'
], 'pyOCD: erase-all args');
assert(pyocdErase.verify === false, 'pyOCD: erase-all does not verify');

const stlinkCli = buildSTLinkCommand({
    uploader: 'STLink',
    programs: [{ path: 'E:/build/app.bin', address: '0x08000000' }],
    options: {
        executable: 'ST-LINK_CLI.exe',
        variant: 'stlink-cli',
        protocol: 'SWD',
        frequencyKhz: 4000,
        resetMode: 'SWrst',
        runAfterProgram: true,
        externalLoader: 'E:/tools/ExternalLoader/stm32.stldr',
        optionBytes: ['RDP=0xAA']
    }
});
assertEqual(stlinkCli.args, [
    '-c', 'SWD', 'FREQ=4000', 'UR',
    'RM=Srst',
    '-P', 'E:/build/app.bin', '0x08000000',
    '-EL', 'E:/tools/ExternalLoader/stm32.stldr',
    '-OB', 'RDP=0xAA', '-rOB',
    '-V', 'after_programming',
    '-NoPrompt', '-TVolt',
    '-Run'
], 'STLink: ST-LINK_CLI program args');
assert(stlinkCli.verify === true, 'STLink: ST-LINK_CLI verifies');

const stlinkCliBinNoAddress = buildSTLinkCommand({
    uploader: 'STLink',
    programs: [{ path: 'E:/build/app.bin' }],
    options: {
        executable: 'ST-LINK_CLI.exe',
        variant: 'stlink-cli',
        runAfterProgram: false
    }
});
assertEqual(stlinkCliBinNoAddress.args, [
    '-c', 'SWD', 'FREQ=4000', 'UR',
    '-P', 'E:/build/app.bin',
    '-V', 'after_programming',
    '-NoPrompt', '-TVolt'
], 'STLink: bin without address omits the optional address argument');

const stlinkCliErase = buildSTLinkCommand({
    uploader: 'STLink',
    eraseAll: true,
    programs: [],
    options: {
        executable: 'ST-LINK_CLI.exe',
        variant: 'stlink-cli',
        protocol: 'SWD',
        frequencyKhz: 4000,
        runAfterProgram: false
    }
});
assertEqual(stlinkCliErase.args, [
    '-c', 'SWD', 'FREQ=4000', 'UR',
    '-ME',
    '-NoPrompt', '-TVolt'
], 'STLink: ST-LINK_CLI erase-all args');
assert(stlinkCliErase.verify === false, 'STLink: erase-all does not verify');

const stlinkEraseWithArtifacts = buildSTLinkCommand({
    uploader: 'STLink',
    eraseAll: true,
    programs: [{ path: 'E:/build/a.hex' }, { path: 'E:/build/b.hex' }],
    options: {
        executable: 'ST-LINK_CLI.exe',
        variant: 'stlink-cli',
        runAfterProgram: false
    }
});
assert(stlinkEraseWithArtifacts.args.includes('-ME'),
    'STLink: erase-all ignores supplied artifacts');

const stlinkCube = buildSTLinkCommand({
    uploader: 'STLink',
    programs: [{ path: 'E:/build/app.bin', address: '0x08000000' }],
    options: {
        executable: 'STM32_Programmer_CLI.exe',
        variant: 'cube-programmer',
        protocol: 'JTAG',
        frequencyKhz: 2000,
        resetMode: 'HWrst',
        runAfterProgram: true,
        externalLoader: 'E:/tools/ExternalLoader/stm32.stldr',
        optionBytes: ['RDP=0xAA']
    }
});
assertEqual(stlinkCube.args, [
    '-c', 'port=JTAG', 'freq=2000',
    'reset=HWrst',
    '-el', 'E:/tools/ExternalLoader/stm32.stldr',
    '-ob', 'RDP=0xAA', '-ob', 'displ',
    '--download', 'E:/build/app.bin', '0x08000000',
    '-v',
    '--go'
], 'STLink: CubeProgrammer program args');
assert(stlinkCube.verify === true, 'STLink: CubeProgrammer verifies');

const stlinkCubeNoVerify = buildSTLinkCommand({
    uploader: 'STLink',
    programs: [{ path: 'E:/build/app.hex' }],
    verify: false,
    options: {
        executable: 'STM32_Programmer_CLI.exe',
        variant: 'cube-programmer',
        runAfterProgram: false
    }
});
assert(!stlinkCubeNoVerify.args.includes('-v'), 'STLink: verify=false omits CubeProgrammer verify flag');
assert(stlinkCubeNoVerify.verify === false, 'STLink: verify=false is reported');

assertBuildError('invalid_request', () => buildSTLinkCommand({
    uploader: 'STLink',
    programs: [{ path: 'E:/build/a.hex' }, { path: 'E:/build/b.hex' }],
    options: {
        executable: 'ST-LINK_CLI.exe',
        variant: 'stlink-cli'
    }
}), 'STLink: rejects multiple program files');

const probeRsOptions = {
    executable: 'cargo-flash',
    chip: 'STM32F103C8',
    protocol: 'swd' as const,
    speedKhz: 4000,
    workDir: 'E:/ws'
};

const probeRs = buildProbeRSCommand({
    uploader: 'probe-rs',
    programs: [{ path: 'E:/build/app.elf' }],
    options: probeRsOptions
});
assertEqual(probeRs.args, [
    '--chip', 'STM32F103C8',
    '--protocol', 'swd',
    '--work-dir', 'E:/ws',
    '--path', 'E:/build/app.elf',
    '--verify',
    '--speed', '4000'
], 'probe-rs: program args');
assert(probeRs.verify === true, 'probe-rs: verifies');

const probeRsBin = buildProbeRSCommand({
    uploader: 'probe-rs',
    programs: [{ path: 'E:/build/app.bin' }],
    address: '0x08000000',
    options: {
        executable: 'cargo-flash',
        chip: 'STM32F103C8'
    }
});
assertEqual(probeRsBin.args, [
    '--chip', 'STM32F103C8',
    '--protocol', 'swd',
    '--path', 'E:/build/app.bin',
    '--binary-format', 'bin',
    '--base-address', '0x08000000',
    '--verify'
], 'probe-rs: bin declares its format and address');

assertBuildError('invalid_request', () => buildProbeRSCommand({
    uploader: 'probe-rs',
    programs: [{ path: 'E:/build/app.bin' }],
    options: {
        executable: 'cargo-flash',
        chip: 'STM32F103C8'
    }
}), 'probe-rs: bin without address is rejected');

assertBuildError('not_supported', () => buildProbeRSCommand({
    uploader: 'probe-rs',
    eraseAll: true,
    programs: [],
    options: probeRsOptions
}), 'probe-rs: erase-all is unsupported');

assertBuildError('invalid_request', () => buildProbeRSCommand({
    uploader: 'probe-rs',
    programs: [{ path: 'E:/build/a.elf' }, { path: 'E:/build/b.elf' }],
    options: probeRsOptions
}), 'probe-rs: rejects multiple program files');

assertBuildError('not_supported', () => buildJLinkCommand({
    uploader: 'JLink',
    eraseAll: true,
    verify: true,
    programs: [],
    options: jlinkOptions
}), 'flash: verify with erase-all is rejected');

assertBuildError('invalid_request', () => buildJLinkCommand({
    uploader: 'JLink',
    programs: [],
    options: jlinkOptions
}), 'flash: program requires an artifact');

assertBuildError('invalid_request', () => buildJLinkCommand({
    uploader: 'JLink',
    programs: [{ path: '   ' }],
    options: jlinkOptions
}), 'flash: empty artifact path is rejected');

assertBuildError('not_supported', () => buildFlashCommand({
    uploader: 'STVP',
    programs: []
}), 'dispatcher: STVP is unsupported');

assertBuildError('not_supported', () => buildFlashCommand({
    uploader: 'Custom',
    programs: []
}), 'dispatcher: Custom is unsupported');

const jlinkCaps = getFlashCapabilities('JLink');
assert(jlinkCaps.supported === true, 'capabilities: JLink supported');
assert(jlinkCaps.eraseAll === true, 'capabilities: JLink erase-all');
assert(jlinkCaps.verify === 'always', 'capabilities: JLink always verifies');
assert(jlinkCaps.readback === false, 'capabilities: JLink readback unsupported');

const openocdCaps = getFlashCapabilities('OpenOCD');
assert(openocdCaps.eraseAll === false, 'capabilities: OpenOCD erase-all unsupported');
assert(openocdCaps.verify === 'optional', 'capabilities: OpenOCD optional verify');

const pyocdCaps = getFlashCapabilities('pyOCD');
assert(pyocdCaps.eraseAll === true, 'capabilities: pyOCD erase-all');
assert(pyocdCaps.verify === 'unsupported', 'capabilities: pyOCD cannot verify');

const stlinkCaps = getFlashCapabilities('STLink');
assert(stlinkCaps.eraseAll === true, 'capabilities: STLink erase-all');
assert(stlinkCaps.verify === 'optional', 'capabilities: STLink optional verify');

const probeRsCaps = getFlashCapabilities('probe-rs');
assert(probeRsCaps.eraseAll === false, 'capabilities: probe-rs erase-all unsupported');
assert(probeRsCaps.verify === 'optional', 'capabilities: probe-rs optional verify');

const stvpCaps = getFlashCapabilities('STVP');
assert(stvpCaps.supported === false, 'capabilities: STVP unsupported');
assert(stvpCaps.verify === 'unsupported', 'capabilities: STVP cannot verify');
assert(typeof stvpCaps.reason === 'string' && stvpCaps.reason.length > 0, 'capabilities: STVP reason');

assertEqual(listFlashTools().length, 8, 'capabilities: lists all uploaders');
