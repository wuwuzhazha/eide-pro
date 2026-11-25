import type { BuildProblem, BuildProblemSeverity } from './core/problems';

export type { BuildProblem, BuildProblemSeverity } from './core/problems';

export interface MemoryRegionUsage {
    used: number;
    size: number;
    percent: number;
}

export type BuildStage = 'builder' | 'compile' | 'link';

export interface DiagnosticLike {
    range: { start: { line: number; character: number } };
    severity: number;
    message: string;
    code?: string | number | { value: string | number };
}

export type CompilerDiagnosticsLike = { [path: string]: DiagnosticLike[] };

const severities: BuildProblemSeverity[] = ['error', 'warning', 'info', 'hint'];

export function toBuildProblems(diags: CompilerDiagnosticsLike): BuildProblem[] {
    const problems: BuildProblem[] = [];
    for (const file of Object.keys(diags)) {
        for (const diag of diags[file]) {
            const severity = severities[diag.severity];
            if (severity === undefined) {
                throw new Error(`Unknown diagnostic severity: ${diag.severity}`);
            }
            let code: string | undefined;
            if (typeof diag.code === 'string' || typeof diag.code === 'number') {
                code = String(diag.code);
            } else if (diag.code && typeof diag.code === 'object') {
                code = String(diag.code.value);
            }
            problems.push({
                file,
                line: diag.range.start.line + 1,
                column: diag.range.start.character + 1,
                severity,
                code,
                message: diag.message
            });
        }
    }
    return problems;
}

const memoryHeader = /^\s*Memory region\s+Used Size\s+Region Size\s+%age Used\s*$/;
const memoryRow = /^\s*(\S+):\s+([\d.]+)\s+([KMG]?B)\s+([\d.]+)\s+([KMG]?B)(?:\s+([\d.]+)%)?\s*$/;

const unitBytes: { [unit: string]: number } = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024
};

function toBytes(value: string, unit: string): number {
    return Number(value) * unitBytes[unit];
}

export function parseMemoryUsage(logText: string): { [region: string]: MemoryRegionUsage } {
    const lines = logText.split(/\r\n|\n/);
    let result: { [region: string]: MemoryRegionUsage } = {};
    for (let i = 0; i < lines.length; i++) {
        if (!memoryHeader.test(lines[i])) {
            continue;
        }
        const table: { [region: string]: MemoryRegionUsage } = {};
        let j = i + 1;
        for (; j < lines.length; j++) {
            const m = memoryRow.exec(lines[j]);
            if (!m) {
                break;
            }
            const used = toBytes(m[2], m[3]);
            const size = toBytes(m[4], m[5]);
            const percent = m[6] !== undefined
                ? Number(m[6])
                : (size > 0 ? Math.round(used / size * 10000) / 100 : 0);
            table[m[1]] = { used, size, percent };
        }
        result = table;
        i = j - 1;
    }
    return result;
}

function sectionBody(logText: string, marker: string): string {
    const start = logText.indexOf(marker);
    if (start === -1) {
        return '';
    }
    const bodyStart = start + marker.length;
    const next = logText.indexOf('>>>', bodyStart);
    return logText.slice(bodyStart, next === -1 ? undefined : next).trim();
}

export function detectBuildStage(logText: string, success: boolean): BuildStage {
    if (success) {
        return 'link';
    }
    if (!logText.includes('>>>')) {
        return 'builder';
    }
    return sectionBody(logText, '>>> ld').length > 0 ? 'link' : 'compile';
}

export function makeLogTail(message: string, maxLines = 120): string {
    const lines = message.split(/\r\n|\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trim();
}
