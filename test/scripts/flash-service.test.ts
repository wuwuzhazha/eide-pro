import * as fs from 'fs';

import type { ProcessOptions, ProcessResult, ProcessRunner } from '../../src/core/adapters';
import {
    DEFAULT_FLASH_TIMEOUT_MS,
    ProcessFlashService
} from '../../src/core/flash/service';
import type { FlashRequest } from '../../src/core/flash/types';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
    const actualText = JSON.stringify(actual);
    const expectedText = JSON.stringify(expected);
    if (actualText !== expectedText) {
        console.error(`FAIL: ${msg}`);
        console.error(`  expected: ${expectedText}`);
        console.error(`  actual:   ${actualText}`);
        process.exit(1);
    }
    console.log('OK:', msg);
}

type Handler = (file: string, args: string[], options?: ProcessOptions) => ProcessResult | Promise<ProcessResult>;

class MockRunner implements ProcessRunner {

    readonly calls: { file: string; args: string[]; options?: ProcessOptions }[] = [];

    constructor(private readonly handler: Handler) { }

    async run(file: string, args: string[], options?: ProcessOptions): Promise<ProcessResult> {
        this.calls.push({ file, args, options });
        return this.handler(file, args, options);
    }
}

const openOCDRequest: FlashRequest = {
    uploader: 'OpenOCD',
    programs: [{ path: 'E:/build/app.hex' }],
    verify: true,
    options: {
        executable: 'openocd',
        interfaceConfig: 'cmsis-dap',
        targetConfig: 'stm32f4x'
    }
};

