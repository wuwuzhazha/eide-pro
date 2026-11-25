const { createMcpServer } = require('../../../src/mcp/mcp_proxy_tools');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

async function run(): Promise<void> {
    const server = createMcpServer(async () => ({ content: [] }), { version: '4.3.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'registration-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert(tools.tools.length === 22, `proxy tools/list exposes 22 tools (got ${tools.tools.length})`);
    assert(tools.tools.some((tool: any) => tool.name === 'eide_get_environment'),
        'proxy tools/list exposes eide_get_environment');
    await client.close();
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
