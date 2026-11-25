# Keil / IAR / Eclipse import: verified status

Baseline `ead8d57`. Read-only audit; product code untouched.

## Conclusion: **B — narrow the promise**
Import exists and writes an EIDE project, but nothing proves an imported project
builds headlessly, and one hard gate blocks it today. README must not present
import as a CLI/agent entry point until a fixture-backed test exists.

## Where import lives
- Command `eide.operation.import_project` → `src/extension.ts:158`; dialogs and
  parser choice `src/OperationExplorer.ts:530` (`uvprojx|uvproj`:580,
  `cproject`:637, `eww`:665; emitted `:623/:651/:679`). Parsers `src/KeilXmlParser.ts`,
  `src/IarProjectParser.ts`, `src/EclipseProjectParser.ts` return in-memory models.
- `ProjectExplorer.ImportProject` (`src/EIDEProjectExplorer.ts:3210`, `:1911`) →
  `ImportIarProject:1934`, `ImportEclipseProject:2218`, `ImportKeilProject:2479`.
- Only Keil persists: `prjConfig.Save()` `:2840` (+ `.eide/env.ini`, `.eide/files.options.yml`), then `openWorkspace` `:2856`.

## a. `miscInfo.uid` — absent after import
`uid` is lazy (`src/EIDEProject.ts:924-928`), set only on load (`AfterLoad`,
`:3293`); import never loads, so `.eide/eide.yml` is written without it. Gate:
`src/headless/host.ts:194`. Measured on a copy of `test/e2e/fixtures/cortex-m3`
with `miscInfo.uid` deleted:
```
$ node dist/eide_cli.js plan --project <tmp>
error: Headless build requires an initialized project with miscInfo.uid; open the project in VS Code once to initialize it.
EXIT=4
```

## b. `eide-cli plan` on an import — blocked
`eide-cli plan` on a real import was not run (no fixture with sources); the uid gate
is the first failure a CLI user hits.

## c. Extension-only dependencies
`getGlobalState()` `:2491`; CMSIS unpack via 7z (`importCmsisHeaders:1893`, used
`:2599`); `vscode.workspace.openTextDocument`/`showTextDocument` `:2692-2693`;
`vscode.window.showInformationMessage` `:2853`; `openWorkspace` `:2856`. CLI has no
import command (`src/cli/args.ts:157`).

## Fixtures
```
$ git ls-files | grep -iE "\.uvproj|\.ewp|\.cproject|mdk|iar"
lang/arm.iar.verify.json  lang/stm8.iar.verify.json
res/data/builtin_headers/lint_iararm.h  res/data/builtin_headers/lint_iarstm8.h
res/data/models/arm.iar.model.json  res/data/models/stm8.iar.model.json
res/template/ARM.uvprojx  res/template/C51.uvproj  src/IarProjectParser.ts
```
No import fixture, no `.ewp`/`.cproject` sample. The Keil files are export
templates; the parser does read `res/template/ARM.uvprojx` (1 target, ARM, 1 group,
0 sources), so only parsing is exercisable. A CI test needs a `.uvprojx` with ≥1
source and a target, a linker script, plus `import → plan/build`.

## README wording (README.md:24-26, README_ZH-CN.md:22-23)
“create projects from built-in templates; Keil 5 (MDK), IAR and Eclipse projects
can be imported **in the editor**, after which the project is a normal EIDE
project”. 中文：“使用内置模板创建工程；Keil 5 (MDK)、IAR、Eclipse 工程可在编辑器内导
入，导入后按普通 EIDE 工程使用。” Add to `docs/headless.md`: import is editor-only.

## Unverified
Imported builds after uid init; IAR/Eclipse persistence; chip-pack/RTE resolution.
