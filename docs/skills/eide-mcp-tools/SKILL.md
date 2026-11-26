---
name: eide-mcp-tools
version: 4.3.2
description: >-
  Operate EIDE Pro embedded MCU projects through MCP tools: build, rebuild,
  clean, flash, project configuration, stack usage, callgraph, and GDB
  debugging. Use whenever the user mentions EIDE Pro, EIDE MCP, eide-mcp,
  headless firmware builds, MCU build/flash/debug automation, or the MCP
  endpoint at localhost:8940 — even if they do not explicitly say "MCP".
---

# EIDE Pro MCP Tools

The `version` in the frontmatter is the EIDE Pro release this skill describes.
Compare it with `eide-mcp --version` (or the extension version in VS Code): if
they differ, the copy you are reading is stale — refresh it with
`eide-mcp --print-skill > <path-to-this-file>`.

Prefer the EIDE MCP tools over shell commands or direct `.eide/eide.yml` edits.
The tools preserve EIDE invariants such as target-level config, dependency
groups, env.ini expansion, and virtual source folders.

## 1. Identify the server mode

Both transports expose the **same tool set**, and every tool is usable. They
differ only in which transport a call must go through.

| Mode | How it is configured | Requires VS Code | Executes in |
|------|----------------------|------------------|-------------|
| VS Code HTTP MCP | `http://localhost:8940/mcp` plus `EIDE.MCP.Server.Enable` | Yes, with the project open | The running extension |
| Headless stdio MCP | `eide-mcp --project ...` from the headless package | No | Its own process |

**Debug tools need the stdio transport.** A GDB session is stateful — it has to
stay attached to one long-lived process — and the HTTP request path is
stateless, so it cannot hold one. Over HTTP the debug tools are still listed,
but calling one returns `UnsupportedTransport`:

```json
{"success":false,"error":{"kind":"config","name":"UnsupportedTransport",
  "message":"This tool needs the stdio transport. Start eide-mcp --project <dir> and call it there."}}
```

Treat that as "use the other transport", not as "this tool is unavailable".
When a task needs debugging, connect over stdio and call the same tools there.

The headless server discovers its projects from launch arguments, so there is
no "add project" tool.

Headless launch:

```json
{
  "mcpServers": {
    "eide-pro": {
      "command": "eide-mcp",
      "args": [
        "--project", "/path/to/firmware",
        "--toolchain-path", "/opt/gcc-arm-none-eabi"
      ]
    }
  }
}
```

Add `--gdb /path/to/gdb` when the GDB executable is not `arm-none-eabi-gdb` on
`PATH`.

Install the standalone package from a GitHub Release:

```bash
npm install -g ./eide-pro-headless-<version>.tgz
```

Useful headless options: repeatable `--project`, `--target`, `--settings`
(JSON file with `EIDE.*` values), `--gdb`, `--flasher-exe`,
`--build-timeout`, `--flash-timeout`. A project managed by xpack does not need
`--toolchain-path`; EIDE resolves the compiler from `package.json` and
`xpacks/`. The skill ships with the headless package
(`skills/eide-mcp-tools/SKILL.md` inside the package) and can be printed with
`eide-mcp --print-skill`.

## 1.5 Reading results

Every tool result provides the JSON payload twice: as `structuredContent`
(preferred) and as the same JSON in `content[0].text`. Prefer
`structuredContent`; treat `isError: true` as failure. `structuredContent` is
always a JSON object: tools that answer a list wrap it as `{ "items": [...] }`.

## 2. Rules that prevent most failures

1. **Check the environment before claiming a tool is missing.** Call
   `eide_get_environment` and read the `source` of each entry: `settings`,
   `toolchain-path`, `project-config`, `path`, `xpack`, or `not-found`. Only
   when an entry is `not-found` **and** `searched` is non-empty may you tell the
   user that the tool is absent — and say which locations were searched.
   Never report "no toolchain" without calling this tool first.
