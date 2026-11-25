import * as fs from 'fs';
import * as NodePath from 'path';
const { resolveToolchainEnvironment } = require('../../../src/core/toolchain_env');

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

function baseOptions(overrides: any = {}): any {
    return {
        projectPath: 'C:/project',
        target: 'Debug',
        type: 'ARM',
        toolchain: 'GCC',
        settings: {},
        resourcesDir: NodePath.join(process.cwd(), 'res'),
        envPath: '',
        platform: 'win32',
        fileExists: (path: string) => path.endsWith('arm-none-eabi-gcc.exe') && path.includes('toolchain'),
        ...overrides
    };
}

function run(): void {
    const settings = resolveToolchainEnvironment(baseOptions({
        settings: { 'ARM.GCC.InstallDirectory': 'C:/Keil/ARM' },
        fileExists: (path: string) => NodePath.resolve(path) === NodePath.resolve('C:/Keil/ARM')
            || NodePath.resolve(path) === NodePath.resolve('C:/Keil/ARM/bin/arm-none-eabi-gcc.exe')
    }));
    const gccFromSettings = settings.tools.find((tool: any) => tool.name === 'arm-none-eabi-gcc.exe');
    assert(gccFromSettings.source === 'settings', `settings path yields source=settings (${JSON.stringify(gccFromSettings)})`);
    assert(settings.searched.some((item: string) => item.includes('EIDE.ARM.GCC.InstallDirectory')),
        `searched names the concrete settings key (${JSON.stringify(settings.searched)})`);

    const pathOnly = resolveToolchainEnvironment(baseOptions({
        envPath: 'C:/msys/usr/bin',
        fileExists: (path: string) => NodePath.resolve(path) === NodePath.resolve('C:/msys/usr/bin/arm-none-eabi-gcc.exe')
    }));
    const gccFromPath = pathOnly.tools.find((tool: any) => tool.name === 'arm-none-eabi-gcc.exe');
    assert(gccFromPath.source === 'path', `PATH-only lookup yields source=path (${JSON.stringify(gccFromPath)})`);

    const notFound = resolveToolchainEnvironment(baseOptions({ fileExists: () => false }));
    assert(notFound.tools.every((tool: any) => tool.path === null && tool.source === 'not-found'),
        `missing tools report not-found without throwing (${JSON.stringify(notFound.tools)})`);
    assert(notFound.searched.length >= 4, `not-found includes a non-empty evidence chain (${JSON.stringify(notFound.searched)})`);

    const linuxDirs = resolveToolchainEnvironment(baseOptions({
        platform: 'linux',
        envPath: '/missing/bin:/opt/gcc/bin',
        fileExists: (path: string) => NodePath.resolve(path) === NodePath.resolve('/opt/gcc/bin/arm-none-eabi-gcc')
    }));
    const gccFromLinuxPath = linuxDirs.tools.find((tool: any) => tool.name === 'arm-none-eabi-gcc');
    assert(gccFromLinuxPath.source === 'path',
        `posix PATH splits on ':' regardless of the host (${JSON.stringify(gccFromLinuxPath)})`);

    const fakeToolchain = NodePath.join(process.cwd(), 'res', 'data', 'models');
    assert(fs.existsSync(fakeToolchain), 'fixture model directory exists');

    console.log('All toolchain environment tests passed.');
}

run();
