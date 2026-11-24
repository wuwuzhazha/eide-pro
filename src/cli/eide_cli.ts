import { errorPayload, main, processIo, writeJson } from './main';

main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => {
        const err = error instanceof Error ? error : new Error(String(error));
        processIo.stderr(`${err.message}\n`);
        writeJson(processIo, errorPayload(null, err, 'internal'));
        process.exitCode = 4;
    }
);
