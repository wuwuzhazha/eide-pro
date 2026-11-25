const {
    parseMemoryUsage,
    detectBuildStage,
    makeLogTail,
    toBuildProblems
} = require('../../../src/BuildReport') as any;

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

const memoryLog = [
    '>>> ld',
    '',
    'Memory region         Used Size  Region Size  %age Used',
    '           FLASH:        1148 B       128 KB      0.88%',
    '             RAM:         284 B        20 KB      1.39%',
    '       MEMORY_B1:          0 GB         0 GB',
    '',
    '>>> postbuild'
].join('\n');

const memory = parseMemoryUsage(memoryLog);
assert(memory.FLASH.used === 1148, 'memory: FLASH used bytes');
assert(memory.FLASH.size === 128 * 1024, 'memory: FLASH region bytes');
assert(memory.FLASH.percent === 0.88, 'memory: FLASH percent');
assert(memory.RAM.used === 284 && memory.RAM.size === 20 * 1024, 'memory: RAM bytes');
assert(memory.MEMORY_B1.used === 0 && memory.MEMORY_B1.percent === 0,
    'memory: missing percent is normalized to 0 for empty region');

const secondTable = [
    'Memory region         Used Size  Region Size  %age Used',
    '           FLASH:        2048 B       256 KB      0.78%'
].join('\n');
const lastTable = parseMemoryUsage(memoryLog + '\n' + secondTable);
assert(lastTable.FLASH.used === 2048 && lastTable.RAM === undefined,
    'memory: last table wins');

assert(detectBuildStage('>>> cc\n>>> ld\n', true) === 'link',
    'stage: success is link');
assert(detectBuildStage('>>> cc\nerror\n', false) === 'compile',
    'stage: failure before ld is compile');
assert(detectBuildStage('>>> cc\n>>> ld\nundefined reference\n', false) === 'link',
    'stage: failure after ld is link');
assert(detectBuildStage('>>> cc\n>>> ld\n', false) === 'compile',
    'stage: empty link section stays at compile');
assert(detectBuildStage('>>> cc\n>>> ld\n\n>>> postbuild', false) === 'compile',
    'stage: postbuild marker does not look like linker output');
assert(detectBuildStage('', false) === 'builder',
    'stage: missing builder log is reported as builder');
assert(detectBuildStage('Error: builder does not support this option', false) === 'builder',
    'stage: builder failure before any section is reported as builder');

const problems = toBuildProblems({
    'C:/demo/src/main.c': [
        {
            range: { start: { line: 10, character: 3 } },
            severity: 0,
            message: 'expected \';\'',
            code: 'gcc'
        },
        {
            range: { start: { line: 20, character: 0 } },
            severity: 1,
            message: 'unused variable',
            code: { value: '-Wunused-variable' }
        }
    ]
});
assert(problems.length === 2, 'problems: flattened');
assert(problems[0].file === 'C:/demo/src/main.c', 'problems: keeps file path');
assert(problems[0].line === 11 && problems[0].column === 4,
    'problems: converts range to 1-based line/column');
assert(problems[0].severity === 'error' && problems[1].severity === 'warning',
    'problems: converts severity');
assert(problems[1].code === '-Wunused-variable', 'problems: converts object code');

let unknownSeverity = false;
try {
    toBuildProblems({
        'a.c': [{
            range: { start: { line: 0, character: 0 } },
            severity: 9,
            message: 'bad'
        }]
    });
} catch {
    unknownSeverity = true;
}
assert(unknownSeverity, 'problems: unknown severity throws');

const longLog = Array.from({ length: 150 }, (_, i) => `line${i}`).join('\n');
const tail = makeLogTail(longLog);
assert(tail.split('\n').length === 120, 'logTail: keeps last 120 lines');
assert(tail.startsWith('line30'), 'logTail: starts at expected line');
assert(makeLogTail(longLog, 2).split('\n').join('|') === 'line148|line149',
    'logTail: custom line limit');

console.log('All build report tests passed.');

export {};