2. **Always obtain the real project UID.** Read `miscInfo.uid` from
   `<project>/.eide/eide.yml`. `uid` is optional in single-project headless
   mode; required in multi-project headless and VS Code HTTP mode. Do not
   invent one: a UID that does not match a loaded project resolves to
   "Not such project".
3. **Call tools sequentially.** The headless server queues calls internally,
   but sequential `get → set → verify` is easier to reason about and avoids
   overlapping long builds.
4. **Prefer tools over YAML.** Use the matching `eide_get_*` first, then the
   setter. For example: `eide_get_defines` → edit array → `eide_set_defines`.
5. **Headless reads `eide.yml` on each call.** Manual edits are visible to the
   next tool call, and `eide_reload` is a no-op there. In VS Code mode, call
   `eide_reload` after manual edits.
6. **Do not flatten EIDE features into defines/includes.** `.eide/env.ini`,
   virtual source folders, `dependenceList`, and `.eide/files.options.yml` are
   already consumed by the build pipeline in both modes.
7. **Use overrides for one-off builds, not permanence.** Any non-empty
   `overrides` object forces a rebuild. Persist settings with the config tools
   when the change should survive.
8. **`eide_set_builder_opts` replaces the whole options object.** Read it,
   modify the returned structure, and send the complete object back.
9. **Include and source paths must stay inside the project.** The setters
   normalize paths and reject paths outside the project root.
10. **`eide_switch_target` is session-local in headless mode.** It changes the
   target used by later headless calls but does not rewrite `eide.yml`; pass
   the target explicitly when starting the server if the target must be fixed.

## 3. Build, flash, and clean

| Tool | Arguments | Notes |
|------|-----------|-------|
| `eide_build` | `uid`, `overrides?`, `dryRun?` | Incremental unless overrides are supplied. |
| `eide_rebuild` | `uid`, `overrides?`, `dryRun?` | Full rebuild. |
| `eide_clean` | `uid` | Removes the target output directory. |
| `eide_flash` | `uid`, `eraseAll` (required boolean); headless also accepts `artifact?`, `verify?`, `dryRun?` | Uses the project's uploader and configured flasher. |
| `eide_reload` | `uid` | Useful in VS Code mode; no-op in headless mode. |

Typical loop:

```text
eide_build(uid)                 → inspect success/problems/logTail
eide_flash(uid, eraseAll=false) → only after a successful build
```

Headless flash accepts `artifact` (one or more `path[,address]` entries
separated by `;`), `verify`, and `dryRun`. `dryRun=true` returns
`{ success, dryRun: true, uploader, invocation, verify, eraseAll, programs }`
without touching hardware (`invocation` holds the planned `executable`, `args`,
and command `script`) but still requires the configured flasher executable.
`artifact` cannot be combined with `eraseAll=true`. In VS Code mode a dry-run
returns the same plan when it can be constructed, plus `command` rendered as a
single command line; when the uploader is not supported by the plan layer or the
flash configuration is incomplete, the result still stays off the hardware and
explains itself in `planningError`.

A non-dry-run build returns JSON with `success`, `buildId`, `configHash`,
`stage`, `problems`, `memory`, `artifacts`, `compileCommands` (when
generated), `effectiveConfig`, and `logTail` on failure. On failure,
`artifacts` is always empty — never flash from `artifacts[0]` after a failed
build — and `failureKind` is `build`, `timeout`, or `signal`. Treat
`isError: true` as failure and read the text content even when the JSON shape
is unexpected.

Failures carry an `error` envelope: `{"success":false,"command":<name or
null>,"error":{"kind","name","message"}}`. `error.kind` decides the next
move: `usage` — fix the arguments; `config` — fix project or environment
configuration; `tool` — install or repair the external tool; `internal` —
report it as a bug.

### Build result example

