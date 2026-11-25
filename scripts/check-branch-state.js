const { execFileSync } = require('child_process');

const remote = process.argv[2] ?? 'origin';
const branch = process.argv[3] ?? 'dev';

function gitOut(args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

try {
    execFileSync('git', ['fetch', remote, branch, '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
    console.error(`git fetch ${remote} ${branch} failed: ${error.message}`);
    process.exit(1);
}

const current = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
const behind = Number(gitOut(['rev-list', '--count', `HEAD..${remote}/${branch}`]));
const ahead = Number(gitOut(['rev-list', '--count', `${remote}/${branch}..HEAD`]));
const dirty = gitOut(['status', '--porcelain']).split('\n').filter(line => line.length > 0);

console.log(`branch: ${current}`);
console.log(`behind ${remote}/${branch}: ${behind}`);
if (ahead > 0) {
    console.log(`ahead of ${remote}/${branch}: ${ahead}`);
}
if (dirty.length > 0) {
    console.log('uncommitted changes:');
    for (const line of dirty) {
        console.log(`  ${line}`);
    }
}

const state = behind > 0 ? 'behind' : dirty.length > 0 ? 'dirty' : ahead > 0 ? 'ahead' : 'clean';
console.log(`branch state: ${state}`);
process.exit(behind > 0 || dirty.length > 0 ? 1 : 0);
