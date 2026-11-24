import * as fs from 'fs';
import * as NodePath from 'path';
import { ConfigError } from '../core/errors';

export function bundledResourcesDir(): string {
    const resourcesDir = NodePath.resolve(__dirname, '..', 'res');
    if (!fs.existsSync(NodePath.join(resourcesDir, 'data', 'models'))) {
        throw new ConfigError(
            `Bundled EIDE resources not found at ${resourcesDir}; pass --resources explicitly.`);
    }
    return resourcesDir;
}
