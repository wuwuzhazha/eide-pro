import * as NodePath from 'path';

const {
    decideInstallPrompt,
    releaseTarballUrl,
    installCommand,
    installHeadlessTooling
} = require('../../../src/mcp/tooling_install') as any;

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

function baseOptions(overrides: any = {}): any {
    return {
        version: '4.3.0',
        repositoryUrl: 'https://github.com/o/r',
        workDir: NodePath.join(process.cwd(), 'tmp-tooling-install'),
        download: async () => undefined,
        run: async () => ({ code: 0, stdout: '', stderr: '' }),
        ...overrides
    };
}

async function run(): Promise<void> {
    assert(
        JSON.stringify(decideInstallPrompt({ cliVersion: '4.3.0', nodeVersion: 'v20', dotnetMajor: 8 }, '4.3.0', 'win32'))
            === JSON.stringify({ action: 'skip', reason: 'installed' }),
        'decision: same version is installed'
    );
    const oldVersion = decideInstallPrompt({ cliVersion: '4.2.0', nodeVersion: 'v20', dotnetMajor: 8 }, '4.3.0', 'win32');
    assert(
        oldVersion.action === 'prompt' && JSON.stringify(oldVersion.missingPrereqs) === '[]',
        'decision: old version still prompts without missing prerequisites'
    );
    const noNode = decideInstallPrompt({ dotnetMajor: 8 }, '4.3.0', 'linux');
    assert(
        noNode.action === 'prompt' && noNode.missingPrereqs.includes('node') && !noNode.missingPrereqs.includes('dotnet'),
        'decision: missing node is reported'
    );
    const oldDotnet = decideInstallPrompt({ nodeVersion: 'v20', dotnetMajor: 5 }, '4.3.0', 'darwin');
    assert(
        oldDotnet.action === 'prompt' && oldDotnet.missingPrereqs.includes('dotnet') && !oldDotnet.missingPrereqs.includes('node'),
        'decision: dotnet 5 is reported'
    );
    assert(
        JSON.stringify(decideInstallPrompt({ dismissedVersion: '4.3.0', nodeVersion: 'v20', dotnetMajor: 8 }, '4.3.0', 'win32'))
            === JSON.stringify({ action: 'skip', reason: 'dismissed' }),
        'decision: same extension version is dismissed'
    );
    const upgraded = decideInstallPrompt({ dismissedVersion: '4.2.0', nodeVersion: 'v20', dotnetMajor: 8 }, '4.3.0', 'win32');
    assert(upgraded.action === 'prompt', 'decision: upgrade prompts again');
    assert(
        JSON.stringify(decideInstallPrompt({ nodeVersion: 'v20', dotnetMajor: 8 }, '4.3.0', 'freebsd'))
            === JSON.stringify({ action: 'skip', reason: 'unsupported' }),
        'decision: unknown platform is unsupported'
    );

    assert(
        releaseTarballUrl('4.3.0', 'https://github.com/o/r')
            === 'https://github.com/o/r/releases/download/v4.3.0/eide-pro-headless-4.3.0.tgz',
        'release: tarball URL uses v-prefixed tag'
    );
    const winCommand = installCommand('C:/tmp/pkg.tgz', 'win32');
    assert(
        winCommand.file === 'npm.cmd' && JSON.stringify(winCommand.args) === JSON.stringify(['install', '-g', 'C:/tmp/pkg.tgz']),
        'install command: Windows uses npm.cmd'
    );
    const unixCommand = installCommand('/tmp/pkg.tgz', 'linux');
    assert(unixCommand.file === 'npm', 'install command: Linux uses npm');

    let downloadUrl = '';
    let downloadPath = '';
    let successCalls = 0;
    const success = await installHeadlessTooling(baseOptions({
        download: async (url: string, dest: string) => {
            downloadUrl = url;
            downloadPath = dest;
        },
        run: async (file: string, args: string[]) => {
            successCalls += 1;
            if (successCalls === 1) {
                assert(file === installCommand('', process.platform).file && args[0] === 'install', 'install: npm install called first');
                return { code: 0, stdout: '', stderr: '' };
            }
            assert(file === 'eide-cli' && args[0] === '--version', 'install: verify called second');
            return { code: 0, stdout: '4.3.0', stderr: '' };
        }
    }));
    assert(success.ok, 'install: success path returns ok');
    assert(downloadUrl === releaseTarballUrl('4.3.0', 'https://github.com/o/r'), 'install: downloads the release tarball');
    assert(downloadPath.endsWith('eide-pro-headless-4.3.0.tgz'), 'install: tarball path is derived from version');
    assert(successCalls === 2, 'install: runs npm install and verification exactly once');

    const reportedVersion = await installHeadlessTooling(baseOptions({
        run: async (_file: string, args: string[]) => args[0] === 'install'
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 0, stdout: '4.3.0\n', stderr: '' }
    }));
    assert(reportedVersion.ok,
        `install: verification accepts the expected version (${JSON.stringify(reportedVersion)})`);

    const shadowedVersion = await installHeadlessTooling(baseOptions({
        run: async (_file: string, args: string[]) => args[0] === 'install'
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 0, stdout: '1.0.0\n', stderr: '' }
    }));
    assert(!shadowedVersion.ok
        && shadowedVersion.message.includes('4.3.0')
        && shadowedVersion.message.includes('1.0.0')
        && shadowedVersion.message.includes('PATH'),
        `install: a shadowing eide-cli fails verification with both versions (${JSON.stringify(shadowedVersion)})`);

    let downloadFailureRuns = 0;
    const downloadFailure = await installHeadlessTooling(baseOptions({
        download: async () => {
            throw new Error('network down');
        },
        run: async () => {
            downloadFailureRuns += 1;
            return { code: 0, stdout: '', stderr: '' };
        }
    }));
    assert(
        !downloadFailure.ok && downloadFailure.message.includes('download') && downloadFailure.message.includes('network down'),
        'install: download failure is identifiable and preserves the original error'
    );
    assert(downloadFailureRuns === 0, 'install: download failure stops before npm install');

    let installFailureRuns = 0;
    const installFailure = await installHeadlessTooling(baseOptions({
        run: async (_file: string, args: string[]) => {
            installFailureRuns += 1;
            assert(args[0] === 'install', 'install failure: npm install called');
            return { code: 1, stdout: '', stderr: 'EACCES' };
        }
    }));
    assert(
        !installFailure.ok && installFailure.message.includes('npm install') && installFailure.message.includes('EACCES'),
        'install: npm install failure is identifiable and preserves stderr'
    );
    assert(installFailureRuns === 1, 'install: npm install failure stops before verification');

    let verifyRuns = 0;
    const verifyFailure = await installHeadlessTooling(baseOptions({
        run: async (_file: string, args: string[]) => {
            verifyRuns += 1;
            if (args[0] === 'install') {
                return { code: 0, stdout: '', stderr: '' };
            }
            return { code: 1, stdout: '', stderr: 'command not found' };
        }
    }));
    assert(
        !verifyFailure.ok && verifyFailure.message.includes('verify') && verifyFailure.message.includes('command not found'),
        'install: verify failure is identifiable and preserves stderr'
    );
    assert(verifyRuns === 2, 'install: verification runs after npm install');

    console.log('All tooling install tests passed.');
}

run().catch(error => {
    console.error('FAIL:', error);
    process.exit(1);
});
