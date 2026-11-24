import * as fs from 'fs';

const lockedFiles: Map<number, string> = new Map();

function readHolderPid(fpath: string): number | undefined {
    const content = fs.readFileSync(fpath, 'utf8').trim();
    if (!/^\d+$/.test(content)) {
        return undefined;
    }
    const pid = Number(content);
    return pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (<NodeJS.ErrnoException>error).code !== 'ESRCH';
    }
}

function createLockFile(fpath: string): number {
    const tmpPath = `${fpath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmpPath, String(process.pid));
        fs.linkSync(tmpPath, fpath);
    } finally {
        fs.rmSync(tmpPath, { force: true });
    }
    return fs.openSync(fpath, 'r');
}

function tryAcquire(fpath: string): number | undefined {

    try {
        return createLockFile(fpath);
    } catch (error) {
        if ((<NodeJS.ErrnoException>error).code !== 'EEXIST') {
            throw error;
        }
    }

    const holder = readHolderPid(fpath);
    if (holder !== undefined && isProcessAlive(holder)) {
        return undefined;
    }

    const reclaimPath = `${fpath}.reclaim.${process.pid}`;
    try {
        fs.renameSync(fpath, reclaimPath);
    } catch (renameError) {
        if ((<NodeJS.ErrnoException>renameError).code === 'ENOENT') {
            return undefined;
        }
        throw renameError;
    }

    const reclaimed = readHolderPid(reclaimPath);
    if (reclaimed !== undefined && isProcessAlive(reclaimed)) {
        try {
            fs.linkSync(reclaimPath, fpath);
        } catch (linkError) {
            if ((<NodeJS.ErrnoException>linkError).code !== 'EEXIST') {
                throw linkError;
            }
        } finally {
            fs.rmSync(reclaimPath, { force: true });
        }
        return undefined;
    }

    fs.unlinkSync(reclaimPath);

    try {
        return createLockFile(fpath);
    } catch (retryError) {
        if ((<NodeJS.ErrnoException>retryError).code === 'EEXIST') {
            return undefined;
        }
        throw retryError;
    }
}

export function acquireProjectLock(fpath: string): number | undefined {

    const fd = tryAcquire(fpath);

    if (fd === undefined) {
        return undefined;
    }

    lockedFiles.set(fd, fpath);

    return fd;
}

export function releaseProjectLock(fpath_or_fd: string | number): boolean {

    let target_fd: number | undefined;
    let target_path: string | undefined;

    for (const kv of lockedFiles) {

        const t_fd = kv[0];
        const t_path = kv[1];

        if (typeof fpath_or_fd == 'string') {

            if (t_path == fpath_or_fd) {
                target_fd = t_fd;
                target_path = t_path;
                break;
            }

        } else if (typeof fpath_or_fd == 'number') {

            if (t_fd == fpath_or_fd) {
                target_fd = t_fd;
                target_path = t_path;
                break;
            }
        }
    }

    if (target_fd === undefined || target_path === undefined) {
        return false;
    }

    fs.closeSync(target_fd);
    lockedFiles.delete(target_fd);

    if (fs.readFileSync(target_path, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(target_path);
    }

    return true;
}