```json
{
  "success": true,
  "stage": "link",
  "problems": [],
  "memory": { "FLASH": { "used": 1148, "size": 131072, "percent": 0.88 },
              "RAM": { "used": 284, "size": 20480, "percent": 1.39 } },
  "artifacts": ["build/Debug/demo.elf", "build/Debug/demo.hex"],
  "compileCommands": "build/Debug/compile_commands.json",
  "effectiveConfig": {
    "target": "Debug",
    "toolchain": "GCC",
    "defines": ["USE_HAL"],
    "includeDirs": ["inc"]
  }
}
```

`problems` entries contain `file`, `line`, `column`, `severity`, `code`, and
`message`. On failure, `logTail` contains the compiler/linker tail even when
no `compiler.log` was produced.

### `dryRun`

`eide_build(uid, dryRun=true)` writes `builder.params` and returns `buildId`,
`outDir`, `builder`, `args`, `paramsFile`, and the full `params` object.

Use it to verify overrides, include paths, dependency expansion, and env.ini
values before spending time on a build.

### Build overrides

| Field | Meaning |
|-------|---------|
| `defines` | Extra defines, appended uniquely. |
| `includeDirs`, `libDirs` | Extra search paths, appended uniquely. |
| `cFlags`, `cxxFlags`, `asmFlags`, `ldFlags` | Strings appended to the matching flag. |
| `options` | Deep patch of builder model options. |
| `source.include`, `source.exclude` | Micromatch globs applied to the physical source list. |
| `env` | Extra project environment values. |

Because overrides force a rebuild, do not combine `eide_build` with overrides
when the user only wants an incremental build.

## 4. Project configuration

All of these require `uid`.

| Tool | Extra arguments | Effect |
|------|-----------------|--------|
| `eide_get_targets` | — | `{ actived, targets }` |
| `eide_get_environment` | `target?` | Resolved tool paths with their `source` and the `searched` evidence chain |
| `eide_switch_target` | `targetName` | Select active target |
| `eide_get_src_dirs` | — | `{ items }`: source root list |
| `eide_add_src_dir` | `path` | Add a source root |
| `eide_del_src_dir` | `path` | Remove a source root |
| `eide_exclude_src_file` | `path` | Add file to target exclude list |
| `eide_include_src_file` | `path` | Remove file from exclude list |
| `eide_get_inc_dirs` | — | `{ items }`: target `cppPreprocessAttrs.incList` |
| `eide_set_inc_dirs` | `paths[]` | Replace target include list |
| `eide_get_defines` | — | `{ items }`: target `cppPreprocessAttrs.defineList` |
| `eide_set_defines` | `defines[]` | Replace target define list |
| `eide_get_builder_opts_schema` | `path?` | Schema subtree for `path`; without `path`, only top-level keys with descriptions |
| `eide_get_builder_opts` | — | Current toolchain options |
| `eide_set_builder_opts` | `options{}` | Replace toolchain options |

`eide_get_inc_dirs` and `eide_get_defines` expose the target's own lists, not
the merged dependency lists. Dependencies and build-in values still participate
in the build automatically.

Headless and VS Code MCP both resolve the builder-options schema from the
project's active toolchain in the extension `lang` directory. `eide_set_builder_opts`
validates against that schema before saving, so call `eide_get_builder_opts_schema`
without `path` first to see the top-level keys (a compact list with
descriptions, not the full schema), then call it again with the desired
dot-separated `path` to fetch that subtree before sending the complete options
object. An unknown `path` fails with a `ConfigError`.

## 5. Build analysis

| Tool | Arguments | Requires |
|------|-----------|----------|
| `eide_get_stack_usage` | `uid`, `topN?` (1–500, default 20) | Build with `-fstack-usage` |
| `eide_query_callgraph` | `uid`, `symbol`, `depth?` (1–6, default 2) | Build with `-fcallgraph-info` |

Both read `statistic.json` from the last successful build. If it is missing,
enable the corresponding compiler options with `eide_set_builder_opts` and
rebuild.

