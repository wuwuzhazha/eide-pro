#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(message) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
}

function assert(condition, message) {
    if (!condition) {
        fail(message);
    }
    console.log(`OK: ${message}`);
}

function parseJson(text, label) {
    try {
        return JSON.parse(text);
    } catch (error) {
        fail(`${label} did not return JSON: ${error.message}\n${text}`);
    }
}

const [template, aptPackage, expectedBinary, artifactExtensionsArg, requiredBinariesArg = ''] =
    process.argv.slice(2);
const artifactExtensions = artifactExtensionsArg.split(',').map(value => value.trim().toLowerCase());
const requiredBinaries = requiredBinariesArg
    ? requiredBinariesArg.split(',').map(value => value.trim())
    : [expectedBinary];
const repoRoot = path.resolve(__dirname, '..');
const toolchainRoot = process.env.TOOLCHAIN_ROOT || '/usr';
const work = process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, `eide-toolchain-${template}`)
    : fs.mkdtempSync(path.join(require('os').tmpdir(), `eide-toolchain-${template}-`));
const cli = path.join(repoRoot, 'dist', 'eide_cli.js');
const resources = path.join(repoRoot, 'res');

for (const binaryName of requiredBinaries) {
    const binary = path.join(toolchainRoot, 'bin', binaryName);
    if (!fs.existsSync(binary)) {
        fail(`expected EIDE binary is missing: ${binary} (apt package: ${aptPackage})`);
    }
    console.log(`OK: apt package ${aptPackage} provides ${binary}`);
}

const create = spawnSync(process.execPath, [
    cli, 'create', '--name', 'firmware', '--template', template,
    '--output', work, '--project-name', 'firmware', '--resources', resources
], { encoding: 'utf8' });
assert(create.status === 0, `eide-cli create ${template}\n${create.stderr}`);
const created = parseJson(create.stdout, 'create');
assert(created.success === true, `create succeeded for ${template}`);
assert(path.isAbsolute(created.projectPath) && fs.existsSync(created.projectPath),
    `created.projectPath is an existing absolute path: ${created.projectPath}`);
assert(fs.existsSync(path.join(created.projectPath, '.eide', 'eide.yml')),
    `created project contains .eide/eide.yml: ${created.projectPath}`);
console.log(`CREATED ${created.projectPath}`);

const build = spawnSync(process.execPath, [
    cli, 'build', '--project', created.projectPath, '--toolchain-path', toolchainRoot,
    '--timeout', '300000'
], { encoding: 'utf8' });
assert(build.status === 0, `eide-cli build ${template}\n${build.stderr}\n${build.stdout}`);
const result = parseJson(build.stdout, 'build');
assert(result.success === true, `build succeeded for ${template}`);
assert(Array.isArray(result.artifacts)
    && result.artifacts.some(file => artifactExtensions.some(extension =>
        file.toLowerCase().endsWith(extension))),
`build produced one of ${artifactExtensions.join(',')} for ${template}: ${JSON.stringify(result.artifacts)}`);
console.log(`BREADTH_BUILD_OK template=${template} apt=${aptPackage} binary=${expectedBinary}`);
