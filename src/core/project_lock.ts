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

export function acquireProjectLock(fpath: string): number | undefined {

    let fd: number;

    try {
        fd = fs.openSync(fpath, 'wx');
    } catch (error) {
        if ((<NodeJS.ErrnoException>error).code !== 'EEXIST') {
            throw error;
        }
        const holder = readHolderPid(fpath);
        if (holder === undefined) {
            throw new Error(`Failed to lock '${fpath}': lock file has no valid owner pid.`);
        }
        if (isProcessAlive(holder)) {
            return undefined;
        }
        fs.unlinkSync(fpath);
        fd = fs.openSync(fpath, 'wx');
    }

    fs.writeSync(fd, String(process.pid));
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
