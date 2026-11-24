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

function caseDir(name: string): string {
    const dir = NodePath.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function lockPath(dir: string): string {
    return NodePath.join(dir, 'project.lock');
}

function removeDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) {
        const remaining = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        console.error(`CLEANUP FAILED: ${dir}`);
        console.error(`remaining entries: ${JSON.stringify(remaining)}`);
        console.error(error);
        process.exitCode = 1;
    }
}

interface ChildLockResult {
    verdict: Promise<string>;
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    detail(): string;
    stop(): void;
}

function startChildLock(path: string): ChildLockResult {
    const modulePath = NodePath.join(__dirname, '..', '..', 'src', 'core', 'project_lock.js');
    const script = `
        try {
            const ProjectLock = require(${JSON.stringify(modulePath)});
            const fd = ProjectLock.acquireProjectLock(${JSON.stringify(path)});
            if (fd === undefined) {
                process.stdout.write('REJECTED\\n');
                process.exit(0);
            }
            process.stdout.write('LOCKED\\n');
            process.stdin.resume();
        } catch (error) {
            process.stderr.write(String((error && error.stack) || error));
            process.exit(2);
        }
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let verdictResolved = false;
    const settleVerdict = (value: string, resolve: (value: string) => void) => {
        if (verdictResolved) {
            return;
        }
        verdictResolved = true;
        resolve(value);
    };
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const verdict = new Promise<string>((resolve) => {
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            const idx = stdout.indexOf('\n');
            if (idx !== -1) {
                settleVerdict(stdout.slice(0, idx).trim() || 'EXITED', resolve);
            }
        });
        child.on('close', () => {
            settleVerdict(stdout.split('\n')[0].trim() || 'EXITED', resolve);
        });
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
            exit = { code, signal };
            resolve(exit);
        });
    });
    return {
        verdict,
        closed,
        detail: () => `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)} exit=${JSON.stringify(exit)}`,
        stop: () => child.kill()
    };
}

async function runChildPair(dir: string, message: string): Promise<void> {
    const path = lockPath(dir);
    const children = [startChildLock(path), startChildLock(path)];
    const verdicts = Promise.all(children.map(child => child.verdict));
    const closes = Promise.all(children.map(child => child.closed));
    const resolvedVerdicts = await verdicts;
    children.forEach((child, index) => {
        if (resolvedVerdicts[index] === 'LOCKED') {
            child.stop();
        }
    });
    const exits = await closes;
    const detail = children.map((child, index) => `#${index} ${child.detail()}`).join(' | ');
    removeDir(dir);
    assert(exits.every(item => item.code !== 2),
        `${message}: no child crashed ${detail}`);
    assert(resolvedVerdicts.filter(verdict => verdict === 'LOCKED').length === 1,
        `${message} (${resolvedVerdicts.join(',')}) ${detail}`);
}

