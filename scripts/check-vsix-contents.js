#!/usr/bin/env node
'use strict';

// vsce 2.x runs the vscode:prepublish script during `vsce ls` and interleaves
// that child's stdout into the file list, so the raw output cannot be trusted
// line by line. The reliable discriminator: entries vsce lists are files that
// exist relative to the package root; prepublish noise never resolves to one.
// The repository has no tracked file whose name contains a space, so a line
// with spaces that still resolves is impossible by construction.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function run(command, args) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'inherit'],
        cwd: root
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

// Pinned to the same vsce the release workflow packages with, so the check
// cannot silently drift to a newer major with different inclusion rules.
const rawLines = run('npx', ['--yes', '@vscode/vsce@2.15.0', 'ls']);
const vsceFiles = rawLines.filter(line => {
    if (/[<>|&;`$]/.test(line)) {
        return false;
    }
    const resolved = path.join(root, line);
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
});
if (vsceFiles.length === 0) {
    console.error('FAIL: vsce ls produced no file entries; the prepublish noise filter rejected everything.');
    process.exit(1);
}
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
