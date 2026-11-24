import * as ProjectLock from '../../src/core/project_lock';

const fs = require('fs');
const os = require('os');
const NodePath = require('path');
const { spawn } = require('child_process');

function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

const root = NodePath.join(os.tmpdir(), `eide-project-lock-${process.pid}-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });

function lockPath(name: string): string {
    return NodePath.join(root, `${name}.lock`);
}

interface ChildLockResult {
    verdict: Promise<string>;
    finish(): void;
    exited: Promise<void>;
}

function startChildLock(path: string): ChildLockResult {
    const modulePath = NodePath.join(__dirname, '..', '..', 'src', 'core', 'project_lock.js');
    const script = `
        const ProjectLock = require(${JSON.stringify(modulePath)});
        const fd = ProjectLock.acquireProjectLock(${JSON.stringify(path)});
        if (fd === undefined) {
            process.stdout.write('REJECTED\\n');
            process.exit(0);
        }
        process.stdout.write('LOCKED\\n');
        process.stdin.resume();
        process.stdin.on('end', () => process.exit(0));
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let verdictResolved = false;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const verdict = new Promise<string>((resolve) => {
        let buffered = '';
        child.stdout.on('data', (chunk: Buffer) => {
            buffered += chunk.toString();
            const idx = buffered.indexOf('\n');
            if (idx !== -1 && !verdictResolved) {
                verdictResolved = true;
                resolve(buffered.slice(0, idx));
            }
        });
        child.on('close', () => {
            if (!verdictResolved) {
                verdictResolved = true;
                resolve(`EXITED(${stderr.trim()})`);
            }
        });
    });
    const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
    return {
        verdict,
        finish: () => child.stdin.end(),
        exited
    };
}

async function run(): Promise<void> {
    {
        const path = lockPath('live-owner');
        fs.writeFileSync(path, String(process.pid));
        assert(ProjectLock.acquireProjectLock(path) === undefined,
            'lock: returns undefined for a lock held by a live process');
    }

    {
        const path = lockPath('broken-owner');
        fs.writeFileSync(path, 'not-a-pid');
        let message = '';
        try {
            ProjectLock.acquireProjectLock(path);
        } catch (error) {
            message = error.message;
        }
        assert(message.includes(path), 'lock: throws when the holder pid cannot be read');
    }

    {
        const path = lockPath('dead-owner');
        fs.writeFileSync(path, '999999');
        const fd = ProjectLock.acquireProjectLock(path);
        assert(typeof fd === 'number', 'lock: steals a lock from a dead process');
        assert(fs.readFileSync(path, 'utf8') === String(process.pid),
            'lock: writes own pid into the lock file');
        assert(ProjectLock.releaseProjectLock(fd) === true, 'unlock: releases by fd');
        assert(!fs.existsSync(path), 'unlock: removes the lock file it owns');
    }

    {
        const path = lockPath('race');
        const children = [startChildLock(path), startChildLock(path)];
        const verdicts = await Promise.all(children.map(child => child.verdict));
        children.forEach(child => child.finish());
        await Promise.all(children.map(child => child.exited));
        assert(verdicts.filter(verdict => verdict === 'LOCKED').length === 1,
            `lock: exactly one of two concurrent processes wins (${verdicts.join(',')})`);
    }
}

run()
    .then(() => {
        console.log('All project lock tests passed.');
    })
    .catch(error => {
        console.error(error);
        process.exit(1);
    })
    .finally(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
export {};
