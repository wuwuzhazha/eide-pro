#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

function run(command, args) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'inherit']
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} exited with code ${result.status}`);
    }
    return result.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

function isAllowed(file, tracked) {
    if (tracked.has(file)) {
        return true;
    }
    if (file.startsWith('dist/')) {
        return true;
    }
    const aliases = {
        'readme.md': 'README.md',
        'changelog.md': 'CHANGELOG.md',
        'license.txt': 'LICENSE'
    };
    const alias = aliases[file.toLowerCase()];
    return alias !== undefined && tracked.has(alias);
}

const vsceFiles = run('npx', ['--yes', '@vscode/vsce', 'ls']);
const tracked = new Set(run('git', ['ls-files']).map(file => file.replace(/\\/g, '/')));
const leaked = vsceFiles.filter(file => !isAllowed(file, tracked));

if (leaked.length > 0) {
    console.error('FAIL: VSIX contents are not tracked files or allowed build output:');
    for (const file of leaked) {
        console.error(`  ${file}`);
    }
    console.error('Add it to .vscodeignore or stop tracking it.');
    process.exit(1);
}

console.log(`OK: vsix contents match tracked files (${vsceFiles.length} entries)`);
