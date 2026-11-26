# Headless CLI and MCP

EIDE can build, flash, and debug projects without a running VS Code instance. The
headless host loads the same `.eide/eide.yml` project model and generates build
parameters with the same `CodeBuilder` used by the extension, so build behavior
matches VS Code: all project types, all registered toolchains, `.eide/env.ini`,
virtual source folders, dependency groups, per-file options, and builder
settings are supported.

## Two ways to run EIDE

| Entry point | Who uses it | Comes from | Prerequisites | Needs VS Code running |
| --- | --- | --- | --- | --- |
| VS Code extension (VSIX) | People, in the editor | Open VSX / GitHub Releases VSIX | .NET 6+ for the builder | Yes; the optional HTTP MCP server (port 8940, `EIDE.MCP.Server.Enable`) also requires an open project |
| `eide-cli` / `eide-mcp` | Scripts and AI agents | Separate npm package from GitHub Release assets (`eide-pro-headless-<version>.tgz`), not the npm registry | Node.js 18+, .NET 6+ (the builder is framework-dependent) | No |

Installing the extension does not put `eide-cli` on your PATH — that is
expected, not a failed install. The extension offers to install these tools:
it checks for Node.js and .NET first, then downloads the matching release
package for the installed extension version.

For troubleshooting you can run the bundles shipped inside the extension
directory (`node <extension-dir>/dist/eide_cli.js …`; kept by
`.vscodeignore:30-31`). This is a stopgap, not an install method: it depends
on the `res/` directory inside that extension folder, and updating the
extension replaces the directory. For anything long-lived, install the
standalone package.

## Install