async function run(): Promise<void> {
    {
        const dir = caseDir('live-owner');
        const path = lockPath(dir);
        fs.writeFileSync(path, String(process.pid));
        assert(ProjectLock.acquireProjectLock(path) === undefined,
            'lock: returns undefined for a lock held by a live process');
        removeDir(dir);
    }

    {
        const dir = caseDir('empty-owner');
        const path = lockPath(dir);
        fs.writeFileSync(path, '');
        const fd = ProjectLock.acquireProjectLock(path);
        assert(typeof fd === 'number', 'lock: recovers a lock file with no owner pid');
        assert(fs.readFileSync(path, 'utf8') === String(process.pid),
            'lock: rewrites own pid into the recovered lock file');
        assert(ProjectLock.releaseProjectLock(fd) === true, 'unlock: releases the recovered lock');
        removeDir(dir);
    }

    {
        const dir = caseDir('dead-owner');
        const path = lockPath(dir);
        fs.writeFileSync(path, '999999');
        const fd = ProjectLock.acquireProjectLock(path);
        assert(typeof fd === 'number', 'lock: steals a lock from a dead process');
        assert(fs.readFileSync(path, 'utf8') === String(process.pid),
            'lock: writes own pid into the lock file');
        assert(ProjectLock.releaseProjectLock(fd) === true, 'unlock: releases by fd');
        assert(!fs.existsSync(path), 'unlock: removes the lock file it owns');
        assert(fs.readdirSync(dir).every((name: string) => !name.endsWith('.tmp')),
            'lock: leaves no temporary file behind');
        removeDir(dir);
    }

    await runChildPair(caseDir('race'),
        'lock: exactly one of two concurrent processes wins');

    const staleDir = caseDir('race-stale');
    fs.writeFileSync(lockPath(staleDir), '');
    await runChildPair(staleDir,
        'lock: exactly one of two concurrent processes reclaims a stale lock');

    {
        const dir = caseDir('reclaim-raced');
        const path = lockPath(dir);
        fs.writeFileSync(path, '999999');
        const originalRename = fs.renameSync;
        fs.renameSync = () => {
            const error: NodeJS.ErrnoException = new Error('ENOENT: reclaim raced');
            error.code = 'ENOENT';
            throw error;
        };
        let result: number | undefined | string = 'threw';
        try {
            result = ProjectLock.acquireProjectLock(path);
        } catch (error) {
            result = 'threw';
        }
        fs.renameSync = originalRename;
        assert(result === undefined,
            'lock: returns undefined when another process reclaims the stale lock first');
        assert(fs.readFileSync(path, 'utf8') === '999999',
            'lock: leaves the lock file untouched when the reclaim rename loses');
        removeDir(dir);
    }

    {
        const dir = caseDir('rename-denied');
        const path = lockPath(dir);
        fs.writeFileSync(path, '999999');
        const originalRename = fs.renameSync;
        fs.renameSync = () => {
            const error: NodeJS.ErrnoException = new Error('EPERM: operation not permitted');
            error.code = 'EPERM';
            throw error;
        };
        let message = '';
        try {
            ProjectLock.acquireProjectLock(path);
        } catch (error) {
            message = error.message;
        }
        fs.renameSync = originalRename;
        assert(message.includes(path),
            'lock: rethrows a rename failure when the lock file is still there');
        removeDir(dir);
    }

    {
        const dir = caseDir('rename-denied-gone');
        const path = lockPath(dir);
        fs.writeFileSync(path, '999999');
        const originalRename = fs.renameSync;
        fs.renameSync = (from: string) => {
            fs.rmSync(from, { force: true });
            const error: NodeJS.ErrnoException = new Error('EPERM: operation not permitted');
            error.code = 'EPERM';
            throw error;
        };
        let result: number | undefined | string = 'threw';
        try {
            result = ProjectLock.acquireProjectLock(path);
        } catch (error) {
            result = 'threw';
        }
        fs.renameSync = originalRename;
        assert(result === undefined,
            'lock: returns undefined when the rename failure coincides with a vanished lock file');
        removeDir(dir);
    }

    {
        const dir = caseDir('retry-raced');
        const path = lockPath(dir);
        fs.writeFileSync(path, '999999');
        const originalLink = fs.linkSync;
        let linkCalls = 0;
        fs.linkSync = (existingPath: string, newPath: string) => {
            linkCalls++;
            if (linkCalls === 2) {
                const error: NodeJS.ErrnoException = new Error('EEXIST: retry raced');
                error.code = 'EEXIST';
                throw error;
            }
            return originalLink(existingPath, newPath);
        };
        let result: number | undefined | string = 'threw';
        try {
            result = ProjectLock.acquireProjectLock(path);
        } catch (error) {
            result = 'threw';
        }
        fs.linkSync = originalLink;
        assert(result === undefined,
            'lock: returns undefined when the retry loses to another process');
        assert(fs.readdirSync(dir).every((name: string) => !name.includes('.reclaim.') && !name.endsWith('.tmp')),
            'lock: leaves no reclaim or temporary file behind after a lost retry');
        removeDir(dir);
    }

    {
        const dir = caseDir('restore-taken');
        const path = lockPath(dir);
        fs.writeFileSync(path, '999999');
        const originalRename = fs.renameSync;
        fs.renameSync = (from: string, to: string) => {
            originalRename(from, to);
            fs.writeFileSync(to, String(process.pid));
            fs.writeFileSync(from, 'newer-lock');
        };
        let result: number | undefined | string = 'threw';
        try {
            result = ProjectLock.acquireProjectLock(path);
        } catch (error) {
            result = 'threw';
        }
        fs.renameSync = originalRename;
        assert(result === undefined,
            'lock: returns undefined when the restore target is already taken');
        assert(fs.readFileSync(path, 'utf8') === 'newer-lock',
            'lock: does not overwrite the newer lock on restore');
        assert(fs.readdirSync(dir).every((name: string) => !name.includes('.reclaim.')),
            'lock: leaves no reclaim file behind after a lost restore');
        removeDir(dir);
    }
}

run()
    .then(() => {
        console.log('All project lock tests passed.');
    })
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        removeDir(root);
    });
export {};
