export const EXTENSION_ID = 'wuwuzhazha.eide-pro';

export const EXTENSION_DISPLAY_NAME = 'EIDE AI';

export const MARKETPLACE_EXTENSION_ID = 'wuwuzhazha.eide-ai';

export function isEideExtensionId(id: unknown): boolean {
    return id === EXTENSION_ID || id === MARKETPLACE_EXTENSION_ID || id === 'cl.eide';
}
