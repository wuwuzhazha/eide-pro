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

## Verified: IAR and Eclipse import → persisted project → headless load

`test/scripts/import-iar-eclipse-e2e.test.ts` drives the same import entries the
editor dispatch uses. Both bodies were already independent of the project tree;
they are now exposed as module-level `importIarProject` / `importEclipseProject`
(next to `importKeilProject`), with the editor-only toolchain warning and
workspace-switch dialogs left in `ProjectDataProvider.ImportIarProject` /
`ImportEclipseProject`.

- **IAR**: `test/fixtures/iar-import/demo.eww` references `demo.ewp` (ARM
  toolchain, `Debug`/`Release`, `CCDefines`, `CCIncludePath2`, `IlinkIcf*`).
  The import creates the EIDE project under `demo/` and writes
  `.eide/eide.yml` + `.eide/env.ini`. The test asserts `miscInfo.uid`, type
  `ARM`, toolchain `IAR_ARM`, the virtual folder (root file, `App` group,
  nested `Drivers` group), per-configuration defines and include paths, the
  mapped ICF path, and `PROJ_DIR = ..` in `env.ini`. It then opens the project
  through `openHeadlessProject` (uid gate), checks the build plan carries all
  three sources and both `Debug` defines, and finally deletes `miscInfo.uid` to
  prove the gate rejects it again.
- **Eclipse**: `test/fixtures/eclipse-import/.project` + `.cproject` describe an
  `ARM Cross GCC` project with a `C Compiler` (defines, include path,
  `STM32F407VGTx` MCU), a `C Linker` script, and `src` + `.` source entries.
  The import writes `.eide/eide.yml` + `.eide/files.options.yml`. The test
  asserts `miscInfo.uid`, type `ARM`, toolchain `GCC`, `srcDirs`
  (`src`), the root virtual file, the define and include path, the MCU→CPU/FPU
  mapping (`Cortex-M4`, `single`) and the linker script. It then opens the
  project through `openHeadlessProject`, checks the plan carries `main.c` and
  `src/main.c` plus the define, and proves the uid gate rejects a stripped
  config.

No IAR/Eclipse toolchain is required: `openHeadlessProject` is given a stub
toolchain directory (`bin/` only), and the plan stage only builds the command
model. No real IAR or Eclipse build is run.

Run it with:

```
npm run compile && npm run compile:test
node out/tmp/test/scripts/import-iar-eclipse-e2e.test.js
```

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
- **IAR real toolchain build**: `iccarm`/`ilinkarm` are unavailable, so the IAR
  test stops at import + load + plan structure; no ARM/IAR build is run.
- **IAR per-file options and multi-project workbenches**: the IAR parser has no
  per-file option model (so no `.eide/files.options.yml` is produced), and the
  fixture's `.eww` references one `.ewp`; multi-project multi-root workspaces
  and per-file settings are not asserted.
- **Eclipse build and extended options**: the fixture is planned with a stub
  GCC directory; no real `arm-none-eabi-gcc` build is run for it (the Keil test
  covers the real GCC build path), and only defines/includes/MCU/linker script
  are asserted — optimization, language standard and linked resources are not.
- **Chip-pack/device binding**: `Device`/`Vendor` are read from the Keil project
  but no pack is installed or resolved by the test.

## Where import lives

- Command `eide.operation.import_project` → `src/extension.ts`; dialogs and
  parser choice `src/OperationExplorer.ts` (`OnImportProject`); emitted
  `request_import_project`.
- `ProjectDataProvider.ImportProject` in `src/EIDEProjectExplorer.ts` dispatches
  directly to the static `importKeilProject`, and to the instance wrappers
  `ImportIarProject` / `ImportEclipseProject`. All three bodies live in the
  static `ProjectDataProvider.importKeilProject` / `importIarProject` /
  `importEclipseProject`; the module-level exported `importKeilProject(option)` /
  `importIarProject(option)` / `importEclipseProject(option)` are the
  headless/test entries. The IAR/Eclipse instance wrappers keep the editor-only
  toolchain warning and the workspace-switch dialog.
- All three persist `prjConfig.Save()` (with `miscInfo.uid`); Keil and IAR also
  write `.eide/env.ini`; Keil and Eclipse also write `.eide/files.options.yml`.
- Headless host: `src/headless/host.ts` (`initHeadlessRuntime`,
  `openHeadlessProject`), build service `src/headless/build_service.ts`.
