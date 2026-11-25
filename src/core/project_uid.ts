import * as crypto from 'crypto';

let sequence = 0;

export function newProjectUid(eideDirPath: string): string {
    sequence += 1;
    return crypto.createHash('md5').update(`${eideDirPath}-${Date.now()}-${sequence}`).digest('hex');
}
