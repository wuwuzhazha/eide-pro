import { ConfigError } from './errors';

export interface SchemaField {
    description?: string;
    type?: string;
}

export interface SchemaTopLevel {
    [key: string]: unknown;
}

function descriptionOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const schema = value as Record<string, unknown>;
    const description = schema.markdownDescription ?? schema.description;
    return typeof description === 'string' ? description : undefined;
}

export function selectBuilderOptionsSchema(schema: object, path?: string): object {
    const properties = (schema as Record<string, unknown>).properties;
    if (!properties || typeof properties !== 'object') {
        throw new ConfigError('Builder options schema has no properties.');
    }
    const segments = path === undefined || path === ''
        ? []
        : path.split('.').filter(segment => segment.length > 0);
    let current = properties as Record<string, unknown>;
    for (const segment of segments) {
        const next = current[segment];
        if (!next || typeof next !== 'object') {
            throw new ConfigError(
                `Unknown schema path '${path}'. Available keys: ${Object.keys(current).join(', ')}`);
        }
        const nested = (next as Record<string, unknown>).properties;
        current = nested && typeof nested === 'object'
            ? nested as Record<string, unknown>
            : next as Record<string, unknown>;
    }
    if (segments.length === 0) {
        return Object.fromEntries(Object.entries(current).map(([key, value]) => [key, {
            description: descriptionOf(value)
        }]));
    }
    return current;
}
