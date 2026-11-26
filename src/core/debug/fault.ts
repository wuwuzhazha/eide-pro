export type CortexFaultKind = 'HardFault' | 'MemManage' | 'BusFault' | 'UsageFault';

export type CortexFaultReasonCode =
    | 'VECTTBL'
    | 'FORCED'
    | 'DEBUGEVT'
    | 'IACCVIOL'
    | 'DACCVIOL'
    | 'MUNSTKERR'
    | 'MSTKERR'
    | 'MLSPERR'
    | 'IBUSERR'
    | 'PRECISERR'
    | 'IMPRECISERR'
    | 'UNSTKERR'
    | 'STKERR'
    | 'LSPERR'
    | 'UNDEFINSTR'
    | 'INVSTATE'
    | 'INVPC'
    | 'NOCP'
    | 'UNALIGNED'
    | 'DIVBYZERO';

export interface CortexFaultReason {
    code: CortexFaultReasonCode;
    register: 'HFSR' | 'CFSR';
    bit: number;
    kind: CortexFaultKind;
    description: string;
}

export interface CortexFaultRegisters {
    hfsr: number;
    cfsr: number;
    mmar?: number;
    bfar?: number;
}

export interface CortexFaultReport {
    reasons: CortexFaultReason[];
    mmfsr: number;
    bfsr: number;
    ufsr: number;
    memManageAddressValid: boolean;
    busFaultAddressValid: boolean;
    memManageAddress?: number;
    busFaultAddress?: number;
}

export const CORTEX_M_FAULT_REGISTERS = {
    hfsr: 0xe000ed2c,
    cfsr: 0xe000ed28,
    mmar: 0xe000ed34,
    bfar: 0xe000ed38,
} as const;

export const STACKED_FRAME_WORDS = 8;

export interface CortexStackedFrame {
    r0: number;
    r1: number;
    r2: number;
    r3: number;
    r12: number;
    lr: number;
    pc: number;
    xpsr: number;
}

export function selectFaultStack(excReturn: number): 'MSP' | 'PSP' {
    const value = excReturn >>> 0;
    if (value < 0xffffffe0) {
        throw new Error(`Invalid EXC_RETURN: 0x${value.toString(16)}`);
    }
    return (value & 0x4) === 0 ? 'MSP' : 'PSP';
}

export function decodeStackedFrame(words: readonly number[]): CortexStackedFrame {
    if (words.length !== STACKED_FRAME_WORDS) {
        throw new Error(`Stacked frame must have ${STACKED_FRAME_WORDS} words, got ${words.length}`);
    }
    return {
        r0: words[0] >>> 0,
        r1: words[1] >>> 0,
        r2: words[2] >>> 0,
        r3: words[3] >>> 0,
        r12: words[4] >>> 0,
        lr: words[5] >>> 0,
        pc: words[6] >>> 0,
        xpsr: words[7] >>> 0,
    };
}

export const HFSR_BITS = {
    VECTTBL: 0x00000002,
    FORCED: 0x40000000,
    DEBUGEVT: 0x80000000,
} as const;

export const CFSR_BITS = {
    IACCVIOL: 0x00000001,
    DACCVIOL: 0x00000002,
    MUNSTKERR: 0x00000008,
    MSTKERR: 0x00000010,
    MLSPERR: 0x00000020,
    MMARVALID: 0x00000080,
    IBUSERR: 0x00000100,
    PRECISERR: 0x00000200,
    IMPRECISERR: 0x00000400,
    UNSTKERR: 0x00000800,
    STKERR: 0x00001000,
    LSPERR: 0x00002000,
    BFARVALID: 0x00008000,
    UNDEFINSTR: 0x00010000,
    INVSTATE: 0x00020000,
    INVPC: 0x00040000,
    NOCP: 0x00080000,
    UNALIGNED: 0x01000000,
    DIVBYZERO: 0x02000000,
} as const;

interface FaultFlagDefinition {
    code: CortexFaultReasonCode;
    register: 'HFSR' | 'CFSR';
    mask: number;
    bit: number;
    kind: CortexFaultKind;
    description: string;
}

const HFSR_FLAGS: readonly FaultFlagDefinition[] = [
    {
        code: 'VECTTBL',
        register: 'HFSR',
        mask: HFSR_BITS.VECTTBL,
        bit: 1,
        kind: 'HardFault',
        description: 'vector table read fault',
    },
    {
        code: 'FORCED',
        register: 'HFSR',
        mask: HFSR_BITS.FORCED,
        bit: 30,
        kind: 'HardFault',
        description: 'configurable fault escalated to hard fault',
    },
    {
        code: 'DEBUGEVT',
        register: 'HFSR',
        mask: HFSR_BITS.DEBUGEVT,
        bit: 31,
        kind: 'HardFault',
        description: 'debug event fault',
    },
];

