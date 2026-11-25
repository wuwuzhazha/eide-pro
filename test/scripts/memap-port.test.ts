/**
 * Golden comparison for the built-in memap port (src/core/memap.ts).
 *
 * Fixtures under test/fixtures/memap/<format>/ were produced from real builds
 * and the expected numbers in golden.json come from the patched memap
 * (res/data/patches/memap.py, patchVer 2) via:
 *
 *   PYTHONPATH=<pkg> python36 -m memap -t GCC_ARM   -d 100 golden.map
 *   PYTHONPATH=<pkg> python36 -m memap -t ARM_MICRO -d 100 golden.map
 *   PYTHONPATH=<pkg> python36 -m memap -t IAR       -d 100 golden.map
 *
 * The IAR map is the real ilinkarm output from mbed-os
 * tools/test/memap/iar.map (it carries the linker command line); its
 * golden.map.old only shrinks a few sizes to exercise the deltas.
 *
 * Module names are normalized to '/' so the same fixture works on Windows and
 * POSIX; every per-object per-section size and `.map.old` delta must match.
 */

import * as fs from 'fs';
import * as NodePath from 'path';
import {
    buildMemapTable,
    formatSigned,
    MEMAP_PRINT_SECTIONS,
    MemapFormat,
    MemapModules,
    MemapTable,
    parseMemapModules
} from '../../src/core/memap';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

function normalizeName(name: string): string {
    return name.replace(/\\/g, '/');
}

function normalizeModules(modules: MemapModules): { [name: string]: { [section: string]: number } } {
    const out: { [name: string]: { [section: string]: number } } = {};
    for (const name of Object.keys(modules))
        out[normalizeName(name)] = modules[name];
    return out;
}

