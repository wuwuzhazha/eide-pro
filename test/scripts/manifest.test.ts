import * as fs from 'fs';
import * as NodePath from 'path';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

const root = process.cwd();
const pkgText = fs.readFileSync(NodePath.join(root, 'package.json'), 'utf8');
const pkg = JSON.parse(pkgText);
const lock = JSON.parse(fs.readFileSync(NodePath.join(root, 'package-lock.json'), 'utf8'));
const nlsEn = JSON.parse(fs.readFileSync(NodePath.join(root, 'package.nls.json'), 'utf8'));
const nlsZh = JSON.parse(fs.readFileSync(NodePath.join(root, 'package.nls.zh-CN.json'), 'utf8'));

const usedKeys = [...new Set([...pkgText.matchAll(/%([A-Za-z0-9_.-]+)%/g)].map(m => m[1]))];
const missingEn = usedKeys.filter(key => !(key in nlsEn));
const missingZh = usedKeys.filter(key => !(key in nlsZh));

assert(missingEn.length === 0, `package.nls.json contains all used keys (missing: ${missingEn.join(', ') || 'none'})`);
assert(missingZh.length === 0, `package.nls.zh-CN.json contains all used keys (missing: ${missingZh.join(', ') || 'none'})`);

const commandIds: string[] = pkg.contributes.commands.map((command: any) => command.command);
const duplicateIds = commandIds.filter((id, index) => commandIds.indexOf(id) !== index);
assert(duplicateIds.length === 0, `command ids are unique (duplicates: ${duplicateIds.join(', ') || 'none'})`);

const untitled = pkg.contributes.commands.filter((command: any) => !command.title);
assert(untitled.length === 0, `every command has a title (missing: ${untitled.map((c: any) => c.command).join(', ') || 'none'})`);

const { EXTENSION_ID, EXTENSION_DISPLAY_NAME, MARKETPLACE_EXTENSION_ID, isEideExtensionId } =
    require('../../../src/ExtensionInfo') as any;
assert(`${pkg.publisher}.${pkg.name}` === EXTENSION_ID,
    `package identity matches extension id '${EXTENSION_ID}'`);
assert([EXTENSION_ID, MARKETPLACE_EXTENSION_ID, 'cl.eide'].every(isEideExtensionId)
    && !isEideExtensionId('ms-vscode.cmake-tools') && !isEideExtensionId(undefined),
    'C/C++ provider migration recognizes only EIDE extension IDs');
assert(pkg.displayName === EXTENSION_DISPLAY_NAME,
    `display name matches '${EXTENSION_DISPLAY_NAME}'`);
assert(lock.version === pkg.version && lock.packages?.['']?.version === pkg.version,
    `package-lock version matches ${pkg.version}`);
assert(fs.existsSync(NodePath.join(root, pkg.icon)),
    `package icon exists at '${pkg.icon}'`);
