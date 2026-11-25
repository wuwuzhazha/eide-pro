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
const headerLine = lines.findIndex(line => line.trim() === '## 派单校验');
if (headerLine === -1) {
    console.error(`${cardPath}:missing "## 派单校验" block`);
    process.exit(1);
}

const fenceStart = lines.findIndex((line, i) => i > headerLine && line.trim().startsWith('```'));
const fenceEnd = lines.findIndex((line, i) => i > fenceStart && line.trim() === '```');
if (fenceStart === -1 || fenceEnd === -1) {
    console.error(`${cardPath}:${headerLine + 1}  missing fenced block after "## 派单校验"`);
    process.exit(1);
}

function gitOk(args) {
    try {
        execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
    } catch {
        return false;
    }
}

const failures = [];
let pathCount = 0;
let baseline = null;

for (let i = fenceStart + 1; i < fenceEnd; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (line === '') {
        continue;
    }
    const pathMatch = line.match(/^path: (\S+?)(?: \((新|new)\))?$/);
    const baseMatch = line.match(/^base: ([0-9a-f]{7,40})$/);
    if (baseMatch) {
        baseline = baseMatch[1];
        if (!gitOk(['cat-file', '-e', `${baseline}^{commit}`])) {
            failures.push(`${cardPath}:${lineNo}  baseline is not a commit: ${baseline}`);
        } else if (!gitOk(['merge-base', '--is-ancestor', baseline, 'HEAD'])) {
            failures.push(`${cardPath}:${lineNo}  baseline is not an ancestor of HEAD: ${baseline}`);
        }
    } else if (pathMatch) {
        pathCount++;
        const candidate = pathMatch[1];
        if (!pathMatch[2] && !gitOk(['ls-files', '--error-unmatch', candidate])) {
            failures.push(`${cardPath}:${lineNo}  path not tracked: ${candidate}`);
        }
    } else {
        failures.push(`${cardPath}:${lineNo}  unrecognized line in verification block: ${line}`);
    }
}

if (baseline === null) {
    failures.push(`${cardPath}:${headerLine + 1}  verification block has no base: line`);
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(failure);
    }
    process.exit(1);
}

console.log(`task card verified: ${pathCount} paths, base ${baseline}`);
