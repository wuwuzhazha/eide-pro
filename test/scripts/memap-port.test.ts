/**
 * Golden comparison for the built-in memap port (src/core/memap.ts).
 *
 * Fixtures under test/fixtures/memap/<format>/ were produced from real builds
 * and the expected numbers in golden.json come from the patched memap
 * (res/data/patches/memap.py, patchVer 2) via:
 *
 *   PYTHONPATH=<pkg> python36 -m memap -t GCC_ARM   -d 100 golden.map
 *   PYTHONPATH=<pkg> python36 -m memap -t ARM_MICRO -d 100 golden.map
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

for (const format of ['gcc', 'armcc'] as MemapFormat[]) {
    const fixture = loadFixture(format);
    const modules = parseMemapModules(fixture.mapText, format);
    const oldModules = parseMemapModules(fixture.oldMapText, format);

    compareModules(format, 'parsed modules', modules, fixture.golden.modules);
    compareModules(format, 'parsed .old modules', oldModules, fixture.golden.oldModules);
    checkTable(format, fixture.golden, buildMemapTable(modules, oldModules));
}

console.log('\nAll memap port golden tests passed.');
