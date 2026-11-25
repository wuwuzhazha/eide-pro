const NodePath = require('path');
const fs = require('fs');

require('../../../src/headless/vscode').installVscodeShim();

const shim = require('../../../src/headless/vscode_shim').default;
if (shim.TerminalLink === undefined) {
    shim.TerminalLink = class { constructor() { } };
}

const {
    maybePromptToolingInstall,
    toolingPromptMessage,
    toolingRepositoryUrl,
    toolingInstallFailureMessage,
    downloadToolingPackageWithRetry
} = require('../../../src/extension');

const failures: string[] = [];

function check(cond: boolean, msg: string): void {
    if (cond) {
        console.log('OK:', msg);
    } else {
        console.error('FAIL:', msg);
        failures.push(msg);
    }
}

function deps(overrides: any): any {
    const counters = { popups: 0, cliProbes: 0, nodeProbes: 0, dotnetProbes: 0, installs: 0, dismissed: [] as string[] };
    const base = {
        extensionVersion: '4.3.0',
        platform: 'linux',
        promptEnabled: true,
        dismissedVersion: undefined,
        probeCliVersion: async () => { counters.cliProbes += 1; return undefined; },
        probeNodeVersion: async () => { counters.nodeProbes += 1; return 'v20.0.0'; },
        probeDotnetMajor: () => { counters.dotnetProbes += 1; return 8; },
        showInformationMessage: async (_message: string, ...items: string[]) => {
            counters.popups += 1;
            return undefined;
        },
        rememberDismissed: async (version: string) => { counters.dismissed.push(version); },
        install: async () => { counters.installs += 1; }
    };
    return { deps: { ...base, ...overrides(counters) }, counters };
}

