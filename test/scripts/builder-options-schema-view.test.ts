const { selectBuilderOptionsSchema } = require('../../../src/core/builder_options_schema_view') as any;
const { ConfigError } = require('../../../src/core/errors') as any;

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('OK:', msg);
}

const schema = {
    properties: {
        global: {
            markdownDescription: 'Global options',
            properties: {
                optimization: { description: 'Optimization level', type: 'string' }
            }
        },
        'c/cpp-compiler': {
            properties: {
                warnings: { description: 'Warning level', type: 'string' }
            }
        }
    }
};

const top = selectBuilderOptionsSchema(schema) as Record<string, any>;
assert(Object.keys(top).join('|') === 'global|c/cpp-compiler', 'schema: top-level keys');
assert(top.global.description === 'Global options', 'schema: top-level description');

const nested = selectBuilderOptionsSchema(schema, 'c/cpp-compiler') as Record<string, any>;
assert(nested.warnings.description === 'Warning level', 'schema: selected subtree');

let invalid = false;
try {
    selectBuilderOptionsSchema(schema, 'global.missing');
} catch (error) {
    invalid = error instanceof ConfigError
        && error.message.includes('Available keys: optimization');
}
assert(invalid, 'schema: invalid path is a ConfigError with available keys');

console.log('All builder options schema view tests passed.');
export {};
