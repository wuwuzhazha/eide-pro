require('../../../src/headless/vscode').installVscodeShim();

const { connectWithOneRestart, makeIpcUnreachableError } = require('../../../src/mcp/mcp_client');
const { getLogPath } = require('../../../src/mcp/mcp_protocol');

const failures: string[] = [];

function check(cond: boolean, msg: string): void {
    if (cond) {
        console.log('OK:', msg);
    } else {
        console.error('FAIL:', msg);
        failures.push(msg);
    }
}

async function run(): Promise<void> {
    const okCase = { connect: 0, restart: 0 };
    const okOutcome = await connectWithOneRestart({
        connect: async () => { okCase.connect += 1; },
        restart: async () => { okCase.restart += 1; }
    });
    check(okOutcome === 'connected', `connected on the first attempt (${okOutcome})`);
    check(okCase.connect === 1 && okCase.restart === 0,
        `first success does not restart the proxy (connect=${okCase.connect}, restart=${okCase.restart})`);

    const retryCase = { connect: 0, restart: 0 };
    const retryOutcome = await connectWithOneRestart({
        connect: async () => {
            retryCase.connect += 1;
            if (retryCase.connect === 1) {
                throw new Error('IPC connect timeout');
            }
        },
        restart: async () => { retryCase.restart += 1; }
    });
    check(retryOutcome === 'restarted', `restart then reconnect reports restarted (${retryOutcome})`);
    check(retryCase.restart === 1 && retryCase.connect === 2,
        `restart happens exactly once and connect exactly twice (connect=${retryCase.connect}, restart=${retryCase.restart})`);

    const failCase = { connect: 0, restart: 0 };
    const failOutcome = await connectWithOneRestart({
        connect: async () => {
            failCase.connect += 1;
            throw new Error(`IPC connect timeout (attempt ${failCase.connect})`);
        },
        restart: async () => { failCase.restart += 1; }
    });
    check(failOutcome === 'failed', `two failures report failed (${failOutcome})`);
    check(failCase.restart === 1 && failCase.connect === 2,
        `no third connect attempt after two failures (connect=${failCase.connect}, restart=${failCase.restart})`);

    const httpPort = 45231;
    const ipcPort = 45232;
    const message = makeIpcUnreachableError(httpPort, ipcPort, new Error('connect ECONNREFUSED')).message;
    const logPath = getLogPath(httpPort);
    check(message.includes(String(httpPort)) && message.includes(String(ipcPort)),
        `failure message names both ports (http=${httpPort}, ipc=${ipcPort})`);
    check(message.includes(logPath),
        `failure message points at the real log path (${logPath})`);
    check(message.includes('after restarting the proxy once') && message.includes('EIDE.MCP.Server.Port'),
        'failure message states the single restart and the setting to check');

    if (failures.length > 0) {
        throw new Error(`${failures.length} assertion(s) failed.`);
    }
}

run()
    .then(() => {
        console.log('All mcp proxy restart tests passed.');
        process.exit(0);
    })
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
export {};
