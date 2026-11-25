# Keil / IAR / Eclipse import: verified status

Audit baseline `ead8d57`; verification baseline `9f97ce1`.

## Verified: Keil 5 import → headless build

`test/scripts/import-keil-e2e.test.ts` drives the real import entry
(`importKeilProject`, `src/EIDEProjectExplorer.ts`) against
`test/fixtures/keil-import/demo.uvprojx` (Cortex-M3, `STM32F103C8`, two source
groups, two sources, target/group/file defines, group include path), then:

1. asserts the import artifacts (`.eide/eide.yml`, `.eide/files.options.yml`,
   `.eide/env.ini`): `miscInfo.uid`, both sources in their groups, target define
   in `cppPreprocessAttrs.defineList`, group define + include path + file define
   in `files.options.yml`, no CMSIS/RTE artifacts for an empty `<RTE>` section;
2. loads the imported project headless (`AbstractProject.LoadForHeadless`),
   switches it from the imported `AC5` to `GCC` with `setToolchain` and sets the
   linker script — the same operation a user performs in the editor;
3. opens it through `openHeadlessProject` (proves the `miscInfo.uid` gate) and
   checks the build plan carries the imported sources, defines and per-file
   options;
4. runs a real `arm-none-eabi-gcc` build through `EideBuildService` and asserts
   exit success, `demo.elf` (ELF magic), `demo.hex`;
5. deletes `miscInfo.uid` and asserts `openHeadlessProject` rejects the project
   again.

The fixture sources are self-checking: `src/main.c` fails to compile with
`#error` when the target, group or file define is missing, and cannot find
`app_config.h` when the group include path is missing. A passing build therefore
proves those Keil semantics survived the import.

Run it with:

```
npm run compile && npm run compile:test
node out/tmp/test/scripts/import-keil-e2e.test.js
```

The real-build assertions need `arm-none-eabi-gcc` on `PATH` (or `ARM_GCC_DIR`
pointing at the toolchain install directory). Where the compiler is absent the
test prints `SKIPPED:` and still runs the import/open/plan assertions;
`EIDE_REQUIRE_ARM_GCC=1` turns the skip into a failure. No CI job currently runs
`test/run-tests.js` with the ARM GCC toolchain installed, so on the `npm test`
matrix the build assertions are skipped; the `headless-package` job that does
install `gcc-arm-none-eabi` does not run this suite.

## Fixed while verifying

- **Group-level options were dropped** (`src/KeilXmlParser.ts`, `ARMParser`).
  Keil keeps per-group `<GroupOption>/<GroupArmAds>/<Cads>/<VariousControls>`
  defines and include paths; the parser only read the target level and
  `<FileOption>`. Files in a group therefore compiled without the group's
  `-D`/`-I` flags. Group options are now merged into the per-file options
  (`files.options.yml`) of every file in the group, so their scoping is kept.
- **An empty `<RTE>` section was treated as an RTE project**
  (`src/KeilXmlParser.ts`, `ARMParser.ParseData`). `RTE.files` is present but
  empty in almost every Keil project, so the parser produced an empty
  `rte_deps` array, the importer entered its RTE branch, unpacked the CMSIS
  header packs into `<project>/.cmsis`, and added a `RTE/_<target>` include path
  that does not exist. `rte_deps` is now only set when the project really
  declares RTE files.

`miscInfo.uid` is written by the import itself (`ensureProjectUid` before
`prjConfig.Save()`), so the headless `uid` gate no longer blocks an imported
project.

## Still unverified

- **RTE dependency resolution**: the fixture declares no RTE components, so
  `importCmsisHeaders`, instance resolution, `RTE/_<target>` includes and the
  `keil.importer.warning.txt` report for unresolved dependencies never execute in
  the test.
- **Keil semantics beyond defines/includes**: undefines, per-file/group
  `MiscControls`, disabled groups/files (`excludeList`), Keil user build
  commands (before/after make), output name/directory (`env.ini`) are imported
  but not asserted end to end.
- **The imported AC5/AC6 toolchain**: ARMCC is not available in CI, so the test
  switches to GCC like a user must. Whether the imported AC5/AC6 builder options
  produce an identical ARMCC build is untested.
- **C51 group-level options**: the fix above covers `ARMParser` only; the C51
  parser reads target-level and file-level options and its group option layout
  was not verified.
- **IAR / Eclipse imports**: both remain editor-only and unpersisted
  (`ImportIarProject`, `ImportEclipseProject`); nothing is verified for them.
- **Chip-pack/device binding**: `Device`/`Vendor` are read from the Keil project
  but no pack is installed or resolved by the test.

## Where import lives

- Command `eide.operation.import_project` → `src/extension.ts`; dialogs and
  parser choice `src/OperationExplorer.ts` (`OnImportProject`); emitted
  `request_import_project`.
- `ProjectDataProvider.ImportProject` dispatches to `ImportIarProject`,
  `ImportEclipseProject` and `ImportKeilProject` in `src/EIDEProjectExplorer.ts`.
  The Keil body is `ProjectDataProvider.importKeilProject`; the exported
  `importKeilProject(option)` is the headless/test entry.
- Only Keil persists: `prjConfig.Save()` plus `.eide/env.ini` and
  `.eide/files.options.yml`, then `openWorkspace`.
- Headless host: `src/headless/host.ts` (`initHeadlessRuntime`,
  `openHeadlessProject`), build service `src/headless/build_service.ts`.
