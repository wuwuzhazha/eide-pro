const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(repoRoot, 'src');
const outRoot = path.join(repoRoot, 'out', 'src');

function listTypeScriptFiles(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'html' || entry.name === 'node_modules') {
                continue;
            }
            found.push(...listTypeScriptFiles(fullPath));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            found.push(fullPath);
        }
    }
    return found;
}

function staleOutputs() {
    const stale = [];
    for (const sourceFile of listTypeScriptFiles(sourceRoot)) {
        const relative = path.relative(sourceRoot, sourceFile).replace(/\.ts$/, '.js');
        const outputFile = path.join(outRoot, relative);
        let outputStat;
        try {
            outputStat = fs.statSync(outputFile);
        } catch {
            stale.push({ source: relative, reason: 'missing' });
            continue;
        }
        const sourceStat = fs.statSync(sourceFile);
        if (outputStat.mtimeMs < sourceStat.mtimeMs) {
            stale.push({ source: relative, reason: 'stale' });
        }
    }
    return stale;
}

const stale = staleOutputs();
if (stale.length > 0) {
    console.error(`out/src is not fresh (${stale.length} file(s)):`);
    for (const entry of stale.slice(0, 5)) {
        console.error(`  ${entry.source} (${entry.reason})`);
    }
    console.error('run: npm run compile');
    process.exit(1);
}
console.log('out/src is fresh');
