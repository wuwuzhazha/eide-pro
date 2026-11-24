# Migrating from EIDE

EIDE Pro is a fork of [EIDE](https://github.com/github0null/eide)
(`github0null/eide`). This page lists what changes for an existing EIDE user.

## Project format

EIDE Pro reads and writes the same `.eide/eide.yml` project file
(`src/EIDEProject.ts:835`); the headless host loads the same file
(`src/headless/host.ts:110`). Whether an upstream EIDE project opens in EIDE
Pro without manual steps is **unverified** — the migration path from older
config versions exists (`src/core/project_config_migration.ts`), but upstream
project samples were not tested.

## What EIDE Pro adds

- **Headless CLI and MCP** — `eide-cli` and `eide-mcp` build, plan, clean, and
  flash projects without VS Code. See [headless.md](./headless.md).
- **Agent debugging over GDB/MI** — the headless MCP server exposes connect,
  stepping, variables, registers, memory, fault decoding, and SVD lookup
  tools. See [headless.md](./headless.md).
- **CI setup** — prerequisites, first build, and a GitHub Actions example.
  See [ci.md](./ci.md).

## Known differences from upstream EIDE

Behavior changes documented in this repository's [CHANGELOG](../CHANGELOG.md):

- v4.0.0 — the extension identity is `wuwuzhazha.eide-pro` (`EIDE Pro`),
  not `github0null.eide` (or `cl.eide`).
- v4.0.0 — the obsolete simplified headless planner was removed; headless
  builds now reuse the VS Code `EIDEProject`/`CodeBuilder` path.
- v4.1.0 — `eide-cli` and `eide-mcp` default `--resources` to the bundled
  package `res` directory.
- v4.3.0 — project-config migration is shared by the VS Code path and
  `eide-cli create`; `create` assigns a fresh `miscInfo.uid`.

Headless limitations (VS Code extension still supports them): custom command
uploaders, STVP, and stcgal fail explicitly in the CLI and MCP — see the
[Limits section](./headless.md#limits) of the headless guide.