Download `eide-pro-headless-<version>.tgz` from
[GitHub Releases](https://github.com/wuwuzhazha/eide-pro/releases), then install it
globally:

```bash
npm install -g ./eide-pro-headless-<version>.tgz
```

The package contains `eide-cli`, `eide-mcp`, the toolchain models, and the
builder binaries for Windows x64, Linux x64, and macOS. It does not require VS
Code. `--resources` defaults to the bundled `res` directory; pass it explicitly
only when using a separate extension installation or a development tree.

## Requirements

- Node.js 18+
- .NET 6+ runtime (the bundled builder is framework-dependent)
- A toolchain installed and configured for the target
- A project initialized by EIDE (`miscInfo.uid` is present in `.eide/eide.yml`)
- `--project` points at the directory containing `.eide/eide.yml`

## CLI

Create a project from a built-in template:

```bash
eide-cli create --name firmware --template stm32f1xx_gcc --output ./projects
```

The created directory contains a migrated `.eide/eide.yml` at the current
config version, a fresh `miscInfo.uid`, and a renamed `.code-workspace`. It is
ready for `eide-cli build` without opening VS Code. Available templates:

| Template | Type |
| --- | --- |
| `stm32f1xx_gcc` | ARM (STM32F103, GCC) |
| `gd32vf103_riscv` | RISC-V |
| `mcs51_sdcc`, `stc15_sdcc` | 8051 (SDCC) |
| `stm8_cosmic_empty`, `stm8s_cosmic`, `stm8s_sdcc` | STM8 |
| `avr_atmega128_rtos` | ANY-GCC (AVR) |

`--project-name` overrides the display name; `--output` defaults to the current
directory. `--resources` defaults to the bundled package resources.

Build (incremental):

```bash
eide-cli build \
  --project ./firmware \
  --toolchain-path /opt/gcc-arm-none-eabi
```

Rebuild with per-invocation parameters:

```bash
eide-cli build \
  --project ./firmware \
  --toolchain-path "C:/Program Files (x86)/GNU Arm Embedded Toolchain/10 2021.10" \
  --mode rebuild \
  -D FEATURE_LOG=1 \
  --cflag -O2 \
  --include ./extra-include
```

Generate the build plan without compiling:

```bash
eide-cli plan --project ./firmware --toolchain-path ./gcc
```

Clean the target output directory:

```bash
eide-cli clean --project ./firmware
```

Flash with a project uploader (JLink in this example):

```bash
eide-cli flash \
  --project ./firmware \
  --flasher-exe "C:/Program Files/SEGGER/JLink/JLink.exe"
```

Erase the chip, or inspect the flash command without touching hardware:

```bash
eide-cli flash --project ./firmware --flasher-exe ./JLink.exe --erase-all
eide-cli flash --project ./firmware --flasher-exe ./JLink.exe --dry-run
```

Options:

| Option | Meaning |
| --- | --- |
| `-p, --project <dir>` | Project root (required) |
| `--workspace <file>` | `.code-workspace` file instead of the project directory |
| `-t, --target <name>` | Build target |
| `--mode incremental\|rebuild` | Build mode |
| `--dry-run` | Return the plan/command without executing |
| `-D, --define <NAME[=VAL]>` | Extra preprocessor define (repeatable) |
| `--include`, `--lib` | Extra include/library directory (repeatable) |
| `--cflag`, `--cxxflag`, `--asmflag`, `--ldflag` | Extra compiler/linker flags (repeatable) |
| `--resources <dir>` | EIDE `res` directory (default: bundled package `res`) |
| `--extension-root <dir>` | Extension root containing `package.json` and `res` (default: parent of `--resources`) |
| `--settings <file>` | JSON file with `EIDE.*` settings overrides, merged after `.code-workspace` settings |
| `--toolchain-path <dir>` | Toolchain installation directory (see below) |
| `--timeout <ms>` | Operation timeout (build 30 min, flash 2 min by default) |
| `--threads <n>` | Build worker threads (default: EIDE setting) |
| `--flasher-exe <path>` | Flash tool executable; required for JLink/OpenOCD/STLink |
| `--erase-all` | Chip erase instead of programming |
| `--verify`, `--no-verify` | Verification is the default where the tool supports it; `--no-verify` skips it and is rejected for JLink, which always verifies |
| `--artifact <path[,addr]>` | Override the programmed artifact |

All commands print one JSON object to stdout, including failures. Logs go to
stderr. Every failure prints
`{"success":false,"command":<name or null>,"error":{"name","message","kind"}}`,
where `kind` is `usage` (invalid invocation), `config` (project configuration or
environment, including an invalid `--toolchain-path`), `tool` (the external tool
could not be started), or `internal` (unhandled failure). Usage errors also print
the message and the usage text to stderr.
`create` has its own options (`--name`, `--template`, `--output`,
`--project-name`) and does not use the build options above.

`--toolchain-path` is mapped to the toolchain's normal `EIDE.*` install setting:
the toolchain root for most compilers (the executable folder is derived as
`bin`, `stm8/bin`, or the folder itself for COSMIC STM8), and the `TOOLS.INI`
or `uv4.exe` path for Keil C51. Use `--settings` to set any toolchain setting
explicitly instead.

```json
{
  "EIDE.ARM.GCC.InstallDirectory": "/opt/gcc-arm-none-eabi",
  "EIDE.Builder.ThreadNumber": 8
}
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Build or flash operation failed |
| `3` | Invalid invocation, project configuration, or unsupported request (`error.kind` is `usage` or `config`) |
| `4` | Failed to start the external tool (`error.kind` is `tool`) or unhandled failure (`error.kind` is `internal`) |

Build results contain `success`, `buildId` (unique per build), `configHash`,
`stage`, `problems`, `memory`, `artifacts` (empty when the build fails),
`failureKind` (`build`, `timeout`, or `signal`, on failure),
`compileCommands` (when the builder produced `compile_commands.json`),
`effectiveConfig`, and `logTail` on failure. `plan` results contain
`configHash` and the builder invocation, but no `buildId`. A manifest is written to
`<outDir>/<target>/build-manifest.json`. The compiler database can be fed
directly to clangd or other language servers.

A successful `flash --dry-run` returns `dryRun: true`, `uploader`, `verify` (the verification that will run),
`eraseAll`, `programs`, and `invocation` — the command object with `executable`, `args`,
and `script`. `command` carries only the command name.

The repository builds standalone entry scripts at `dist/eide_cli.js` and
`dist/eide_mcp.js` (`npm run webpack:headless`). The release package exposes the
same bundles as `eide-cli` and `eide-mcp`.

## Build parity

`eide-cli plan/build` and the MCP `eide_build`/`eide_rebuild` tools reuse the
extension's project loader and builder:

- `.eide/env.ini` variables are applied to defines, include paths, and the
  builder environment, including target-specific sections.
- Virtual source folders and physical source roots are scanned together.
- `dependenceList` groups (custom and installed package groups) contribute
  include paths, libraries, and defines.
- `.eide/files.options.yml` per-file compiler options and
  `alwaysBuildSourceFiles` are passed to the builder.
- `.code-workspace` `settings` and the `--settings` file provide `EIDE.*`
  settings; `--settings` takes precedence and `--threads` overrides the
  configured thread count.
- GCC-family toolchains installed through xpack are resolved from the
  project `package.json` and `xpacks/` directory like in VS Code.
- Dynamic `overrides` for defines, include/library paths, compiler/linker
  flags, builder options, source filters, and environment variables are
  applied to the generated `builder.params`; a non-empty override set forces
  a rebuild.

## MCP server (stdio)

```bash
eide-mcp \
  --project ./firmware \
  --toolchain-path ./gcc \
  --gdb ./gcc/bin/arm-none-eabi-gdb \
  --flasher-exe ./JLink.exe
```

MCP configuration example:

```json
{
  "mcpServers": {
    "eide-headless": {
      "command": "eide-mcp",
      "args": [
        "--project", "/path/to/firmware",
        "--toolchain-path", "/path/to/gcc",
        "--gdb", "/path/to/gcc/bin/arm-none-eabi-gdb"
      ]
    }
  }
}
```

The server exposes the same project/build tools as the VS Code MCP server:

- build/rebuild (with `overrides` and `dryRun`), clean, flash
- flash accepts the same `artifact`, `verify`, and `dryRun` inputs as the CLI
- targets, source dirs, include dirs, defines, builder options
- builder-options schema and validation for every registered toolchain
- stack usage and callgraph from `statistic.json`

The agent skill is shipped at `skills/eide-mcp-tools/SKILL.md` inside the headless package.
Run `eide-mcp --print-skill` to print it directly from the installed package.

It additionally exposes debug tools, backed by GDB/MI:

- `eide_debug_connect`, `eide_debug_disconnect`
- `eide_debug_read_register`, `eide_debug_read_memory`, `eide_debug_write_memory`
- `eide_debug_set_breakpoint`, `eide_debug_remove_breakpoint`
- `eide_debug_backtrace`, `eide_debug_list_breakpoints`
- `eide_debug_list_threads`, `eide_debug_select_thread`, `eide_debug_select_frame`
- `eide_debug_list_variables` (locals and arguments)
- `eide_debug_continue`, `eide_debug_step_over`, `eide_debug_step_into`, `eide_debug_step_out`
- `eide_debug_interrupt`, `eide_debug_evaluate`
- `eide_debug_fault` (Cortex-M fault register decoding)
- `eide_debug_svd_lookup` (peripheral/register lookup by address or name)

Tool calls are serialized. A debug session stays active until
`eide_debug_disconnect` or server exit. Each tool result provides the JSON
payload twice: as `structuredContent` and as the same JSON in `content[0].text`.

### Example agent session

Recorded against the `cortex-m3` fixture (toolchain paths omitted). `…` hides
fields not relevant to the step. When the server loads a single project, `uid`
is optional in tool arguments (it must still match that project when given);
`eide_flash` also requires `eraseAll`.

```jsonc
// eide_build { "uid": "headless-e2e" }
{ "success": true, "stage": "link", "problems": [], "artifacts": [ … 4 entries … ] }

// main.c loses a semicolon; eide_build { "uid": "headless-e2e" }
{ "success": false, "stage": "compile", "artifacts": [],
  "problems": [ { "severity": "error", "line": 1, "column": 30,
                  "message": "expected ';' before 'int'" } ] }

// semicolon restored; eide_build { "uid": "headless-e2e" }
{ "success": true, "stage": "link", "problems": [], "artifacts": [ … 4 entries … ] }

// eide_flash { "uid": "headless-e2e", "dryRun": true, "eraseAll": false }
{ "dryRun": true, "uploader": "JLink", "invocation": { "executable": "…/JLink.exe", "args": [ … ] } }
```

When a build fails, `artifacts` is empty; do not flash.

## Limits

- Flash support covers JLink, OpenOCD, pyOCD, STLink, and probe-rs.
  STVP, stcgal, and custom command uploaders fail explicitly.
- `eide_debug_svd_lookup` supports the SVD subset implemented in
  `src/core/debug/svd.ts`: peripheral/register/field `derivedFrom`, dimensions,
  address lookup, and field bit ranges. Enumerated values, clusters, and
  alternate register groups are not modeled.
