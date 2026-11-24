const { NodeProcessRunner, ProcessTimeoutError } = require('../../../src/core/process_runner') as any;
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const { spawnSync } = require('child_process') as typeof import('child_process');

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

async function main(): Promise<void> {
    const runner = new NodeProcessRunner();

    const ok = await runner.run(process.execPath, [
        '-e',
        'console.log("out-line"); console.error("err-line"); process.exit(3);'
    ]);
    assert(ok.code === 3, 'process: exit code is preserved');
    assert(ok.stdout.includes('out-line'), 'process: captures stdout');
    assert(ok.stderr.includes('err-line'), 'process: captures stderr');

    const tempDir = require('os').tmpdir();
    const cwdResult = await runner.run(process.execPath, [
        '-e',
        'console.log(process.cwd()); console.log(process.env.EIDE_TEST_ENV);'
    ], {
        cwd: tempDir,
        env: { ...process.env, EIDE_TEST_ENV: 'env-value' }
    });
    assert(cwdResult.stdout.toLowerCase().includes(tempDir.toLowerCase()),
        'process: applies cwd');
    assert(cwdResult.stdout.includes('env-value'), 'process: applies env');

    let timedOut = false;
    try {
        await runner.run(process.execPath, ['-e', 'setTimeout(() => {}, 5000);'], {
            timeoutMs: 150
        });
    } catch (error) {
        timedOut = error instanceof ProcessTimeoutError;
    }
    assert(timedOut, 'process: timeout rejects with ProcessTimeoutError');

    const grandchildPidFile = path.join(os.tmpdir(), `eide-process-tree-${process.pid}.pid`);
    fs.rmSync(grandchildPidFile, { force: true });
    let treeTimedOut = false;
    try {
        await runner.run(process.execPath, [
            '-e',
            `const child = require('child_process').spawn(process.execPath, ['-e', ` +
                `'require(\"fs\").writeFileSync(process.argv[1], String(process.pid)); ` +
                `setTimeout(() => {}, 60000)', ${JSON.stringify(grandchildPidFile)}], ` +
            `{ stdio: 'ignore' }); ` +
            `setTimeout(() => {}, 60000);`
        ], { timeoutMs: 1000 });
    } catch (error) {
        treeTimedOut = error instanceof ProcessTimeoutError;
    }
    assert(treeTimedOut, 'process: child tree timeout rejects with ProcessTimeoutError');

    let grandchildPid = '';
    for (let attempt = 0; attempt < 25 && !grandchildPid; attempt++) {
        if (fs.existsSync(grandchildPidFile)) {
            grandchildPid = fs.readFileSync(grandchildPidFile, 'utf8').trim();
        }
        if (!grandchildPid) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    assert(grandchildPid.length > 0, 'process: grandchild pid was recorded');
    const filter = process.platform === 'win32'
        ? `PID eq ${grandchildPid}`
        : `-p ${grandchildPid}`;
    let stillRunning = true;
    for (let attempt = 0; attempt < 25 && stillRunning; attempt++) {
        const tasklist = process.platform === 'win32'
            ? spawnSync('tasklist', ['/FI', filter], { encoding: 'utf8' })
            : spawnSync('ps', ['-p', grandchildPid], { encoding: 'utf8' });
        stillRunning = tasklist.stdout.split(/\r?\n/).some(line =>
            line.trim().split(/\s+/)[1] === grandchildPid);
        if (stillRunning) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    assert(!stillRunning,
        'process: timeout kills the grandchild process');
    fs.rmSync(grandchildPidFile, { force: true });

    let invalidTimeout = false;
    try {
        await runner.run(process.execPath, ['-e', 'console.log("x")'], { timeoutMs: 0 });
    } catch {
        invalidTimeout = true;
    }
    assert(invalidTimeout, 'process: invalid timeout is rejected');

    console.log('All process runner tests passed.');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

export {};