async function main(): Promise<void> {

    {
        const stdout = 'Open On-Chip Debugger 0.12.0\n** Verified OK **\n';
        const stderr = 'Warn : target not halted\n';
        const runner = new MockRunner(() => ({ code: 0, stdout, stderr }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash(openOCDRequest);

        assert(result.success === true, 'service: successful flash');
        assert(result.code === 'ok', 'service: success code');
        assert(result.verified === true, 'service: successful verify reported');
        assert(result.stdout === stdout, 'service: stdout captured');
        assert(result.stderr === stderr, 'service: stderr captured');
        assert(runner.calls.length === 1, 'service: runner called once');
        assertEqual(runner.calls[0].file, 'openocd', 'service: executable passed to runner');
        assertEqual(runner.calls[0].options?.timeoutMs, DEFAULT_FLASH_TIMEOUT_MS,
            'service: default timeout is bounded');
    }

    {
        const stdout = 'partial output';
        const stderr = 'Error: no target found\n';
        const runner = new MockRunner(() => ({ code: 2, stdout, stderr }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash(openOCDRequest);

        assert(result.success === false, 'service: nonzero exit fails');
        assert(result.code === 'failed', 'service: failure code');
        assert(result.verified === false, 'service: failed verify reported');
        assert(result.stdout === stdout, 'service: failure stdout captured');
        assert(result.stderr === stderr, 'service: failure stderr captured');
        assert(result.reason === 'Error: no target found', 'service: reason uses tool error line');
    }

    {
        const runner = new MockRunner(() => ({
            code: 0,
            stdout: '** Verify Failed **\n',
            stderr: ''
        }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash(openOCDRequest);

        assert(result.success === false, 'service: verification failure fails despite exit 0');
        assert(result.code === 'failed', 'service: verification failure code');
        assert(result.verified === false, 'service: verification failure is not verified');
        assert(result.reason?.includes('verification failed') === true,
            'service: verification failure reason');
    }

    {
        const runner = new MockRunner(() => ({
            code: 0,
            stdout: 'Verification...KO\n',
            stderr: ''
        }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'STLink',
            programs: [{ path: 'E:/build/app.bin' }],
            options: {
                executable: 'STM32_Programmer_CLI.exe',
                variant: 'cube-programmer'
            }
        });

        assert(result.success === false, 'service: STLink verification failure fails');
        assert(result.code === 'failed', 'service: STLink verification failure code');
        assert(result.verified === false, 'service: STLink verification failure is not verified');
    }

    {
        const runner = new MockRunner(() => ({
            code: 0,
            stdout: 'Error: unable to open ftdi device\n',
            stderr: ''
        }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash(openOCDRequest);

        assert(result.success === false, 'service: error marker fails despite exit 0');
        assert(result.code === 'failed', 'service: error marker code');
        assert(result.reason?.includes('Error: unable to open ftdi device') === true,
            'service: error marker reason');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: 'Download complete\n', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'STLink',
            programs: [{ path: 'E:/build/app.bin', address: '0x08000000' }],
            verify: false,
            options: {
                executable: 'STM32_Programmer_CLI.exe',
                variant: 'cube-programmer'
            }
        });

        assert(result.success === true, 'service: flash succeeds without verify');
        assert(result.verified === undefined, 'service: no verification claimed when not performed');
        assert(!runner.calls[0].args.includes('-v'), 'service: verify flag omitted from command');
    }

    {
        const state = { called: false };
        const runner = new MockRunner(() => {
            state.called = true;
            return new Promise<ProcessResult>(() => undefined);
        });
        const service = new ProcessFlashService(runner);

        const started = Date.now();
        const result = await service.flash({
            ...openOCDRequest,
            timeoutMs: 10
        });
        const elapsed = Date.now() - started;

        assert(state.called === true, 'service: timeout runner invoked');
        assert(result.success === false, 'service: timeout fails');
        assert(result.code === 'timeout', 'service: timeout code');
        assert(result.reason?.includes('timed out') === true, 'service: timeout reason');
        assert(result.verified === false, 'service: timeout does not verify');
        assert(elapsed < 1000, 'service: timeout is bounded');
        assertEqual(runner.calls[0].options?.timeoutMs, 10, 'service: timeout passed to runner');
    }

    {
        const runner = new MockRunner(() => ({
            code: null,
            stdout: 'timeout stdout',
            stderr: 'timeout stderr'
        }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash(openOCDRequest);

        assert(result.success === false, 'service: null exit code fails');
        assert(result.code === 'timeout', 'service: null exit code is timeout');
        assert(result.stdout === 'timeout stdout', 'service: timeout stdout captured');
        assert(result.stderr === 'timeout stderr', 'service: timeout stderr captured');
    }

    {
        const runner = new MockRunner(() => {
            throw new Error('spawn openocd ENOENT');
        });
        const service = new ProcessFlashService(runner);

        const result = await service.flash(openOCDRequest);

        assert(result.success === false, 'service: runner error fails');
        assert(result.code === 'failed', 'service: runner error code');
        assert(result.reason?.includes('ENOENT') === true, 'service: runner error reason');
        assert(result.verified === false, 'service: runner error does not verify');
    }

    {
        let commandFilePath = '';
        let scriptContents = '';
        const runner = new MockRunner((file, args) => {
            const index = args.indexOf('-CommandFile');
            commandFilePath = args[index + 1];
            scriptContents = fs.readFileSync(commandFilePath, 'utf8');
            return { code: 0, stdout: 'O.K.\n', stderr: '' };
        });
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'JLink',
            programs: [{ path: 'E:/build/app.hex' }],
            verify: true,
            options: {
                executable: 'JLinkExe',
                device: 'STM32F103C8'
            }
        });

        assert(result.success === true, 'service: JLink succeeds');
        assert(result.verified === true, 'service: JLink verification reported');
        assertEqual(scriptContents, [
            'r', 'halt', 'loadfile "E:/build/app.hex"', 'r', 'go', 'exit'
        ].join('\n'), 'service: JLink command file materialized');
        assert(commandFilePath.endsWith('.jlink'), 'service: JLink command file extension');
        assert(commandFilePath !== '__EIDE_FLASH_COMMAND_FILE__',
            'service: command file placeholder replaced');
        assert(!fs.existsSync(commandFilePath), 'service: temporary command file removed');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: '', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'STVP',
            programs: [],
            verify: true
        });

        assert(result.success === false, 'service: unsupported uploader fails');
        assert(result.code === 'not_supported', 'service: unsupported uploader code');
        assert(result.reason?.includes('STVP') === true, 'service: unsupported uploader reason');
        assert(runner.calls.length === 0, 'service: unsupported uploader is not executed');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: '', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'JLink',
            eraseAll: true,
            verify: true,
            programs: [],
            options: {
                executable: 'JLinkExe',
                device: 'STM32F103C8'
            }
        });

        assert(result.success === false, 'service: verify with erase-all fails');
        assert(result.code === 'not_supported', 'service: verify with erase-all is not supported');
        assert(result.reason?.includes('verify cannot be performed for eraseAll') === true,
            'service: verify with erase-all reason');
        assert(runner.calls.length === 0, 'service: verify with erase-all is not executed');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: '', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'OpenOCD',
            eraseAll: true,
            programs: [],
            options: {
                executable: 'openocd',
                interfaceConfig: 'cmsis-dap',
                targetConfig: 'stm32f4x'
            }
        });

        assert(result.success === false, 'service: unsupported erase-all fails');
        assert(result.code === 'not_supported', 'service: unsupported erase-all code');
        assert(runner.calls.length === 0, 'service: unsupported erase-all is not executed');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: '', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'OpenOCD',
            programs: [],
            options: {
                executable: 'openocd',
                interfaceConfig: 'cmsis-dap',
                targetConfig: 'stm32f4x'
            }
        });

        assert(result.success === false, 'service: missing artifact fails');
        assert(result.code === 'invalid_request', 'service: missing artifact code');
        assert(result.reason?.includes('no program files') === true,
            'service: missing artifact reason');
        assert(runner.calls.length === 0, 'service: invalid request is not executed');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: '** Verified OK **\n', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'OpenOCD',
            programs: [{ path: 'E:/build/app.hex' }],
            options: {
                executable: 'openocd',
                interfaceConfig: 'cmsis-dap',
                targetConfig: 'stm32f4x'
            }
        });

        assert(result.success === true, 'service: default request verifies');
        assert(result.verified === true, 'service: default request reports verification');
        assertEqual(runner.calls[0].args[5], 'program "E:/build/app.hex" verify',
            'service: default request passes the verify keyword');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: 'Flash written\n', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'pyOCD',
            programs: [{ path: 'E:/build/app.hex' }],
            options: { executable: 'pyocd', target: 'stm32f103rc' }
        });

        assert(result.success === true, 'service: pyOCD flash succeeds');
        assert(result.verified === undefined, 'service: pyOCD never claims verification');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: '', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'pyOCD',
            programs: [{ path: 'E:/build/app.hex' }],
            verify: true,
            options: { executable: 'pyocd', target: 'stm32f103rc' }
        });

        assert(result.success === false, 'service: pyOCD verify request fails');
        assert(result.code === 'not_supported', 'service: pyOCD verify request code');
        assert(result.reason?.includes('verification is not supported') === true,
            'service: pyOCD verify request reason');
        assert(runner.calls.length === 0, 'service: pyOCD verify request is not executed');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: '', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.flash({
            uploader: 'JLink',
            programs: [{ path: 'E:/build/app.hex' }],
            verify: false,
            options: { executable: 'JLinkExe', device: 'STM32F103C8' }
        });

        assert(result.success === false, 'service: JLink verify disable fails');
        assert(result.code === 'not_supported', 'service: JLink verify disable code');
        assert(runner.calls.length === 0, 'service: JLink verify disable is not executed');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: '', stderr: '' }));
        const service = new ProcessFlashService(runner);

        const result = await service.readback({
            uploader: 'JLink',
            address: '0x08000000',
            length: 16,
            destination: 'E:/dump.bin'
        });

        assert(result.success === false, 'service: readback fails');
        assert(result.code === 'not_supported', 'service: readback is not supported');
        assert(result.reason?.includes('readback is not supported') === true,
            'service: readback reason');
        assert(runner.calls.length === 0, 'service: readback is not executed');
    }

    {
        const runner = new MockRunner(() => ({ code: 0, stdout: '', stderr: '' }));
        const service = new ProcessFlashService(runner);

        assertEqual(service.listTools().length, 8, 'service: lists all tools');
        assert(service.getCapabilities('JLink').supported === true, 'service: JLink capability');
        assert(service.getCapabilities('STVP').supported === false, 'service: STVP capability');
    }
}

main().catch((error) => {
    console.error('FAIL:', error);
    process.exit(1);
});