## 6. Debugging (use the stdio transport)

These tools are backed by a persistent GDB/MI session, so they must be called
over the stdio transport (`eide-mcp --project <dir> [--gdb <path>]`). Over HTTP
they return `UnsupportedTransport` — switch transports and call them there,
rather than treating them as unavailable.

Build the project before connecting; the default ELF is
`<project>/<outDir>/<target>/<projectName>.elf`.

| Tool | Arguments |
|------|-----------|
| `eide_debug_connect` | `uid`, `target` (for example `localhost:3333`), `elf?`, `gdbPath?`, `mode?` (`extended-remote` default or `remote`) |
| `eide_debug_disconnect` | `uid` |
| `eide_debug_read_register` | `uid`, `name` (for example `pc`, `cfsr`) |
| `eide_debug_read_memory` | `uid`, `address`, `length` (1–1048576 bytes) |
| `eide_debug_write_memory` | `uid`, `address`, even-length `hex` |
| `eide_debug_set_breakpoint` | `uid`, `location` (symbol, `file:line`, or address), `hardware?`, `condition?` |
| `eide_debug_remove_breakpoint` | `uid`, `id` |
| `eide_debug_backtrace` | `uid`, `maxDepth?` (1–200, default all frames) |
| `eide_debug_list_breakpoints` | `uid` |
| `eide_debug_list_threads` | `uid` | 
| `eide_debug_select_thread` | `uid`, `id` |
| `eide_debug_select_frame` | `uid`, `level` (0 is innermost) |
| `eide_debug_list_variables` | `uid`, optional `threadId`, `frameLevel` |
| `eide_debug_continue` | `uid`, `stopTimeoutMs?` (default 30000) |
| `eide_debug_step_over` | `uid`, `stopTimeoutMs?` |
| `eide_debug_step_into` | `uid`, `stopTimeoutMs?` |
| `eide_debug_step_out` | `uid`, `stopTimeoutMs?` |
| `eide_debug_interrupt` | `uid` |
| `eide_debug_evaluate` | `uid`, `expression` |
| `eide_debug_fault` | `uid`, optional `hfsr`, `cfsr`, `mmar`, `bfar` |
| `eide_debug_svd_lookup` | `uid`, `path` (relative SVD path), plus `address?` or `peripheral?` or `register?` |

Addresses accept a number or a `0x`-prefixed string. `eide_debug_fault` reads
HFSR/CFSR/MMAR/BFAR from the active session when values are omitted.
When stopped in a HardFault/exception handler, its `exception` adds the selected
stack (MSP/PSP), stacked `frame`, `faultLocation` for the bad jumped-to PC, and
`callerLocation` for stacked LR-1 (the call site to fix); otherwise `exception`
is null with `exceptionUnavailable`. Passing hfsr/cfsr/... is offline decoding.
`eide_debug_backtrace` returns `{ items }` with frames carrying level, address,
and optional function/file/line/fullname. `eide_debug_list_breakpoints` returns
`{ items }` with breakpoint type, enabled state, address, source location,
condition, hit count, and nested locations for multi-location breakpoints. `eide_debug_list_threads` returns
`threads` and `currentThreadId`; `eide_debug_list_variables` returns local
variables and arguments for the selected thread/frame, and a `frameLevel`
argument requires the matching `threadId`. The step
tools and `eide_debug_continue` return only stop events that happen after the
resume call; a stop that repeats the pre-resume PC without a breakpoint,
watchpoint, or step result is flagged `stale: true` (a gdbstub can re-report
its initial halt). Resume again when that flag is set. The session stays
active until disconnect or server exit; only one session can exist at a time.

Minimal debug loop (read frame variables only after `select_frame`):

