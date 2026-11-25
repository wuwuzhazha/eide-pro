/*
    MIT License

    Copyright (c) 2019 github0null

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
*/

/*
    TypeScript port of the format parsers in the bundled memap (Apache-2.0, ARM).
    Only the two map formats used by the map view are ported here:

    - 'gcc'   -> memap `_GccParser`   (GNU ld map, used by GCC / GNU_SDCC_MCS51)
    - 'armcc' -> memap `_ArmccParser` (ARMCC/ARMClang map, used by AC5 / AC6)

    The IAR format needs memap's yaml driven configuration and is intentionally
    not ported here; IAR_ARM keeps using memap.

    Parsing behavior (paths, section names, merge rules, `.map.old` deltas) is
    kept numerically identical to `res/data/patches/memap.py`, which is the
    version EIDE installs (patchVer 2). The golden fixtures under
    `test/fixtures/memap/` were produced with that exact file.
*/

import * as NodePath from 'path';

export type MemapFormat = 'gcc' | 'armcc';

export interface MemapModuleSizes {
    [section: string]: number;
}

export interface MemapModules {
    [module: string]: MemapModuleSizes;
}

export interface MemapTable {
    header: string[];
    /** Module rows followed by the `Subtotals` row, in output order. */
    rows: string[][];
    staticRam: number;
    staticRamDelta: number;
    totalFlash: number;
    totalFlashDelta: number;
}

const SECTIONS = ['.text', '.data', '.bss', '.heap', '.stack', '.rodata'];
const MISC_FLASH_SECTIONS = ['.interrupts', '.flash_config'];
const OTHER_SECTIONS = [
    '.interrupts_ram', '.init', '.ARM.extab', '.ARM.exidx', '.ARM.attributes',
    '.eh_frame', '.init_array', '.fini_array', '.jcr', '.stab', '.stabstr',
    '.ARM.exidx', '.ARM'
];
const GCC_ALL_SECTIONS = SECTIONS.concat(OTHER_SECTIONS, MISC_FLASH_SECTIONS, ['unknown', 'OUTPUT']);
const OBJECT_EXTENSIONS = ['.o', '.obj'];

/** Sections rendered as table columns, same as memap `print_sections`. */
export const MEMAP_PRINT_SECTIONS = ['.text', '.data', '.bss', '.rodata'];

const RE_GCC_OBJECT_FILE = /^(.+\/.+\.o(bj)?)$/;
const RE_GCC_LIBRARY_OBJECT = /^.+lib((.+\.a)\((.+\.o(bj)?)\))$/;
const RE_GCC_STD_SECTION = /^\s+.*0x(\w{8,16})\s+0x(\w+)\s(.+)$/;
const RE_GCC_FILL_SECTION = /^\s*\*fill\*\s+0x(\w{8,16})\s+0x(\w+).*$/;
const RE_GCC_TRANS_FILE = /^(.+\/|.+\.ltrans.o(bj)?)$/;

const RE_ARMCC_ROW = /^\s+0x(\w{8})\s+0x(\w{8})\s+(\w+)\s+(\w+)\s+(\d+)\s+[*]?.+\s+(.+)$/;
const RE_ARMCC_OBJECT = /^(.+\.(l|lib|ar))\((.+\.o(bj)?)\)/;

function parseHex(value: string): number {
    if (!/^[0-9a-f]+$/i.test(value))
        throw new Error(`Invalid hex value in map file: '${value}'`);
    return parseInt(value, 16);
}

