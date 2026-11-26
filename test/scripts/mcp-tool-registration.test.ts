const { createMcpServer } = require('../../../src/mcp/mcp_proxy_tools');
const fs = require('fs');
const NodePath = require('path');
require('../../../src/headless/vscode').installVscodeShim();
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { LATEST_PROTOCOL_VERSION } = require('@modelcontextprotocol/sdk/types.js');
const { executeTool } = require('../../../src/mcp/mcp_impl');

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

async function run(): Promise<void> {
    const serverSource = fs.readFileSync(NodePath.join(__dirname, '../../../../src/mcp/mcp_server.ts'), 'utf8');
    assert(/createMcpServer\([\s\S]*?\{ version, debugTools: true \}\)/.test(serverSource),
        'HTTP server registers all tools with debugTools: true');
    const names: string[][] = [];
    for (const delegate of [
        async () => ({ content: [] }),
        async (tool: string, args: Record<string, unknown>) => executeTool(tool, args, {} as any)
    ]) {
        const server = createMcpServer(delegate,
            { version: '4.3.0', debugTools: true });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'registration-test', version: '1.0.0', options: { protocolVersion: LATEST_PROTOCOL_VERSION } });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const tools = await client.listTools();
        names.push(tools.tools.map((tool: any) => tool.name));
        await client.close();
    }
    assert(names[0].length === 43 && names[1].length === 43,
        `both transports expose 43 tools (headless=${names[0].length}, http=${names[1].length})`);
    assert(JSON.stringify(names[0]) === JSON.stringify(names[1]),
        'both transports expose the same tool name set');

    const faultServer = createMcpServer(async () => ({ content: [] }), { version: '4.3.0', debugTools: true });
    const [faultClientTransport, faultServerTransport] = InMemoryTransport.createLinkedPair();
    const faultClient = new Client({ name: 'registration-test', version: '1.0.0' });
    await Promise.all([faultServer.connect(faultServerTransport), faultClient.connect(faultClientTransport)]);
    const faultTools = await faultClient.listTools();
    const faultDescription = faultTools.tools.find((tool: any) => tool.name === 'eide_debug_fault')?.description ?? '';
    assert(faultDescription.includes('exception.backtrace.frames')
        && faultDescription.includes('callSite')
        && faultDescription.includes('faultPc'),
    `eide_debug_fault describes the complete backtrace contract (${faultDescription})`);
    assert(!/\)\.,|\.\./.test(faultDescription),
        `eide_debug_fault description has no concatenation residue (${faultDescription})`);
    await faultClient.close();

    const unsupported = await executeTool('eide_debug_connect', { uid: 'probe' }, {} as any);
    assert(unsupported.isError === true
        && (unsupported as any).structuredContent.error.name === 'UnsupportedTransport'
        && (unsupported as any).structuredContent.error.message.includes('eide-mcp --project'),
    `HTTP debug tool returns UnsupportedTransport (${JSON.stringify((unsupported as any).structuredContent)})`);
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});

export {};
