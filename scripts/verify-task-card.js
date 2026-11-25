const fs = require('fs');
const { execFileSync } = require('child_process');

const cardPath = process.argv[2];
if (!cardPath) {
    console.error('Usage: node scripts/verify-task-card.js <card.md>');
    process.exit(1);
}
if (!fs.existsSync(cardPath)) {
    console.error(`Card not found: ${cardPath}`);
    process.exit(1);
}

const lines = fs.readFileSync(cardPath, 'utf8').split('\n');
const failures = [];
let pathCount = 0;
let baseline = null;

function gitOk(args) {
    try {
        execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
    } catch {
        return false;
    }
}

lines.forEach((line, index) => {
    const lineNo = index + 1;
    const isNew = line.includes('（新）');
    const pathMatches = [...line.matchAll(/`([^`]+)`/g)].map(match => match[1])
        .filter(candidate => /^(src|test|scripts|docs|\.github|\.tasks|res)\/[^`]*$/.test(candidate)
            || candidate === 'package.json' || candidate === '.gitignore');
    for (const candidate of pathMatches) {
        pathCount++;
        if (isNew) {
            continue;
        }
        if (!gitOk(['ls-files', '--error-unmatch', candidate])) {
            failures.push(`${cardPath}:${lineNo}  path not tracked: ${candidate}`);
        }
    }
    const baselineMatch = line.match(/基线[：:]`([0-9a-f]{7,40})`/);
    if (baselineMatch) {
        baseline = baselineMatch[1];
        if (!gitOk(['cat-file', '-e', `${baseline}^{commit}`])) {
            failures.push(`${cardPath}:${lineNo}  baseline is not a commit: ${baseline}`);
        } else if (!gitOk(['merge-base', '--is-ancestor', baseline, 'HEAD'])) {
            failures.push(`${cardPath}:${lineNo}  baseline is not an ancestor of HEAD: ${baseline}`);
        }
    }
});

if (pathCount === 0 && baseline === null) {
    console.error(`${cardPath}: no repository paths or baseline found in card`);
    process.exit(1);
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(failure);
    }
    process.exit(1);
}

console.log(`task card verified: ${pathCount} paths, base ${baseline ?? 'none'}`);