function stable(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const record = value as { [key: string]: unknown };
        const sorted = Object.keys(record).sort();
        return `{${sorted.map((k) => `${JSON.stringify(k)}:${stable(record[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

const fixtureDir = NodePath.join(__dirname, '../../../../test/fixtures/memap');

interface GoldenFixture {
    format: MemapFormat;
    modules: { [name: string]: { [section: string]: number } };
    oldModules: { [name: string]: { [section: string]: number } };
    shortModules: { [name: string]: { [section: string]: number } };
    subtotal: { [section: string]: number };
    memSummary: { [key: string]: number };
}

function loadFixture(format: MemapFormat): {
    mapText: string,
    oldMapText: string,
    golden: GoldenFixture,
} {
    const dir = NodePath.join(fixtureDir, format);
    return {
        mapText: fs.readFileSync(NodePath.join(dir, 'golden.map'), 'utf8'),
        oldMapText: fs.readFileSync(NodePath.join(dir, 'golden.map.old'), 'utf8'),
        golden: JSON.parse(fs.readFileSync(NodePath.join(dir, 'golden.json'), 'utf8')),
    };
}

function compareModules(format: MemapFormat, label: string,
    actual: MemapModules, expected: GoldenFixture['modules']): void {
    const normalized = normalizeModules(actual);
    assert(stable(normalized) === stable(expected),
        `${format}: ${label} match memap (${Object.keys(expected).length} objects)`);
    if (stable(normalized) !== stable(expected)) {
        console.error('  actual  :', stable(normalized));
        console.error('  expected:', stable(expected));
    }
}

function checkTable(format: MemapFormat, golden: GoldenFixture,
    actual: MemapTable): void {

    assert(stable(actual.header) === stable(['Module'].concat(MEMAP_PRINT_SECTIONS)),
        `${format}: table header is the memap layout`);

    const cellsByModule: { [name: string]: string[] } = {};
    for (let i = 0; i < actual.rows.length - 1; i++) {
        const row = actual.rows[i];
        cellsByModule[normalizeName(row[0])] = row.slice(1);
    }

    const expectedNames = Object.keys(golden.shortModules).sort();
    assert(stable(Object.keys(cellsByModule).sort()) === stable(expectedNames),
        `${format}: table lists exactly the memap modules`);

    for (const name of expectedNames) {
        const cells = cellsByModule[name];
        const sizes = golden.shortModules[name];
        MEMAP_PRINT_SECTIONS.forEach((section, idx) => {
            const size = sizes[section] || 0;
            const delta = sizes[section + '-delta'] || 0;
            assert(cells[idx] === `${size}(${formatSigned(delta)})`,
                `${format}: ${name} ${section} = ${size}(${formatSigned(delta)})`);
        });
    }

    const subtotalRow = actual.rows[actual.rows.length - 1];
    assert(subtotalRow[0] === 'Subtotals', `${format}: subtotal row present`);
    MEMAP_PRINT_SECTIONS.forEach((section, idx) => {
        const size = golden.subtotal[section] || 0;
        const delta = golden.subtotal[section + '-delta'] || 0;
        assert(subtotalRow[idx + 1] === `${size}(${formatSigned(delta)})`,
            `${format}: subtotal ${section} = ${size}(${formatSigned(delta)})`);
    });

    assert(actual.staticRam === golden.memSummary['static_ram'] &&
        actual.staticRamDelta === golden.memSummary['static_ram_delta'],
        `${format}: static RAM = ${golden.memSummary['static_ram']}(${formatSigned(golden.memSummary['static_ram_delta'])})`);
    assert(actual.totalFlash === golden.memSummary['total_flash'] &&
        actual.totalFlashDelta === golden.memSummary['total_flash_delta'],
        `${format}: total flash = ${golden.memSummary['total_flash']}(${formatSigned(golden.memSummary['total_flash_delta'])})`);
}

for (const format of ['gcc', 'armcc', 'iar'] as MemapFormat[]) {
    const fixture = loadFixture(format);
    const modules = parseMemapModules(fixture.mapText, format);
    const oldModules = parseMemapModules(fixture.oldMapText, format);

    compareModules(format, 'parsed modules', modules, fixture.golden.modules);
    compareModules(format, 'parsed .old modules', oldModules, fixture.golden.oldModules);
    checkTable(format, fixture.golden, buildMemapTable(modules, oldModules));
}

/* ------------------------------------------------------------------ *
 * Builtin ToolchainManager path used by the map view: depth threading
 * and the report contract consumed by res/html/map_report.
 * ------------------------------------------------------------------ */

interface MapParserToolchain {
    parseMapFile(mapFile: string, treeDepth?: number): string[] | Error;
}

interface MementoLike {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown): Promise<void>;
    keys(): readonly string[];
    setKeysForSync?(keys: readonly string[]): void;
}

function memoryMemento(): MementoLike {
    return {
        get: () => undefined,
        update: async () => undefined,
        keys: () => [],
        setKeysForSync: () => undefined
    };
}

const repoRoot = NodePath.join(__dirname, '../../../..');

/* ToolchainManager builds AC5/AC6/GCC from res/data/models, so the headless
   runtime (shim + ResManager + SettingManager context) must be initialized
   before it is loaded. */
function initMapViewRuntime(): void {
    const { initHeadlessRuntime } = require('../../../src/headless/host') as {
        initHeadlessRuntime(options: {
            resourcesDir: string;
            extensionRoot: string;
            workspaceRoot: string;
            settings: unknown;
            workspaceState: MementoLike;
            globalState: MementoLike;
        }): void;
    };
    const { loadHeadlessSettings } = require('../../../src/headless/settings') as {
        loadHeadlessSettings(extensionRoot: string, workspaceFile: string | undefined,
            settingsFile: string | undefined): unknown;
    };
    initHeadlessRuntime({
        resourcesDir: NodePath.join(repoRoot, 'res'),
        extensionRoot: repoRoot,
        workspaceRoot: repoRoot,
        settings: loadHeadlessSettings(repoRoot, undefined, undefined),
        workspaceState: memoryMemento(),
        globalState: memoryMemento()
    });
}

function loadToolchain(name: string): MapParserToolchain | undefined {
    const { ToolchainManager } = require('../../../src/ToolchainManager') as {
        ToolchainManager: {
            getInstance(): {
                getToolchainByName(toolchainName: string): MapParserToolchain | undefined;
            };
        };
    };
    return ToolchainManager.getInstance().getToolchainByName(name);
}

function moduleNames(lines: string[]): string[] {
    return lines
        .filter((line) => line.startsWith('|'))
        .map((line) => line.split('|')[1].trim())
        .filter((name) => name !== '' && name !== 'Module' && name !== 'Subtotals');
}

initMapViewRuntime();

for (const [toolchainName, format] of [
    ['GCC', 'gcc'],
    ['AC5', 'armcc'],
    ['IAR_ARM', 'iar'],
] as [string, MemapFormat][]) {
    const toolchain = loadToolchain(toolchainName);
    assert(toolchain !== undefined && typeof toolchain.parseMapFile === 'function',
        `${toolchainName}: builtin map parser is wired`);
    if (toolchain === undefined)
        continue;

    const mapPath = NodePath.join(fixtureDir, format, 'golden.map');
    const shallow = toolchain.parseMapFile(mapPath, 2);
    const full = toolchain.parseMapFile(mapPath, 100);

    assert(!(shallow instanceof Error), `${toolchainName}: depth=2 parse succeeds`);
    assert(!(full instanceof Error), `${toolchainName}: depth=100 parse succeeds`);
    if (shallow instanceof Error || full instanceof Error)
        continue;

    const shallowNames = moduleNames(shallow);
    const fullNames = moduleNames(full);

    const libLeaf = format === 'gcc'
        ? NodePath.join('[lib]', 'golden.a', 'lib.o')
        : format === 'armcc'
            ? NodePath.join('[lib]', 'c_p.l', '__main.o')
            : NodePath.join('[lib]', 'd16M_tlf.a', '__main.o');
    const libDir = NodePath.dirname(libLeaf);

    assert(fullNames.includes(libLeaf) && !fullNames.includes(libDir),
        `${toolchainName}: depth=100 keeps the full library path '${libLeaf}'`);
    assert(shallowNames.includes(libDir) && !shallowNames.includes(libLeaf),
        `${toolchainName}: depth=2 groups the library row under '${libDir}'`);

    // memap `-d` only truncates module rows; subtotals and totals keep
    // summing the full module list.
    const shallowRam = shallow.find((line) => line.startsWith('Total Static RAM memory'));
    const fullRam = full.find((line) => line.startsWith('Total Static RAM memory'));
    const shallowFlash = shallow.find((line) => line.startsWith('Total Flash memory'));
    const fullFlash = full.find((line) => line.startsWith('Total Flash memory'));
    assert(shallowRam === fullRam && shallowFlash === fullFlash,
        `${toolchainName}: depth leaves the RAM/Flash totals unchanged`);

    const headerLine = full.find((line) => /^\|\s+Module\s+/.test(line));
    assert(headerLine !== undefined, `${toolchainName}: builtin output has the | Module header row`);
    if (headerLine !== undefined) {
        const columns = headerLine.split('|')
            .map((cell) => cell.trim())
            .filter((cell) => cell !== '')
            .slice(1);
        assert(stable(columns) === stable(['.text', '.data', '.bss', '.rodata']),
            `${toolchainName}: header columns match res/html/map_report`);
    }

    if (format === 'gcc') {
        assert(fullRam === 'Total Static RAM memory (data + bss): 86(+0) bytes',
            'GCC: RAM total line matches res/html/map_report');
        assert(fullFlash === 'Total Flash memory (text + data + rodata): 264(+16) bytes',
            'GCC: Flash total line matches res/html/map_report');
    } else if (format === 'iar') {
        // memap `SECTIONS` also sums `.heap`/`.stack` into the subtotals, but
        // `static_ram` stays data + bss (the real map has no heap/stack rows).
        assert(fullRam === 'Total Static RAM memory (data + bss): 432(+24) bytes',
            'IAR_ARM: RAM total line matches memap');
        assert(fullFlash === 'Total Flash memory (text + data + rodata): 430(+14) bytes',
            'IAR_ARM: Flash total line matches memap');
    }
}

console.log('\nAll memap port golden tests passed.');