async function run(): Promise<void> {
    const disabled = deps((c: any) => ({ promptEnabled: false, showInformationMessage: async () => { c.popups += 1; return undefined; } }));
    await maybePromptToolingInstall(disabled.deps);
    check(disabled.counters.popups === 0, `disabled setting shows no prompt (popups=${disabled.counters.popups})`);
    check(disabled.counters.cliProbes === 0 && disabled.counters.nodeProbes === 0 && disabled.counters.dotnetProbes === 0,
        `disabled setting probes nothing (cli=${disabled.counters.cliProbes}, node=${disabled.counters.nodeProbes}, dotnet=${disabled.counters.dotnetProbes})`);

    const installed = deps((c: any) => ({ probeCliVersion: async () => { c.cliProbes += 1; return '4.3.0'; } }));
    await maybePromptToolingInstall(installed.deps);
    check(installed.counters.popups === 0, `same version already installed shows no prompt (popups=${installed.counters.popups})`);

    let promptedMessage = '';
    const dismissedFirst = deps((c: any) => ({
        showInformationMessage: async (message: string, ...items: string[]) => {
            c.popups += 1;
            promptedMessage = message;
            return items[2];
        }
    }));
    await maybePromptToolingInstall(dismissedFirst.deps);
    check(dismissedFirst.counters.popups === 1, `missing cli prompts once (popups=${dismissedFirst.counters.popups})`);
    check(dismissedFirst.counters.dismissed.length === 1 && dismissedFirst.counters.dismissed[0] === '4.3.0',
        `don't ask again stores the current version (${JSON.stringify(dismissedFirst.counters.dismissed)})`);
    check(promptedMessage.includes('eide-cli') && promptedMessage.includes('eide-mcp')
        && !promptedMessage.includes('Missing:'),
        `prompt explains the separate package without missing prereqs (${promptedMessage})`);

    const dismissedAgain = deps((c: any) => ({ dismissedVersion: '4.3.0', showInformationMessage: async () => { c.popups += 1; return undefined; } }));
    await maybePromptToolingInstall(dismissedAgain.deps);
    check(dismissedAgain.counters.popups === 0, `dismissed version shows no prompt on next activation (popups=${dismissedAgain.counters.popups})`);

    const upgraded = deps((c: any) => ({ dismissedVersion: '4.2.0', showInformationMessage: async () => { c.popups += 1; return undefined; } }));
    await maybePromptToolingInstall(upgraded.deps);
    check(upgraded.counters.popups === 1, `a new extension version prompts again (popups=${upgraded.counters.popups})`);

    const missingPrereqs = deps((c: any) => ({
        probeNodeVersion: async () => { c.nodeProbes += 1; return undefined; },
        probeDotnetMajor: () => { c.dotnetProbes += 1; return undefined; },
        showInformationMessage: async () => { c.popups += 1; return undefined; }
    }));
    await maybePromptToolingInstall(missingPrereqs.deps);
    check(missingPrereqs.counters.popups === 1, 'missing prereqs still prompt once');

    const installSelected = deps((c: any) => ({
        showInformationMessage: async (_message: string, ...items: string[]) => {
            c.popups += 1;
            return items[0];
        }
    }));
    await maybePromptToolingInstall(installSelected.deps);
    check(installSelected.counters.installs === 1 && installSelected.counters.dismissed.length === 0,
        `install runs only when the install button is picked (installs=${installSelected.counters.installs})`);

    const message = toolingPromptMessage(['node', 'dotnet']);
    check(message.includes('Missing: node, dotnet'), `prompt names the missing prereqs (${message})`);

    const packageJSON = JSON.parse(fs.readFileSync(
        NodePath.join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'));
    const failure = toolingInstallFailureMessage('npm install failed: code 1; stderr: EACCES', '4.3.0',
        toolingRepositoryUrl(packageJSON.repository.url));
    check(failure.includes('npm install -g https://github.com/wuwuzhazha/eide-pro/releases/download/v4.3.0/eide-pro-headless-4.3.0.tgz'),
        `failure message carries a copyable fallback command (${failure})`);
    check(failure.includes('npm install failed'), 'failure message names the failed step');

    const tlsMessage = 'Client network socket disconnected before secure TLS connection was established';
    let transientDownloads = 0;
    const transientMessages: string[] = [];
    await downloadToolingPackageWithRetry(async (_url: string, _dest: string) => {
        transientDownloads += 1;
        if (transientDownloads < 3) {
            throw new Error(tlsMessage);
        }
    }, 'https://example.invalid/pkg.tgz', 'pkg.tgz', (message: string) => transientMessages.push(message));
    check(transientDownloads === 3, `transient TLS failures retry until the third attempt (downloads=${transientDownloads})`);
    check(transientMessages[1]?.includes('attempt 2/3') === true && transientMessages[2]?.includes('attempt 3/3') === true,
        `retry progress names the attempt (${JSON.stringify(transientMessages)})`);

    let missingDownloads = 0;
    let missingError = '';
    try {
        await downloadToolingPackageWithRetry(async (_url: string, _dest: string) => {
            missingDownloads += 1;
            const error: any = new Error('Download failed: HTTP 404 for https://example.invalid/missing.tgz');
            error.code = 'HTTP_404';
            throw error;
        }, 'https://example.invalid/missing.tgz', 'missing.tgz');
    } catch (error) {
        missingError = error instanceof Error ? error.message : String(error);
    }
    check(missingDownloads === 1, `HTTP 404 is not retried (downloads=${missingDownloads})`);
    check(missingError.includes('https://example.invalid/missing.tgz'),
        `HTTP 404 preserves the URL (${missingError})`);

    let exhaustedDownloads = 0;
    const lastErrorText = 'ssl3_read_bytes: handshake failed after final attempt';
    let exhaustedMessage = '';
    try {
        await downloadToolingPackageWithRetry(async (_url: string, _dest: string) => {
            exhaustedDownloads += 1;
            throw new Error(lastErrorText);
        }, 'https://example.invalid/pkg.tgz', 'pkg.tgz');
    } catch (error) {
        exhaustedMessage = toolingInstallFailureMessage(
            `download failed: ${error instanceof Error ? error.message : String(error)}`,
            '4.3.0', toolingRepositoryUrl(packageJSON.repository.url));
    }
    check(exhaustedDownloads === 3, `three transient failures stop after three attempts (downloads=${exhaustedDownloads})`);
    check(exhaustedMessage.includes('npm install -g') && exhaustedMessage.includes(lastErrorText),
        `exhausted retries keep the original error and manual command (${exhaustedMessage})`);

    if (failures.length > 0) {
        throw new Error(`${failures.length} assertion(s) failed.`);
    }
}

run()
    .then(() => {
        console.log('All tooling prompt tests passed.');
        process.exit(0);
    })
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
export {};
