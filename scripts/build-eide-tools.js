#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'lib', 'eide_tools');
const projects = ['unify_builder', 'serial_monitor', 'axf2elf', 'verchk'];

function exeName(name, rid) {
    return rid.startsWith('win') ? `${name}.exe` : name;
}

function fail(message) {
    console.error(`error: ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    let rid;
    let out;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--rid' && argv[i + 1]) {
            rid = argv[++i];
        } else if (argv[i] === '--out' && argv[i + 1]) {
            out = argv[++i];
        } else {
            fail(`Unknown option: ${argv[i]}`);
        }
    }
    if (!rid) {
        if (process.platform === 'win32') rid = 'win-x64';
        else if (process.platform === 'darwin') rid = 'osx-arm64';
        else rid = 'linux-x64';
    }
    if (!out) {
        const platformDir = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
        out = path.join(root, 'res', 'tools', platformDir, 'unify_builder');
    }
    return { rid, out: path.resolve(root, out) };
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with ${result.status}\n${result.stderr || result.stdout}`);
    }
}

function copyDirectory(source, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isDirectory()) {
            copyDirectory(from, to);
        } else {
            fs.copyFileSync(from, to);
        }
    }
}

function hostRid() {
    if (process.platform === 'win32') return 'win-x64';
    if (process.platform === 'darwin') return process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64';
    return 'linux-x64';
}

function smoke(exe, dll, useHost) {
    const result = useHost
        ? spawnSync(exe, [], { encoding: 'utf8', timeout: 10000, windowsHide: true })
        : spawnSync('dotnet', [dll], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (result.error) {
        throw result.error;
    }
    if (typeof result.status !== 'number' && !result.signal) {
        throw new Error(`no exit status: ${useHost ? exe : dll}`);
    }
    const output = `${result.stdout || ''}${result.stderr || ''}`.split(/\r?\n/).find(Boolean) || '';
    console.log(`SMOKE ${path.basename(exe)} exit=${result.status} signal=${result.signal || ''} first=${output.slice(0, 120)}`);
    if (/install or update \.NET/i.test(output) || /hostfxr|framework.*not found/i.test(output)) {
        throw new Error(`smoke failed, .NET host could not start the app: ${useHost ? exe : dll}`);
    }
}

function main() {
    const { rid, out } = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(sourceRoot)) {
        fail(`submodule not initialized: ${sourceRoot}`);
    }
    fs.mkdirSync(out, { recursive: true });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eide-tools-'));
    try {
        for (const name of projects) {
            const project = path.join(sourceRoot, name, `${name}.csproj`);
            const publishDir = path.join(temp, name);
            console.log(`PUBLISH ${name} -> ${publishDir}`);
            run('dotnet', [
                'publish', project, '-c', 'Release', '--no-self-contained',
                '-r', rid, '--framework', 'net6.0',
                '-p:PublishReadyToRun=true', '-o', publishDir
            ], sourceRoot);
            copyDirectory(publishDir, out);
        }
        const useHost = rid === hostRid();
        for (const name of projects) {
            const exe = path.join(out, exeName(name, rid));
            const dll = path.join(out, `${name}.dll`);
            if (!fs.existsSync(exe)) {
                fail(`executable not found: ${exe}`);
            }
            if (!fs.existsSync(dll)) {
                fail(`assembly not found: ${dll}`);
            }
            smoke(exe, dll, useHost);
        }
        console.log(`OK: built and smoke-tested ${projects.length} tools into ${out}`);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

main();
