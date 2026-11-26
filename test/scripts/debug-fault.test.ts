import {
    CFSR_BITS,
    CortexFaultKind,
    CortexFaultReason,
    CortexFaultReasonCode,
    decodeCfsr,
    decodeCortexFault,
    decodeHfsr,
    HFSR_BITS,
    selectFaultStack,
    decodeStackedFrame,
    STACKED_FRAME_WORDS,
} from '../../src/core/debug/fault';

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
    console.log('OK:', message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
    assert(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function assertCodes(reasons: CortexFaultReason[], expected: CortexFaultReasonCode[], message: string): void {
    assertEqual(reasons.map(reason => reason.code).join(','), expected.join(','), message);
}

assertEqual(HFSR_BITS.VECTTBL, 0x00000002, 'HFSR VECTTBL mask');
assertEqual(HFSR_BITS.FORCED, 0x40000000, 'HFSR FORCED mask');
assertEqual(HFSR_BITS.DEBUGEVT, 0x80000000, 'HFSR DEBUGEVT mask');
assertEqual(CFSR_BITS.IACCVIOL, 0x00000001, 'CFSR IACCVIOL mask');
assertEqual(CFSR_BITS.UNDEFINSTR, 0x00010000, 'CFSR UNDEFINSTR mask');
assertEqual(CFSR_BITS.DIVBYZERO, 0x02000000, 'CFSR DIVBYZERO mask');
assertEqual(CFSR_BITS.MMARVALID, 0x00000080, 'CFSR MMARVALID mask');
assertEqual(CFSR_BITS.BFARVALID, 0x00008000, 'CFSR BFARVALID mask');

const hfsrCases: Array<[number, CortexFaultReasonCode]> = [
    [HFSR_BITS.VECTTBL, 'VECTTBL'],
    [HFSR_BITS.FORCED, 'FORCED'],
    [HFSR_BITS.DEBUGEVT, 'DEBUGEVT'],
];
for (const [mask, code] of hfsrCases) {
    const reasons = decodeHfsr(mask);
    assertEqual(reasons.length, 1, `HFSR ${code} single reason`);
    assertEqual(reasons[0].code, code, `HFSR ${code} code`);
    assertEqual(reasons[0].kind, 'HardFault', `HFSR ${code} kind`);
    assertEqual(reasons[0].register, 'HFSR', `HFSR ${code} register`);
}

const cfsrCases: Array<[number, CortexFaultReasonCode, CortexFaultKind]> = [
    [CFSR_BITS.IACCVIOL, 'IACCVIOL', 'MemManage'],
    [CFSR_BITS.DACCVIOL, 'DACCVIOL', 'MemManage'],
    [CFSR_BITS.MUNSTKERR, 'MUNSTKERR', 'MemManage'],
    [CFSR_BITS.MSTKERR, 'MSTKERR', 'MemManage'],
    [CFSR_BITS.MLSPERR, 'MLSPERR', 'MemManage'],
    [CFSR_BITS.IBUSERR, 'IBUSERR', 'BusFault'],
    [CFSR_BITS.PRECISERR, 'PRECISERR', 'BusFault'],
    [CFSR_BITS.IMPRECISERR, 'IMPRECISERR', 'BusFault'],
    [CFSR_BITS.UNSTKERR, 'UNSTKERR', 'BusFault'],
    [CFSR_BITS.STKERR, 'STKERR', 'BusFault'],
    [CFSR_BITS.LSPERR, 'LSPERR', 'BusFault'],
    [CFSR_BITS.UNDEFINSTR, 'UNDEFINSTR', 'UsageFault'],
    [CFSR_BITS.INVSTATE, 'INVSTATE', 'UsageFault'],
    [CFSR_BITS.INVPC, 'INVPC', 'UsageFault'],
    [CFSR_BITS.NOCP, 'NOCP', 'UsageFault'],
    [CFSR_BITS.UNALIGNED, 'UNALIGNED', 'UsageFault'],
    [CFSR_BITS.DIVBYZERO, 'DIVBYZERO', 'UsageFault'],
];
for (const [mask, code, kind] of cfsrCases) {
    const reasons = decodeCfsr(mask);
    assertEqual(reasons.length, 1, `CFSR ${code} single reason`);
    assertEqual(reasons[0].code, code, `CFSR ${code} code`);
    assertEqual(reasons[0].kind, kind, `CFSR ${code} kind`);
    assertEqual(reasons[0].register, 'CFSR', `CFSR ${code} register`);
}

assertEqual(decodeHfsr(0).length, 0, 'HFSR zero has no reasons');
assertEqual(decodeCfsr(0).length, 0, 'CFSR zero has no reasons');
assertEqual(decodeCfsr(0x00000004).length, 0, 'reserved CFSR bit 2 is ignored');
assertEqual(decodeCfsr(0x00004000).length, 0, 'reserved CFSR bit 14 is ignored');

assertCodes(decodeHfsr(0x40000002), ['VECTTBL', 'FORCED'], 'HFSR combined flags');
assertCodes(
    decodeCfsr(0x02020403),
    ['IACCVIOL', 'DACCVIOL', 'IMPRECISERR', 'INVSTATE', 'DIVBYZERO'],
    'CFSR combined flags',
);

const all = decodeCortexFault({ hfsr: 0xffffffff, cfsr: 0xffffffff });
assertEqual(all.reasons.length, 20, 'all documented fault flags decoded');
assertCodes(
    all.reasons,
    [
        'VECTTBL',
        'FORCED',
        'DEBUGEVT',
        'IACCVIOL',
        'DACCVIOL',
        'MUNSTKERR',
        'MSTKERR',
        'MLSPERR',
        'IBUSERR',
        'PRECISERR',
        'IMPRECISERR',
        'UNSTKERR',
        'STKERR',
        'LSPERR',
        'UNDEFINSTR',
        'INVSTATE',
        'INVPC',
        'NOCP',
        'UNALIGNED',
        'DIVBYZERO',
    ],
    'all documented fault flags in bit order',
);

const escalated = decodeCortexFault({ hfsr: HFSR_BITS.FORCED, cfsr: CFSR_BITS.INVSTATE });
assertCodes(escalated.reasons, ['FORCED', 'INVSTATE'], 'escalated configurable fault');
assertEqual(escalated.mmfsr, 0x00, 'escalated mmfsr');
assertEqual(escalated.bfsr, 0x00, 'escalated bfsr');
assertEqual(escalated.ufsr, 0x0002, 'escalated ufsr');
assertEqual(escalated.memManageAddressValid, false, 'escalated mmar invalid');
assertEqual(escalated.busFaultAddressValid, false, 'escalated bfar invalid');
assertEqual(escalated.memManageAddress, undefined, 'escalated mmar absent');
assertEqual(escalated.busFaultAddress, undefined, 'escalated bfar absent');

const memManageAddress = decodeCortexFault({
    hfsr: 0,
    cfsr: CFSR_BITS.DACCVIOL | CFSR_BITS.MMARVALID,
    mmar: 0x20001000,
});
assertEqual(memManageAddress.memManageAddressValid, true, 'mmar valid flag');
assertEqual(memManageAddress.memManageAddress, 0x20001000, 'mmar address');
assertEqual(memManageAddress.busFaultAddressValid, false, 'bfar invalid with mmar fault');
assertCodes(memManageAddress.reasons, ['DACCVIOL'], 'mmar fault reasons');

const mmarWithoutValid = decodeCortexFault({ hfsr: 0, cfsr: 0, mmar: 0x20001000 });
assertEqual(mmarWithoutValid.memManageAddressValid, false, 'mmar without valid flag');
assertEqual(mmarWithoutValid.memManageAddress, undefined, 'mmar ignored without valid flag');

const busFaultAddress = decodeCortexFault({
    hfsr: 0,
    cfsr: CFSR_BITS.IBUSERR | CFSR_BITS.BFARVALID,
    bfar: 0x40000000,
});
assertEqual(busFaultAddress.busFaultAddressValid, true, 'bfar valid flag');
assertEqual(busFaultAddress.busFaultAddress, 0x40000000, 'bfar address');
assertCodes(busFaultAddress.reasons, ['IBUSERR'], 'bfar fault reasons');

const bfarWithoutValue = decodeCortexFault({ hfsr: 0, cfsr: CFSR_BITS.BFARVALID });
assertEqual(bfarWithoutValue.busFaultAddressValid, true, 'bfar valid flag without address');
assertEqual(bfarWithoutValue.busFaultAddress, undefined, 'bfar address absent when not supplied');

const split = decodeCortexFault({ hfsr: 0, cfsr: 0x12345678 });
assertEqual(split.mmfsr, 0x78, 'cfsr mmfsr split');
assertEqual(split.bfsr, 0x56, 'cfsr bfsr split');
assertEqual(split.ufsr, 0x1234, 'cfsr ufsr split');

const unmasked = decodeCortexFault({ hfsr: -1, cfsr: -1 });
assertEqual(unmasked.reasons.length, 20, 'negative register values are masked to 32 bits');

console.log('debug-fault tests passed');

assertEqual(STACKED_FRAME_WORDS, 8, 'stacked frame word count');
assertEqual(selectFaultStack(0xfffffff9), 'MSP', 'exc_return 0xfffffff9 uses MSP');
assertEqual(selectFaultStack(0xfffffffd), 'PSP', 'exc_return 0xfffffffd uses PSP');
assertEqual(selectFaultStack(0xfffffff1), 'MSP', 'exc_return 0xfffffff1 uses MSP');

for (const invalid of [0x08000087, 0]) {
    let message = '';
    try {
        selectFaultStack(invalid);
    } catch (error) {
        message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes(invalid.toString(16)), `invalid exc_return ${invalid} is rejected with hex value`);
}

const stackedWords = [
    0x00000000, 0x00000000, 0x20000000, 0x08000094,
    0x00000000, 0x08000087, 0x08000094, 0x60000000
];
const frame = decodeStackedFrame(stackedWords);
assertEqual(frame.r0, 0x00000000, 'stacked r0');
assertEqual(frame.r1, 0x00000000, 'stacked r1');
assertEqual(frame.r2, 0x20000000, 'stacked r2');
assertEqual(frame.r3, 0x08000094, 'stacked r3');
assertEqual(frame.r12, 0x00000000, 'stacked r12');
assertEqual(frame.lr, 0x08000087, 'stacked lr');
assertEqual(frame.pc, 0x08000094, 'stacked pc');
assertEqual(frame.xpsr, 0x60000000, 'stacked xpsr');

for (const count of [7, 9]) {
    let message = '';
    try {
        decodeStackedFrame(new Array(count).fill(0));
    } catch (error) {
        message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes(String(count)), `stacked frame with ${count} words is rejected with count`);
}

const negativeFrame = decodeStackedFrame([-1, -2, -3, -4, -5, -6, -7, -8]);
assertEqual(negativeFrame.r0, 0xffffffff, 'negative stacked word is normalized to unsigned');
assertEqual(negativeFrame.xpsr, 0xfffffff8, 'negative xpsr is normalized to unsigned');

console.log('debug-fault stacked frame tests passed');
