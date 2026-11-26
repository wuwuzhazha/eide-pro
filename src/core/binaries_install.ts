import * as fs from 'fs';
import * as os from 'os';
import * as NodePath from 'path';

export interface BinariesInstallResult {
    success: boolean;
    message: string;
}

export interface BinariesInstallDeps {
    rename?: (from: string, to: string) => void;
}

export async function installBinaries(
    target: string,
    extract: (staging: string) => Promise<void>,
    deps: BinariesInstallDeps = {}
): Promise<BinariesInstallResult> {
    const parent = NodePath.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(NodePath.join(parent, `.binaries-install-${process.pid}-`));
    const rename = deps.rename ?? fs.renameSync;
    try {
        try {
            await extract(staging);
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
        if (!fs.existsSync(target)) {
            rename(staging, target);
            return { success: true, message: `Installed ${target}` };
        }
        const backup = NodePath.join(parent, `.binaries-backup-${process.pid}-${Date.now()}`);
        rename(target, backup);
        try {
            rename(staging, target);
        } catch (error) {
            rename(backup, target);
            throw error;
        }
        fs.rmSync(backup, { recursive: true, force: true });
        return { success: true, message: `Installed ${target}` };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
        if (fs.existsSync(staging)) {
            fs.rmSync(staging, { recursive: true, force: true });
        }
    }
}

export function cleanupStaleStaging(parent: string): void {
    if (!fs.existsSync(parent)) {
        return;
    }
    for (const entry of fs.readdirSync(parent)) {
        if (!entry.startsWith('.binaries-install-') && !entry.startsWith('.binaries-backup-')) {
            continue;
        }
        const path = NodePath.join(parent, entry);
        fs.rmSync(path, { recursive: true, force: true });
    }
}