const CFSR_FLAGS: readonly FaultFlagDefinition[] = [
    {
        code: 'IACCVIOL',
        register: 'CFSR',
        mask: CFSR_BITS.IACCVIOL,
        bit: 0,
        kind: 'MemManage',
        description: 'instruction access violation',
    },
    {
        code: 'DACCVIOL',
        register: 'CFSR',
        mask: CFSR_BITS.DACCVIOL,
        bit: 1,
        kind: 'MemManage',
        description: 'data access violation',
    },
    {
        code: 'MUNSTKERR',
        register: 'CFSR',
        mask: CFSR_BITS.MUNSTKERR,
        bit: 3,
        kind: 'MemManage',
        description: 'memmanage fault during exception return unstacking',
    },
    {
        code: 'MSTKERR',
        register: 'CFSR',
        mask: CFSR_BITS.MSTKERR,
        bit: 4,
        kind: 'MemManage',
        description: 'memmanage fault during exception entry stacking',
    },
    {
        code: 'MLSPERR',
        register: 'CFSR',
        mask: CFSR_BITS.MLSPERR,
        bit: 5,
        kind: 'MemManage',
        description: 'memmanage fault during lazy floating-point state preservation',
    },
    {
        code: 'IBUSERR',
        register: 'CFSR',
        mask: CFSR_BITS.IBUSERR,
        bit: 8,
        kind: 'BusFault',
        description: 'instruction bus error',
    },
    {
        code: 'PRECISERR',
        register: 'CFSR',
        mask: CFSR_BITS.PRECISERR,
        bit: 9,
        kind: 'BusFault',
        description: 'precise data bus error',
    },
    {
        code: 'IMPRECISERR',
        register: 'CFSR',
        mask: CFSR_BITS.IMPRECISERR,
        bit: 10,
        kind: 'BusFault',
        description: 'imprecise data bus error',
    },
    {
        code: 'UNSTKERR',
        register: 'CFSR',
        mask: CFSR_BITS.UNSTKERR,
        bit: 11,
        kind: 'BusFault',
        description: 'bus fault during exception return unstacking',
    },
    {
        code: 'STKERR',
        register: 'CFSR',
        mask: CFSR_BITS.STKERR,
        bit: 12,
        kind: 'BusFault',
        description: 'bus fault during exception entry stacking',
    },
    {
        code: 'LSPERR',
        register: 'CFSR',
        mask: CFSR_BITS.LSPERR,
        bit: 13,
        kind: 'BusFault',
        description: 'bus fault during lazy floating-point state preservation',
    },
    {
        code: 'UNDEFINSTR',
        register: 'CFSR',
        mask: CFSR_BITS.UNDEFINSTR,
        bit: 16,
        kind: 'UsageFault',
        description: 'undefined instruction',
    },
    {
        code: 'INVSTATE',
        register: 'CFSR',
        mask: CFSR_BITS.INVSTATE,
        bit: 17,
        kind: 'UsageFault',
        description: 'invalid execution state',
    },
    {
        code: 'INVPC',
        register: 'CFSR',
        mask: CFSR_BITS.INVPC,
        bit: 18,
        kind: 'UsageFault',
        description: 'invalid program counter load',
    },
    {
        code: 'NOCP',
        register: 'CFSR',
        mask: CFSR_BITS.NOCP,
        bit: 19,
        kind: 'UsageFault',
        description: 'coprocessor access not present or disabled',
    },
    {
        code: 'UNALIGNED',
        register: 'CFSR',
        mask: CFSR_BITS.UNALIGNED,
        bit: 24,
        kind: 'UsageFault',
        description: 'unaligned memory access',
    },
    {
        code: 'DIVBYZERO',
        register: 'CFSR',
        mask: CFSR_BITS.DIVBYZERO,
        bit: 25,
        kind: 'UsageFault',
        description: 'integer divide by zero',
    },
];

export function decodeHfsr(hfsr: number): CortexFaultReason[] {
    return decodeFlags(hfsr, HFSR_FLAGS);
}

export function decodeCfsr(cfsr: number): CortexFaultReason[] {
    return decodeFlags(cfsr, CFSR_FLAGS);
}

export function decodeCortexFault(registers: CortexFaultRegisters): CortexFaultReport {
    const hfsr = registers.hfsr >>> 0;
    const cfsr = registers.cfsr >>> 0;
    const memManageAddressValid = (cfsr & CFSR_BITS.MMARVALID) !== 0;
    const busFaultAddressValid = (cfsr & CFSR_BITS.BFARVALID) !== 0;
    return {
        reasons: [...decodeHfsr(hfsr), ...decodeCfsr(cfsr)],
        mmfsr: cfsr & 0xff,
        bfsr: (cfsr >>> 8) & 0xff,
        ufsr: cfsr >>> 16,
        memManageAddressValid,
        busFaultAddressValid,
        memManageAddress:
            memManageAddressValid && registers.mmar !== undefined ? registers.mmar >>> 0 : undefined,
        busFaultAddress:
            busFaultAddressValid && registers.bfar !== undefined ? registers.bfar >>> 0 : undefined,
    };
}

function decodeFlags(value: number, flags: readonly FaultFlagDefinition[]): CortexFaultReason[] {
    const masked = value >>> 0;
    const reasons: CortexFaultReason[] = [];
    for (const flag of flags) {
        if ((masked & flag.mask) !== 0) {
            reasons.push({
                code: flag.code,
                register: flag.register,
                bit: flag.bit,
                kind: flag.kind,
                description: flag.description,
            });
        }
    }
    return reasons;
}
