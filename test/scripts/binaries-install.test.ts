import * as fs from 'fs';
import * as os from 'os';
import * as NodePath from 'path';

const { installBinaries } = require('../../../src/core/binaries_install');

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

function writeFile(path: string, content: string): void {
    fs.mkdirSync(NodePath.dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
}

function tree(root: string): string {
    const result: string[] = [];
    const visit = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = NodePath.join(dir, entry.name);
            if (entry.isDirectory()) {
                result.push(`d:${NodePath.relative(root, full).replace(/\\/g, '/')}`);
                visit(full);
            } else {
                result.push(`f:${NodePath.relative(root, full).replace(/\\/g, '/')}=${fs.readFileSync(full, 'utf8')}`);
            }
        }
    };
    visit(root);
    return result.sort().join('|');
}

function tempRoot(): string {
    return fs.mkdtempSync(NodePath.join(os.tmpdir(), 'binaries-install-test-'));
}

async function run(): Promise<void> {
    {
        const root = tempRoot();
        const target = NodePath.join(root, 'bin');
        writeFile(NodePath.join(target, 'old.exe'), 'old');
        writeFile(NodePath.join(target, 'VERSION'), '1.0.0');
        const result = await installBinaries(target, async (dir: string) => {
            writeFile(NodePath.join(dir, 'new.exe'), 'new');
            writeFile(NodePath.join(dir, 'VERSION'), '2.0.0');
        });
        assert(result.success, 'success: installBinaries returns success');
        assert(tree(target) === 'f:VERSION=2.0.0|f:new.exe=new', `success: new content replaces old (${tree(target)})`);
        assert(fs.readdirSync(root).filter(name => name.startsWith('.binaries-install-')).length === 0,
            'success: no staging directory remains');
    }

    {
        const root = tempRoot();
        const target = NodePath.join(root, 'bin');
        writeFile(NodePath.join(target, 'old.exe'), 'old');
        writeFile(NodePath.join(target, 'VERSION'), '1.0.0');
        const before = tree(target);
        const result = await installBinaries(target, async (dir: string) => {
            writeFile(NodePath.join(dir, 'partial.exe'), 'partial');
            throw new Error('extract failed');
        });
        assert(!result.success && result.message.includes('extract failed'),
            `extract failure: returns explicit failure (${result.message})`);
        assert(tree(target) === before, `extract failure: old directory and VERSION are byte-identical (${tree(target)})`);
        assert(fs.readdirSync(root).filter(name => name.startsWith('.binaries-install-')).length === 0,
            'extract failure: staging directory is cleaned');
    }

    {
        const root = tempRoot();
        const target = NodePath.join(root, 'bin');
        const result = await installBinaries(target, async (dir: string) => {
            writeFile(NodePath.join(dir, 'fresh.exe'), 'fresh');
        });
        assert(result.success && tree(target) === 'f:fresh.exe=fresh',
            `first install: creates target with new content (${tree(target)})`);
    }

    {
        const root = tempRoot();
        const target = NodePath.join(root, 'bin');
        writeFile(NodePath.join(target, 'old.exe'), 'old');
        writeFile(NodePath.join(target, 'VERSION'), '1.0.0');
        const before = tree(target);
        const result = await installBinaries(target, async (dir: string) => {
            writeFile(NodePath.join(dir, 'new.exe'), 'new');
        }, { rename: () => { throw new Error('rename failed'); } });
        assert(!result.success && result.message.includes('rename failed'),
            `rename failure: returns explicit failure (${result.message})`);
        assert(tree(target) === before, `rename failure: old directory restored (${tree(target)})`);
    }

    console.log('All binaries install tests passed.');
}

run().catch(error => {
    console.error('FAIL:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
