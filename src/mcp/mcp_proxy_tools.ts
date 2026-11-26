/*
    MIT License

    Copyright (c) 2019 github0null

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
*/

import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

const taskStore = new InMemoryTaskStore();

export type ToolDelegate = (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export interface McpServerOptions {
    version: string;
    debugTools?: boolean;
    headless?: boolean;
    singleProject?: boolean;
}

export function createMcpServer(
    delegateToolCall: ToolDelegate,
    options: McpServerOptions
): McpServer {

    const server = new McpServer(
        {
            name: 'EIDE Pro',
            version: options.version,
            websiteUrl: 'https://github.com/wuwuzhazha/eide-pro'
        },
        {
            capabilities: { logging: {}, tasks: { requests: { tools: { call: {} } } } },
            taskStore,
            taskMessageQueue: new InMemoryTaskMessageQueue()
        }
    );

    const uidSchema = (options.singleProject
        ? z.string().optional()
        : z.string()
    ).describe('Project UID. You can get it from "<Your workspace>/.eide/eide.yml", property name is "miscInfo.uid".' +
        (options.singleProject
            ? ' Optional: the server loads a single project, the uid must still match that project when given.'
            : ' Required.'));
    const stopTimeoutSchema = z.number().int().positive().optional().describe(
        'Stop-event timeout in milliseconds (default: 30000).');

    const overridesSchema = z.object({
        defines: z.array(z.string()).optional().describe('Additional preprocessor defines (NAME or NAME=VALUE).'),
        includeDirs: z.array(z.string()).optional().describe('Additional include directories.'),
        libDirs: z.array(z.string()).optional().describe('Additional library directories.'),
        cFlags: z.string().optional().describe('Extra C compiler flags.'),
        cxxFlags: z.string().optional().describe('Extra C++ compiler flags.'),
        asmFlags: z.string().optional().describe('Extra assembler flags.'),
        ldFlags: z.string().optional().describe('Extra linker flags.'),
        options: z.record(z.string(), z.unknown()).optional().describe('Deep patch for builder model options.'),
        source: z.object({
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional()
        }).optional().describe('Glob filters for the source file list.'),
        env: z.record(z.string(), z.string()).optional().describe('Extra project environment variables.')
    }).describe('Per-invocation build parameters. Supplying overrides forces a rebuild.');

    const buildInputSchema = {
        uid: uidSchema,
        overrides: overridesSchema.optional(),
        dryRun: z.boolean().optional().describe(
            'Generate builder.params and return the command line without executing the build.')
    };

    server.registerTool(
        'eide_build',
        {
            title: 'Build Project',
            description: 'Build your eide project with optional dynamic overrides. Returns JSON: success, stage, compiler problems (file/line/column/severity/code), memory usage, and logTail on failure. With dryRun=true it returns the generated builder params and command line.',
            inputSchema: buildInputSchema
        },
        async (args) => delegateToolCall('eide_build', args)
    );

    server.registerTool(
        'eide_rebuild',
        {
            title: 'Rebuild Project',
            description: 'Rebuild your eide project with optional dynamic overrides. Returns JSON: success, stage, compiler problems (file/line/column/severity/code), memory usage, and logTail on failure. With dryRun=true it returns the generated builder params and command line.',
            inputSchema: buildInputSchema
        },
        async (args) => delegateToolCall('eide_rebuild', args)
    );

    server.registerTool(
        'eide_clean',
        {
            title: 'Clean Project',
            description: `Clean up the generated products in the "build" directory.`,
            inputSchema: { uid: uidSchema }
        },
        async (args) => delegateToolCall('eide_clean', args)
    );

    server.registerTool(
        'eide_flash',
        {
            title: 'Program Flash',
            description: 'Perform flash memory programming on your MCU',
            inputSchema: {
                uid: uidSchema,
                eraseAll: z.boolean().describe('Determine whether to perform a chip erase of the mcu.'),
                dryRun: z.boolean().optional().describe(
                    'Build the flash command and return it without programming the device.'),
                ...(options.headless ? {
                    artifact: z.string().optional().describe(
                        "Flash artifact override: one or more 'path[,address]' entries separated by ';'."),
                    verify: z.boolean().optional().describe(
                        'Verify the programmed image. Omitted uses the flash tool default.')
                } : {})
            }
        },
        async (args) => delegateToolCall('eide_flash', args)
    );

    server.registerTool(
        'eide_reload',
        {
            title: 'Reload Project',
            description: `Reload the project. After you manually modify the project file, you should call this method to reload the project.`,
            inputSchema: { uid: uidSchema }
        },
        async (args) => delegateToolCall('eide_reload', args)
    );

    server.registerTool(
        'eide_get_targets',
        {
            title: 'Get build targets',
            description: 'Get active target name and all known target names for the project.',
            inputSchema: { uid: uidSchema }
        },
        async (args) => delegateToolCall('eide_get_targets', args)
    );

    server.registerTool(
        'eide_get_environment',
        {
            title: 'Get Environment',
            description: 'Resolve tool paths in order: EIDE settings, --toolchain-path, project config, PATH, xpack. A not-found result means all of these sources were searched.',
            inputSchema: {
                uid: uidSchema,
                target: z.string().optional().describe('Target name (defaults to the active target).')
            }
        },
        async (args) => delegateToolCall('eide_get_environment', args)
    );

    server.registerTool(
        'eide_switch_target',
        {
            title: 'Switch Target',
            description: `Select active build target for eide project.`,
            inputSchema: {
                uid: uidSchema,
                targetName: z.string().describe('Target Name.')
            }
        },
        async (args) => delegateToolCall('eide_switch_target', args)
    );

    server.registerTool(
        'eide_get_src_dirs',
        {
            title: 'Get all source directories',
            description: 'Get all source directory list of the project (JSON array).',
            inputSchema: { uid: uidSchema }
        },
        async (args) => delegateToolCall('eide_get_src_dirs', args)
    );

    server.registerTool(
        'eide_add_src_dir',
        {
            title: 'Add a source directory',
            description: `Select a source directory from filesystem and add to project. Then eide will collect c/c++ source file from this directory.`,
            inputSchema: {
                uid: uidSchema,
                path: z.string().describe('A filesystem path for this directory.')
            }
        },
        async (args) => delegateToolCall('eide_add_src_dir', args)
    );

    server.registerTool(
        'eide_del_src_dir',
        {
            title: 'Delete a source directory',
            description: 'Remove a source directory from the project (not delete files on disk).',
            inputSchema: {
                uid: uidSchema,
                path: z.string().describe('Source directory path to remove.')
            }
        },
        async (args) => delegateToolCall('eide_del_src_dir', args)
    );

    server.registerTool(
        'eide_exclude_src_file',
        {
            title: 'Exclude source file',
            description: 'Exclude a source file from build (add to exclude list).',
            inputSchema: {
                uid: uidSchema,
                path: z.string().describe('Source file path to exclude.')
            }
        },
        async (args) => delegateToolCall('eide_exclude_src_file', args)
    );

    server.registerTool(
        'eide_include_src_file',
        {
            title: 'Include source file',
            description: 'Remove a source file from exclude list so it will be built again.',
            inputSchema: {
                uid: uidSchema,
                path: z.string().describe('Source file path to include.')
            }
        },
        async (args) => delegateToolCall('eide_include_src_file', args)
    );

    server.registerTool(
        'eide_get_inc_dirs',
        {
            title: 'Get include directories',
            description: 'Get the target include directories that eide_set_inc_dirs replaces (JSON array). Dependency and toolchain include paths are not included.',
            inputSchema: { uid: uidSchema }
        },
        async (args) => delegateToolCall('eide_get_inc_dirs', args)
    );

    server.registerTool(
        'eide_set_inc_dirs',
        {
            title: 'Set include directories',
            description: 'Set include directories.',
            inputSchema: {
                uid: uidSchema,
                paths: z.array(z.string()).describe('Include directory paths.')
            }
        },
        async (args) => delegateToolCall('eide_set_inc_dirs', args)
    );

    server.registerTool(
        'eide_get_defines',
        {
            title: 'Get preprocessor defines',
            description: 'Get the target preprocessor defines that eide_set_defines replaces (JSON array). Dependency and toolchain defines are not included.',
            inputSchema: { uid: uidSchema }
        },
        async (args) => delegateToolCall('eide_get_defines', args)
    );

    server.registerTool(
        'eide_set_defines',
        {
            title: 'Set preprocessor defines',
            description: 'Set user preprocessor defines.',
            inputSchema: {
                uid: uidSchema,
                defines: z.array(z.string()).describe('Preprocessor macro defines, e.g. ["DEBUG=1", "USE_HAL"]')
            }
        },
        async (args) => delegateToolCall('eide_set_defines', args)
    );

    server.registerTool(
        'eide_get_builder_opts_schema',
        {
            title: 'Get builder options schema',
            description: 'Get builder options schema. Without path, returns only top-level keys and descriptions. With path, returns the full schema for that subtree. Use dot-separated keys; a key containing "/" is one segment, e.g. "c/cpp-compiler.optimization".',
            inputSchema: {
                uid: uidSchema,
                path: z.string().optional().describe(
                    'Optional dot-separated schema path, e.g. "c/cpp-compiler" or "global.optimization".')
            }
        },
        async (args) => delegateToolCall('eide_get_builder_opts_schema', args)
    );

    server.registerTool(
        'eide_get_builder_opts',
        {
            title: 'Get builder options',
            description: 'Get builder options (JSON object).',
            inputSchema: { uid: uidSchema }
        },
        async (args) => delegateToolCall('eide_get_builder_opts', args)
    );

    server.registerTool(
        'eide_set_builder_opts',
        {
            title: 'Set builder options',
            description: 'Set builder options. You can use tool: "eide_get_builder_opts_schema" to get the schema of builder options.',
            inputSchema: {
                uid: uidSchema,
                options: z.record(z.string(), z.unknown()).describe(
                    'Builder options object. Use eide_get_builder_opts to read the current structure.'
                )
            }
        },
        async (args) => delegateToolCall('eide_set_builder_opts', args)
    );

    server.registerTool(
        'eide_get_stack_usage',
        {
            title: 'Get Stack Usage',
            description: 'Get per-function stack frame usage from the last successful build, sorted from largest to smallest. Requires the project to be built with -fstack-usage.',
            inputSchema: {
                uid: uidSchema,
                topN: z.number().int().min(1).max(500).optional().describe(
                    'Maximum number of functions to return (default: 20).'
                )
            }
        },
        async (args) => delegateToolCall('eide_get_stack_usage', args)
    );

    server.registerTool(
        'eide_query_callgraph',
        {
            title: 'Query Callgraph',
            description: 'Query callers and callees of a symbol from the last successful build. Requires the project to be built with -fcallgraph-info.',
            inputSchema: {
                uid: uidSchema,
                symbol: z.string().min(1).describe('Function/symbol name to query.'),
                depth: z.number().int().min(1).max(6).optional().describe(
                    'Traversal depth in each direction (default: 2).'
                )
            }
        },
        async (args) => delegateToolCall('eide_query_callgraph', args)
    );

    if (options.debugTools) {
        const addressSchema = z.union([z.string(), z.number().int().nonnegative()]);
        const debugDescription = (description: string): string =>
            `${description} Call this over the stdio transport (eide-mcp --project <dir>); over HTTP it returns UnsupportedTransport, which means switch transports rather than that the tool is unavailable.`;

        server.registerTool(
            'eide_debug_connect',
            {
                title: 'Connect Debugger',
                description: debugDescription('Start a GDB/MI debug session for the project. The session is kept until disconnect or server exit.'),
                inputSchema: {
                    uid: uidSchema,
                    target: z.string().min(1).describe('Remote target, for example "localhost:3333".'),
                    elf: z.string().optional().describe('ELF file path (default: project build output).'),
                    gdbPath: z.string().optional().describe('GDB executable path.'),
                    mode: z.enum(['remote', 'extended-remote']).optional().describe(
                        'GDB remote mode (default: extended-remote).')
                }
            },
            async (args) => delegateToolCall('eide_debug_connect', args)
        );

        server.registerTool(
            'eide_debug_disconnect',
            {
                title: 'Disconnect Debugger',
                                description: debugDescription('Close the active GDB/MI debug session.'),
                inputSchema: { uid: uidSchema }
            },
            async (args) => delegateToolCall('eide_debug_disconnect', args)
        );

        server.registerTool(
            'eide_debug_read_register',
            {
                title: 'Read Register',
                                description: debugDescription('Read a CPU register from the active debug session.'),
                inputSchema: {
                    uid: uidSchema,
                    name: z.string().min(1).describe('CPU register name, for example "pc" or "r0".')
                }
            },
            async (args) => delegateToolCall('eide_debug_read_register', args)
        );

        server.registerTool(
            'eide_debug_read_memory',
            {
                title: 'Read Memory',
                                description: debugDescription('Read target memory and return it as a hexadecimal string.'),
                inputSchema: {
                    uid: uidSchema,
                    address: addressSchema.describe('Start address (number or 0x-prefixed string).'),
                    length: z.number().int().min(1).max(1048576).describe('Number of bytes.')
                }
            },
            async (args) => delegateToolCall('eide_debug_read_memory', args)
        );

        server.registerTool(
            'eide_debug_write_memory',
            {
                title: 'Write Memory',
                                description: debugDescription('Write hexadecimal bytes to target memory.'),
                inputSchema: {
                    uid: uidSchema,
                    address: addressSchema.describe('Start address (number or 0x-prefixed string).'),
                    hex: z.string().regex(/^[0-9a-fA-F]+$/).describe(
                        'Even-length hexadecimal byte string.')
                }
            },
            async (args) => delegateToolCall('eide_debug_write_memory', args)
        );

        server.registerTool(
            'eide_debug_set_breakpoint',
            {
                title: 'Set Breakpoint',
                                description: debugDescription('Insert a software or hardware breakpoint.'),
                inputSchema: {
                    uid: uidSchema,
                    location: z.string().min(1).describe('Function, file:line, or address.'),
                    hardware: z.boolean().optional().describe('Use a hardware breakpoint.'),
                    condition: z.string().optional().describe('Optional condition expression.')
                }
            },
            async (args) => delegateToolCall('eide_debug_set_breakpoint', args)
        );

        server.registerTool(
            'eide_debug_remove_breakpoint',
            {
                title: 'Remove Breakpoint',
                                description: debugDescription('Remove a breakpoint by its numeric id.'),
                inputSchema: {
                    uid: uidSchema,
                    id: z.number().int().positive().describe('Breakpoint id.')
                }
            },
            async (args) => delegateToolCall('eide_debug_remove_breakpoint', args)
        );

        server.registerTool(
            'eide_debug_backtrace',
            {
                title: 'Get Backtrace',
                                description: debugDescription('Get the current call stack from the active debug session.'),
                inputSchema: {
                    uid: uidSchema,
                    maxDepth: z.number().int().min(1).max(200).optional().describe(
                        'Maximum number of frames to return (default: all frames).')
                }
            },
            async (args) => delegateToolCall('eide_debug_backtrace', args)
        );

        server.registerTool(
            'eide_debug_list_breakpoints',
            {
                title: 'List Breakpoints',
                                description: debugDescription('List breakpoints with type, enabled state, address, source location, condition, hit count, and multiple locations when present.'),
                inputSchema: { uid: uidSchema }
            },
            async (args) => delegateToolCall('eide_debug_list_breakpoints', args)
        );

        server.registerTool(
            'eide_debug_list_threads',
            {
                title: 'List Threads',
                                description: debugDescription('List target threads with id, target id, name, state, and current frame.'),
                inputSchema: { uid: uidSchema }
            },
            async (args) => delegateToolCall('eide_debug_list_threads', args)
        );

        server.registerTool(
            'eide_debug_select_thread',
            {
                title: 'Select Thread',
                                description: debugDescription('Switch the debugger to a thread by id and return its current frame.'),
                inputSchema: {
                    uid: uidSchema,
                    id: z.number().int().positive().describe('Thread id from eide_debug_list_threads.')
                }
            },
            async (args) => delegateToolCall('eide_debug_select_thread', args)
        );

        server.registerTool(
            'eide_debug_select_frame',
            {
                title: 'Select Stack Frame',
                                description: debugDescription('Select a stack frame on the current thread before evaluating variables.'),
                inputSchema: {
                    uid: uidSchema,
                    level: z.number().int().nonnegative().describe(
                        'Frame level from eide_debug_backtrace; 0 is the innermost frame.')
                }
            },
            async (args) => delegateToolCall('eide_debug_select_frame', args)
        );

        server.registerTool(
            'eide_debug_list_variables',
            {
                title: 'List Variables',
                                description: debugDescription('List local variables and arguments for the current or selected thread and frame.'),
                inputSchema: {
                    uid: uidSchema,
                    threadId: z.number().int().positive().optional().describe(
                        'Thread id; omit to use the thread currently selected in GDB.'),
                    frameLevel: z.number().int().nonnegative().optional().describe(
                        'Frame level within threadId; omit to use the frame currently selected in GDB. Requires threadId.')
                }
            },
            async (args) => delegateToolCall('eide_debug_list_variables', args)
        );

        server.registerTool(
            'eide_debug_continue',
            {
                title: 'Continue Execution',
                                description: debugDescription('Resume the target and wait for the next stop event. A stop flagged `stale: true` is suspected residue from before the resume; resume again.'),
                inputSchema: {
                    uid: uidSchema,
                    stopTimeoutMs: stopTimeoutSchema
                }
            },
            async (args) => delegateToolCall('eide_debug_continue', args)
        );

        server.registerTool(
            'eide_debug_step_over',
            {
                title: 'Step Over',
                                description: debugDescription('Step over the current source line and wait for the next stop event. A stop flagged `stale: true` is suspected residue from before the step; step again.'),
                inputSchema: {
                    uid: uidSchema,
                    stopTimeoutMs: stopTimeoutSchema
                }
            },
            async (args) => delegateToolCall('eide_debug_step_over', args)
        );

        server.registerTool(
            'eide_debug_step_into',
            {
                title: 'Step Into',
                                description: debugDescription('Step into the next function call and wait for the next stop event. A stop flagged `stale: true` is suspected residue from before the step; step again.'),
                inputSchema: {
                    uid: uidSchema,
                    stopTimeoutMs: stopTimeoutSchema
                }
            },
            async (args) => delegateToolCall('eide_debug_step_into', args)
        );

        server.registerTool(
            'eide_debug_step_out',
            {
                title: 'Step Out',
                                description: debugDescription('Run until the current function returns and wait for the next stop event. A stop flagged `stale: true` is suspected residue from before the step; step again.'),
                inputSchema: {
                    uid: uidSchema,
                    stopTimeoutMs: stopTimeoutSchema
                }
            },
            async (args) => delegateToolCall('eide_debug_step_out', args)
        );

        server.registerTool(
            'eide_debug_interrupt',
            {
                title: 'Interrupt Execution',
                                description: debugDescription('Interrupt the running target.'),
                inputSchema: { uid: uidSchema }
            },
            async (args) => delegateToolCall('eide_debug_interrupt', args)
        );

        server.registerTool(
            'eide_debug_evaluate',
            {
                title: 'Evaluate Expression',
                                description: debugDescription('Evaluate an expression in the target context.'),
                inputSchema: {
                    uid: uidSchema,
                    expression: z.string().min(1).describe('Expression to evaluate.')
                }
            },
            async (args) => delegateToolCall('eide_debug_evaluate', args)
        );

        server.registerTool(
            'eide_debug_fault',
            {
                title: 'Decode Cortex Fault',
                                description: debugDescription('Decode Cortex-M fault status registers. Reads the memory-mapped SCB registers HFSR/CFSR/MMAR/BFAR from the active session when values are omitted; supplying hfsr/cfsr/... switches to offline decoding. When stopped in a HardFault/exception handler, also returns exception with stack (MSP/PSP), stacked frame, faultLocation (stacked PC, the jumped-to bad address), and callerLocation (stacked LR-1, the call site to fix)., the call site to fix). Outside an exception handler, exception is null and exceptionUnavailable explains why.'),
                inputSchema: {
                    uid: uidSchema,
                    hfsr: z.number().int().nonnegative().optional(),
                    cfsr: z.number().int().nonnegative().optional(),
                    mmar: z.number().int().nonnegative().optional(),
                    bfar: z.number().int().nonnegative().optional()
                }
            },
            async (args) => delegateToolCall('eide_debug_fault', args)
        );

        server.registerTool(
            'eide_debug_svd_lookup',
            {
                title: 'Lookup SVD',
                                description: debugDescription('Look up a peripheral or register from an SVD file by address, peripheral name, or register name.'),
                inputSchema: {
                    uid: uidSchema,
                    path: z.string().min(1).describe('SVD file path, relative to the project root.'),
                    address: addressSchema.optional(),
                    peripheral: z.string().optional(),
                    register: z.string().optional()
                }
            },
            async (args) => delegateToolCall('eide_debug_svd_lookup', args)
        );
    }

    return server;
}