```text
eide_debug_connect(uid, target="localhost:3333")
eide_debug_set_breakpoint(uid, location="main.c:42")
eide_debug_continue(uid)                  # returns the stop at the breakpoint
eide_debug_select_frame(uid, level=0)     # required before list_variables
eide_debug_list_variables(uid)
eide_debug_backtrace(uid, maxDepth=20)
eide_debug_disconnect(uid)
```

Full tool reference:

```text
eide_debug_connect(uid, target="localhost:3333")
eide_debug_set_breakpoint(uid, location="main")
eide_debug_continue(uid)
eide_debug_list_threads(uid)
eide_debug_select_frame(uid, level=0)
eide_debug_list_variables(uid)
eide_debug_backtrace(uid, maxDepth=20)
eide_debug_step_over(uid) / eide_debug_step_into(uid) / eide_debug_step_out(uid)
eide_debug_list_breakpoints(uid)
eide_debug_read_register(uid, name="pc")
eide_debug_evaluate(uid, expression="counter")
eide_debug_fault(uid)
eide_debug_disconnect(uid)
```

## 7. Common workflows

### Diagnose a HardFault

```text
1. eide_debug_connect(uid, target=...)
2. eide_debug_set_breakpoint(uid, location="HardFault_Handler", hardware=false)
3. eide_debug_continue(uid)
4. eide_debug_fault(uid)
5. Read exception.callerLocation.file/line: this is the call site to fix.
   exception.faultLocation is the bad address jumped into, usually not the line to edit.
   reasons containing FORCED mean another fault escalated to HardFault.
```

### Change a define and rebuild

```text
1. eide_get_defines(uid) → read the `items` array
2. eide_set_defines(uid, [...existing, "FEATURE=1"])
3. eide_rebuild(uid)
```

### Add an include directory

```text
1. eide_get_inc_dirs(uid) → read the `items` array
2. eide_set_inc_dirs(uid, [...existing, "vendor/inc"])
3. eide_build(uid)
```

### Add a source folder and verify compilation

```text
1. eide_add_src_dir(uid, "src/new_module")
2. eide_get_src_dirs(uid)
3. eide_build(uid)
```

### Test a one-off feature without changing the project

```text
1. eide_build(uid, dryRun=true, overrides={defines:["FEATURE=1"]})
2. eide_build(uid, overrides={defines:["FEATURE=1"]})
3. inspect problems/artifacts
```

### Modify a file-level option or env.ini manually

- Headless: edit the file, then call the next tool normally. `eide_reload` is
  available but does not change headless behavior.
- VS Code: edit the file, then call `eide_reload(uid)` and wait for success.
- Before editing `eide.yml`, use tools if one exists. Never invent keys or
  change `deviceName`/`packDir` unless the user explicitly asks.

## 8. Troubleshooting

| Symptom | Cause and action |
|---------|------------------|
| `Not such project (uid=...)` | UID mismatch, or multiple headless projects and the UID belongs to another project. Re-read `miscInfo.uid`. |
| `Toolchain 'X' is not installed or its path is not configured` | Pass `--toolchain-path` or `--settings` to headless, or configure the toolchain in VS Code. |
| `gcc is not available from xpack` | Run `xpm install` in the project directory, or stop using the xpack path. |
| `Builder options schema not found` | The extension `lang` directory is incomplete or the toolchain has no schema file; verify `lang/<toolchain>.verify.json`. |
| VS Code MCP connection refused | VS Code is not running or the project is not open; check `EIDE.MCP.Server.Enable` and port 8940. |
| Headless MCP process exits | Read the server's stderr; usually invalid `--project`, bundled resources, or project config. |
| `A debug session is already active` | Call `eide_debug_disconnect` before connecting again. |
| Stack/callgraph data missing | Rebuild with `-fstack-usage` / `-fcallgraph-info`. |
| Path rejected by a config setter | The path resolves outside the project root; add the file/folder inside the project or use a build override. |

Do not silently fall back to shell build/flash when MCP fails. Report the MCP
error and fix the server or project configuration.
