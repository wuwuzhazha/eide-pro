import { EventEmitter } from 'events';

const {
    commandProbeInvocation,
    probeCommand,
    probeProcessOutput
} = require('../../../src/core/command_probe');

function check(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

async function run(): Promise<void> {
    const win = commandProbeInvocation('eide-cli', ['--version'], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
    check(win.file === 'C:\\Windows\\System32\\cmd.exe'
        && JSON.stringify(win.args) === JSON.stringify(['/d', '/s', '/c', 'eide-cli', '--version']),
    `win32 uses ComSpec with /d /s /c (${JSON.stringify(win)})`);

    const linux = commandProbeInvocation('node', ['--version'], 'linux');
    check(linux.file === 'node' && JSON.stringify(linux.args) === JSON.stringify(['--version']),
        `linux calls the file directly (${JSON.stringify(linux)})`);

    const missing = await probeCommand('missing-tool', [], {
        platform: 'linux',
        timeoutMs: 1000,
        run: () => {
            const child: any = new EventEmitter();
            setImmediate(() => {
                const error: any = new Error('spawn missing-tool ENOENT');
                error.code = 'ENOENT';
                child.emit('error', error);
            });
            return child;
        }
    });
    check(missing.status === 'missing', `ENOENT maps to missing (${JSON.stringify(missing)})`);

    const invalidCommand = await probeCommand('eide-cli.cmd', ['--version'], {
        platform: 'linux',
        timeoutMs: 1000,
        run: () => {
            throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
        }
    });
    check(invalidCommand.status === 'failed' && invalidCommand.message.includes('EINVAL'),
        `EINVAL maps to failed (${JSON.stringify(invalidCommand)})`);

    const badOutput = await probeCommand('node', ['--version'], {
        platform: 'linux',
        timeoutMs: 1000,
        run: () => {
            const child: any = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => {
                child.stdout.emit('data', 'v4.3.0\n');
                child.emit('close', 0);
            });
            return child;
        }
    });
    check(badOutput.status === 'failed' && badOutput.message.includes('Invalid version output'),
        `v-prefixed output maps to failed (${JSON.stringify(badOutput)})`);

    const windowsMissing = await probeCommand('missing-tool', [], {
        platform: 'win32',
        timeoutMs: 1000,
        run: () => {
            const child: any = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => {
                child.stderr.emit('data', "'missing-tool' is not recognized as an internal or external command,\r\n");
                child.emit('close', 1);
            });
            return child;
        }
    });
    check(windowsMissing.status === 'missing', `ComSpec command-not-found maps to missing (${JSON.stringify(windowsMissing)})`);

    const verified = probeProcessOutput({ code: 0, stdout: '4.3.0\n', stderr: '' });
    check(verified.status === 'ok' && verified.value === '4.3.0',
        `verification accepts a plain x.y.z version (${JSON.stringify(verified)})`);

    const failedExit = probeProcessOutput({ code: 1, stdout: '', stderr: 'boom' });
    check(failedExit.status === 'failed' && failedExit.message.includes('boom'),
        `verification preserves a non-zero exit (${JSON.stringify(failedExit)})`);

    console.log('All command probe tests passed.');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