function isObjectName(name: string): boolean {
    return OBJECT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function commonStringPrefix(values: string[]): string {
    if (values.length === 0)
        return '';
    let prefix = values[0];
    for (const value of values.slice(1)) {
        let idx = 0;
        while (idx < prefix.length && idx < value.length && prefix[idx] === value[idx])
            idx++;
        prefix = prefix.slice(0, idx);
    }
    return prefix;
}

function isPathSep(ch: string): boolean {
    return ch === '/' || ch === '\\';
}

/*
    Python `os.path.dirname` keeps a trailing separator's component
    (`dirname('build/v2/') == 'build/v2'`), while Node's dirname returns
    `'build'`. memap uses the Python behavior to strip the common prefix.
*/
function memapDirname(path: string): string {
    let sepIdx = -1;
    for (let i = path.length - 1; i >= 0; i--) {
        if (isPathSep(path[i])) {
            sepIdx = i;
            break;
        }
    }
    let head = path.slice(0, sepIdx + 1);
    if (head !== '' && head.split('').some((ch) => !isPathSep(ch))) {
        while (head.length > 0 && isPathSep(head[head.length - 1]))
            head = head.slice(0, -1);
    }
    return head;
}

function commonDir(names: string[]): string {
    const prefix = commonStringPrefix(names);
    if (prefix === '')
        return '';
    return memapDirname(prefix);
}

/**
 * memap `to_relative_path`. `toolchainRootDir` mirrors memap's global
 * `TOOLCHAIN_ROOTDIR`, which it reads from the `<map>.view` compiler path.
 */
function toRelativePath(path: string, root: string, toolchainRootDir: string | undefined): string {
    try {
        const parts = path.split(/[/\\]/);
        if (parts.length > 4 && parts[0] === '.' && parts[3] === '.obj')
            return NodePath.normalize(parts.slice(4).join('/'));
        if (parts.length > 3 && parts[2] === '.obj')
            return NodePath.normalize(parts.slice(3).join('/'));
        if (root.trim() === '') {
            if (toolchainRootDir !== undefined &&
                path.includes(NodePath.basename(toolchainRootDir))) {
                let result = NodePath.normalize(NodePath.relative(toolchainRootDir, path));
                if (!NodePath.isAbsolute(result))
                    result = NodePath.join('[lib]', 'misc', result);
                return result;
            }
            return NodePath.normalize(path);
        }
        return NodePath.normalize(NodePath.relative(root, path));
    } catch {
        return NodePath.normalize(path);
    }
}

class ModuleStore {

    private readonly map = new Map<string, MemapModuleSizes>();

    /** memap `_Parser.module_add`. */
    add(objectName: string, size: number, section: string): void {
        if (!objectName || !size || !section)
            return;

        const existing = this.map.get(objectName);
        if (existing) {
            existing[section] = (existing[section] || 0) + size;
            return;
        }

        const objSplit = NodePath.sep + NodePath.basename(objectName);
        for (const [modulePath, contents] of this.map) {
            if (modulePath.endsWith(objSplit) || modulePath === objectName) {
                contents[section] = (contents[section] || 0) + size;
                return;
            }
        }

        const sizes: MemapModuleSizes = {};
        sizes[section] = size;
        this.map.set(objectName, sizes);
    }

    entries(): [string, MemapModuleSizes][] {
        return Array.from(this.map.entries());
    }
}

function checkGccSection(line: string): string | undefined {
    const stripped = line.trim();
    for (const name of GCC_ALL_SECTIONS)
        if (stripped.startsWith(name))
            return name;
    if (line.startsWith('.'))
        return 'unknown';
    return undefined;
}

function parseGccObjectName(line: string): string {
    if (RE_GCC_TRANS_FILE.test(line))
        return '[misc]';

    const objectMatch = RE_GCC_OBJECT_FILE.exec(line);
    if (objectMatch) {
        const objectName = objectMatch[1];
        if (line.includes('arm-none-eabi'))
            return NodePath.join('[lib]', 'misc', NodePath.basename(objectName));
        return objectName;
    }

    const libraryMatch = RE_GCC_LIBRARY_OBJECT.exec(line);
    if (libraryMatch)
        return NodePath.join('[lib]', libraryMatch[2], libraryMatch[3]);

    return '[misc]';
}

function parseGccSection(line: string): [string, number] {
    const fillMatch = RE_GCC_FILL_SECTION.exec(line);
    if (fillMatch)
        return ['[fill]', parseHex(fillMatch[2])];

    const sectionMatch = RE_GCC_STD_SECTION.exec(line);
    if (sectionMatch) {
        const size = parseHex(sectionMatch[2]);
        if (size)
            return [parseGccObjectName(sectionMatch[3]), size];
    }

    return ['', 0];
}

function finalizeModules(store: ModuleStore, toolchainRootDir: string | undefined,
    isPreserved: (name: string) => boolean): MemapModules {
    const entries = store.entries();
    const objectNames = entries
        .map((entry) => entry[0])
        .filter((name) => isObjectName(name) && !isPreserved(name));
    const commonPrefix = commonDir(objectNames);

    const modules: MemapModules = {};
    for (const [name, sizes] of entries) {
        if (isPreserved(name))
            modules[name] = sizes;
        else if (isObjectName(name))
            modules[toRelativePath(name, commonPrefix, toolchainRootDir)] = sizes;
        else
            modules[name] = sizes;
    }
    return modules;
}

/** memap `_GccParser.parse_mapfile`. */
export function parseGccMap(text: string, toolchainRootDir?: string): MemapModules {
    const lines = text.split(/\r\n|\n/);
    const store = new ModuleStore();

    let idx = 0;
    while (idx < lines.length && !lines[idx].startsWith('Linker script and memory map'))
        idx++;

    let currentSection = 'unknown';
    for (idx = idx + 1; idx < lines.length; idx++) {
        const line = lines[idx];
        const nextSection = checkGccSection(line);
        if (nextSection === 'OUTPUT')
            break;
        if (nextSection !== undefined)
            currentSection = nextSection;
        store.add(...parseGccSection(line), currentSection);
    }

    return finalizeModules(store, toolchainRootDir, (name) => name.startsWith('[lib]'));
}

function parseArmccObjectName(line: string): string {
    if (isObjectName(line))
        return line;

    const objectMatch = RE_ARMCC_OBJECT.exec(line);
    if (objectMatch)
        return NodePath.join('[lib]', NodePath.basename(objectMatch[1]), objectMatch[3]);

    return '[misc]';
}

function parseArmccSection(line: string): [string, number, string] {
    const rowMatch = RE_ARMCC_ROW.exec(line);
    if (!rowMatch || line.includes('ARM_LIB_HEAP'))
        return ['', 0, ''];

    const size = parseHex(rowMatch[2]);
    const type = rowMatch[3];
    const attr = rowMatch[4];

    let section: string;
    if (attr === 'RO') {
        section = type === 'Data' ? '.rodata' : '.text';
    } else if (type === 'Data') {
        section = '.data';
    } else if (type === 'Zero') {
        section = '.bss';
    } else if (type === 'Code') {
        section = '.text';
    } else {
        return ['', 0, ''];
    }

    return [parseArmccObjectName(rowMatch[6]), size, section];
}

/** memap `_ArmccParser.parse_mapfile`. */
export function parseArmccMap(text: string, toolchainRootDir?: string): MemapModules {
    const lines = text.split(/\r\n|\n/);
    const store = new ModuleStore();

    let idx = 0;
    while (idx < lines.length && !lines[idx].startsWith('    Base Addr    Size'))
        idx++;

    for (idx = idx + 1; idx < lines.length; idx++)
        store.add(...parseArmccSection(lines[idx]));

    return finalizeModules(store, toolchainRootDir, (name) =>
        name === 'anon$$obj.o' || name === 'anon$$obj.obj' || name.startsWith('[lib]'));
}

export function parseMemapModules(text: string, format: MemapFormat,
    toolchainRootDir?: string): MemapModules {
    switch (format) {
        case 'gcc':
            return parseGccMap(text, toolchainRootDir);
        case 'armcc':
            return parseArmccMap(text, toolchainRootDir);
    }
    throw new Error(`Unsupported memap format: ${format}`);
}

/** memap `{:+}` formatting, e.g. `+12`, `-3`, `+0`. */
export function formatSigned(value: number): string {
    return `${value >= 0 ? '+' : ''}${value}`;
}

/**
 * Build the memap `table` report: `Module | .text | .data | .bss | .rodata`
 * rows plus a `Subtotals` row. `.map.old` deltas follow memap's
 * `reduce_depth`/`compute_report` semantics.
 */
export function buildMemapTable(modules: MemapModules, oldModules?: MemapModules): MemapTable {
    const short: { [module: string]: { [key: string]: number } } = {};

    for (const name of Object.keys(modules)) {
        const entry: { [key: string]: number } = {};
        for (const section of Object.keys(modules[name])) {
            const size = modules[name][section];
            entry[section] = (entry[section] || 0) + size;
            entry[section + '-delta'] = (entry[section + '-delta'] || 0) + size;
        }
        short[name] = entry;
    }

    if (oldModules) {
        for (const name of Object.keys(oldModules)) {
            const entry = short[name] || (short[name] = {});
            for (const section of Object.keys(oldModules[name])) {
                const key = section + '-delta';
                entry[key] = (entry[key] || 0) - oldModules[name][section];
            }
        }
    }

    const subtotal: { [key: string]: number } = {};
    for (const section of SECTIONS) {
        for (const name of Object.keys(modules)) {
            const size = modules[name][section] || 0;
            subtotal[section] = (subtotal[section] || 0) + size;
            subtotal[section + '-delta'] = (subtotal[section + '-delta'] || 0) + size;
        }
        if (oldModules) {
            for (const name of Object.keys(oldModules)) {
                const key = section + '-delta';
                subtotal[key] = (subtotal[key] || 0) - (oldModules[name][section] || 0);
            }
        }
    }

    const header = ['Module'].concat(MEMAP_PRINT_SECTIONS);
    const rows: string[][] = [];
    for (const name of Object.keys(short).sort()) {
        const row = [name];
        for (const section of MEMAP_PRINT_SECTIONS)
            row.push(`${short[name][section] || 0}(${formatSigned(short[name][section + '-delta'] || 0)})`);
        rows.push(row);
    }

    const subtotalRow = ['Subtotals'];
    for (const section of MEMAP_PRINT_SECTIONS)
        subtotalRow.push(`${subtotal[section] || 0}(${formatSigned(subtotal[section + '-delta'] || 0)})`);
    rows.push(subtotalRow);

    const staticRam = (subtotal['.data'] || 0) + (subtotal['.bss'] || 0);
    const staticRamDelta = (subtotal['.data-delta'] || 0) + (subtotal['.bss-delta'] || 0);
    const totalFlash = (subtotal['.text'] || 0) + (subtotal['.data'] || 0) + (subtotal['.rodata'] || 0);
    const totalFlashDelta = (subtotal['.text-delta'] || 0) + (subtotal['.data-delta'] || 0) +
        (subtotal['.rodata-delta'] || 0);

    return { header, rows, staticRam, staticRamDelta, totalFlash, totalFlashDelta };
}
