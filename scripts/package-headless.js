#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_NAME = 'eide-pro-headless';
const REQUIRED_PACKAGE_FILES = [
    'dist/eide_cli.js',
    'dist/eide_mcp.js',
    'res/data/models/arm.gcc.model.json',
    'res/tools/win32/unify_builder/unify_builder.exe',
    'res/tools/linux/unify_builder/unify_builder',
    'res/tools/darwin/unify_builder/x86_64/unify_builder',
    'res/tools/darwin/unify_builder/arm64/unify_builder',
    'lang/arm.gcc.verify.json',
    'skills/eide-mcp-tools/SKILL.md',
    'README.md',
    'LICENSE'
];

function fail(message) {
    console.error(`error: ${message}`);
    process.exit(1);
}

function parseOutDir(argv) {
    const index = argv.indexOf('--out');
    if (index === -1) {
        return path.resolve(__dirname, '..', 'artifacts');
    }
    const value = argv[index + 1];
    if (!value) {
        fail('--out requires a directory.');
    }
    return path.resolve(value);
}

function copy(source, target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
}

function requireFile(file) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        fail(`required file is missing: ${file}`);
    }
}

function requireDirectory(directory) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        fail(`required directory is missing: ${directory}`);
    }
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePackageJson(root, staging) {
    const source = readJson(path.join(root, 'package.json'));
    const configuration = source.contributes && source.contributes.configuration;
    if (!Array.isArray(configuration)) {
        fail('package.json must contribute configuration defaults for headless settings.');
    }
    const headless = {
        name: PACKAGE_NAME,
        version: source.version,
        description: 'Headless CLI and MCP server for EIDE AI embedded projects',
        license: source.license,
        author: source.author,
        homepage: source.homepage,
        bugs: source.bugs,
        repository: source.repository,
        keywords: ['embedded', 'mcu', 'eide', 'headless', 'cli', 'mcp', 'gcc', 'arm'],
        engines: { node: '>=18' },
        bin: {
            'eide-cli': './dist/eide_cli.js',
            'eide-mcp': './dist/eide_mcp.js'
        },
        files: [
            'dist',
            'res',
            'lang',
        'skills',
            'README.md',
            'LICENSE',
            'THIRD_PARTY_NOTICES.md',
            'licenses'
        ],
        contributes: { configuration }
    };
    fs.writeFileSync(path.join(staging, 'package.json'),
        `${JSON.stringify(headless, undefined, 4)}\n`);
}

function copyPayload(root, staging) {
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
        requireFile(path.join(root, file));
        copy(path.join(root, file), path.join(staging, file));
    }
    requireDirectory(path.join(root, 'licenses'));
    copy(path.join(root, 'licenses'), path.join(staging, 'licenses'));

    requireDirectory(path.join(root, 'dist'));
    for (const bundle of ['eide_cli.js', 'eide_mcp.js']) {
        const source = path.join(root, 'dist', bundle);
        requireFile(source);
        copy(source, path.join(staging, 'dist', bundle));
    }

    for (const directory of ['data', 'icon', 'template', 'tools']) {
        requireDirectory(path.join(root, 'res', directory));
        copy(path.join(root, 'res', directory), path.join(staging, 'res', directory));
    }
    requireDirectory(path.join(root, 'lang'));
    copy(path.join(root, 'lang'), path.join(staging, 'lang'));
    requireFile(path.join(root, 'docs', 'skills', 'eide-mcp-tools', 'SKILL.md'));
    copy(path.join(root, 'docs', 'skills', 'eide-mcp-tools', 'SKILL.md'),
        path.join(staging, 'skills', 'eide-mcp-tools', 'SKILL.md'));
    requireFile(path.join(root, 'docs', 'headless.md'));
    copy(path.join(root, 'docs', 'headless.md'), path.join(staging, 'README.md'));
}

function makeToolsExecutable(staging) {
    if (process.platform === 'win32') {
        return;
    }
    for (const relative of [
        'res/tools/linux/unify_builder/unify_builder',
        'res/tools/linux/unify_builder/axf2elf',
        'res/tools/linux/7z/7za',
        'res/tools/darwin/unify_builder/x86_64/unify_builder',
        'res/tools/darwin/unify_builder/arm64/unify_builder',
        'res/tools/darwin/7z/7za'
    ]) {
        const file = path.join(staging, relative);
        if (fs.existsSync(file)) {
            fs.chmodSync(file, 0o755);
        }
    }
}

function verifyPayload(staging) {
    for (const relative of REQUIRED_PACKAGE_FILES) {
        requireFile(path.join(staging, relative));
    }
    for (const bundle of ['eide_cli.js', 'eide_mcp.js']) {
        const firstLine = fs.readFileSync(path.join(staging, 'dist', bundle), 'utf8').split('\n', 1)[0];
        if (firstLine !== '#!/usr/bin/env node') {
            fail(`dist/${bundle} does not start with the Node.js shebang.`);
        }
    }
}

function pack(staging, outDir) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['pack', '--json', '--pack-destination', outDir], {
        cwd: staging,
        encoding: 'utf8',
        shell: process.platform === 'win32'
    });
    if (result.status !== 0) {
        fail(`npm pack failed:\n${result.stderr || result.stdout}`);
    }
    let packed;
    try {
        packed = JSON.parse(result.stdout)[0];
    } catch (error) {
        fail(`npm pack returned invalid JSON: ${error.message}`);
    }
    if (!packed || typeof packed.filename !== 'string') {
        fail('npm pack did not report a tarball name.');
    }
    const entries = new Set((packed.files || []).map(file => file.path));
    for (const required of REQUIRED_PACKAGE_FILES) {
        if (!entries.has(required)) {
            fail(`packed tarball is missing ${required}.`);
        }
    }
    if (entries.has('res/html/builder_options/index.html')) {
        fail('packed tarball includes editor-only res/html assets.');
    }
    return path.join(outDir, packed.filename);
}

function main() {
    const root = path.resolve(__dirname, '..');
    const outDir = parseOutDir(process.argv.slice(2));
    const staging = path.join(outDir, 'headless');
    const version = readJson(path.join(root, 'package.json')).version;
    const tarball = path.join(outDir, `${PACKAGE_NAME}-${version}.tgz`);

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.rmSync(tarball, { force: true });

    copyPayload(root, staging);
    writePackageJson(root, staging);
    makeToolsExecutable(staging);
    verifyPayload(staging);
    const packed = pack(staging, outDir);
    console.log(packed);
}

if (require.main === module) {
    main();
}

module.exports = { PACKAGE_NAME };
