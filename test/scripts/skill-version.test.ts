const fs = require('fs');
const NodePath = require('path');

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

const repoRoot = NodePath.resolve(__dirname, '../../../../');
const skillPath = NodePath.join(repoRoot, 'docs', 'skills', 'eide-mcp-tools', 'SKILL.md');
const packagePath = NodePath.join(repoRoot, 'package.json');
const implPath = NodePath.join(repoRoot, 'src', 'mcp', 'mcp_impl.ts');

const skill = fs.readFileSync(skillPath, 'utf8');
const packageVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version as string;
const implementation = fs.readFileSync(implPath, 'utf8');

const messageMatch = /message:\s*'([^']*stdio transport[^']*)'/.exec(implementation);
assert(messageMatch !== null, 'UnsupportedTransport message is present in mcp_impl.ts');

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
assert(frontmatter !== null, 'skill frontmatter is present');

const versionLine = /^version:\s*(\S+)\s*$/m.exec(frontmatter![1]);
assert(versionLine !== null, 'skill frontmatter declares a version');
assert(versionLine![1] === packageVersion,
    `skill version matches package.json (skill=${versionLine![1]}, package=${packageVersion})`);

assert(skill.includes(messageMatch![1]),
    'SKILL.md quotes the UnsupportedTransport message verbatim from mcp_impl.ts');

console.log('All skill version tests passed.');

export {};
