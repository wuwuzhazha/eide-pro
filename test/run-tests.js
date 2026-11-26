const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const freshness = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-out-fresh.js')], { stdio: 'inherit' });
if (freshness.status !== 0) {
    process.exit(1);
}

const sourceDir = path.join(__dirname, 'scripts');
const testDir = path.join(__dirname, '..', 'out', 'tmp', 'test', 'scripts');

const expectedFiles = fs.readdirSync(sourceDir)
    .filter(file => file.endsWith('.ts'))
    .map(file => file.replace(/\.ts$/, '.js'))
    .sort();

const compiledFiles = new Set(fs.readdirSync(testDir));

for (const file of expectedFiles) {
    if (!compiledFiles.has(file)) {
        console.error(`Missing compiled file: ${file}. Run npm run compile:test.`);
        process.exit(1);
    }
}

for (const file of compiledFiles) {
    if (file.endsWith('.test.js') && !expectedFiles.includes(file)) {
        fs.unlinkSync(path.join(testDir, file));
        console.log(`removed stale ${file}`);
    }
}

if (expectedFiles.length === 0) {
    console.error(`No tests found in ${sourceDir}`);
    process.exit(1);
}

let failed = false;

for (const file of expectedFiles) {
    console.log(`\n=== ${file} ===`);
    const result = spawnSync(process.execPath, [path.join(testDir, file)], { stdio: 'inherit' });
    if (result.status !== 0) {
        failed = true;
    }
}

process.exit(failed ? 1 : 0);
