# Third-Party Notices

EIDE Pro is a fork of [github0null/eide](https://github.com/github0null/eide) and
is distributed under the MIT License. The original copyright notice is retained
in [LICENSE](./LICENSE).

This file lists third-party components bundled with the extension package. The
full MIT license text is in [LICENSE](./LICENSE); additional license texts are
in the [licenses](./licenses) directory.

## Upstream EIDE

- Project: github0null/eide
- License: MIT
- Copyright: Copyright (c) 2019 github0null
- Source: https://github.com/github0null/eide

## Build tools

| Component | License | Source |
|-----------|---------|--------|
| `unify_builder`, `axf2elf`, `verchk`, `serial_monitor` | MIT | https://github.com/github0null/eide_tools |
| 7-Zip command-line binaries (`7za`, `7za.exe`) | GNU LGPL 2.1+ with the unRAR restriction | https://www.7-zip.org/ |

The 7-Zip license text is reproduced in [licenses/7zip.txt](./licenses/7zip.txt).
7-Zip is Copyright (c) 1999-2025 Igor Pavlov.

## Project importer scripts

The IAR/Segger project importers in `res/scripts` are bundled from the EIDE
binary resource package and run on the bundled QuickJS runtime.

| Component | License | Source |
|-----------|---------|--------|
| QuickJS (`qjs`, `qjs.exe`) | MIT | https://bellard.org/quickjs/ |
| x2js (`res/scripts/lib/x2js`) | Apache-2.0 | https://code.google.com/p/x2js/ |
| xmldom (`res/scripts/lib/x2js/xmldom`) | MIT | https://github.com/bigeasy/xmldom |
| mingw-w64 runtime (`libwinpthread-1.dll`, Windows QuickJS build) | Zope Public License 2.1 | https://www.mingw-w64.org/ |

The QuickJS license text is reproduced in
[licenses/quickjs.txt](./licenses/quickjs.txt); the Apache-2.0 text is in
[licenses/Apache-2.0.txt](./licenses/Apache-2.0.txt).

## .NET and NuGet dependencies

The build tools bundle the following libraries. Except where noted, the MIT
license text in [LICENSE](./LICENSE) applies.

| Component | Version | License | Source |
|-----------|---------|---------|--------|
| CommandLineParser | 2.9.1 | MIT | https://github.com/commandlineparser/commandline |
| ConsoleTableExt | 3.1.9 | MIT | https://github.com/minhhungit/ConsoleTableExt |
| DotNet.Glob | 3.1.3 | MIT | https://github.com/dazinator/DotNet.Glob |
| Microsoft.Data.Sqlite | 9.0.7 | MIT | https://github.com/dotnet/efcore |
| Newtonsoft.Json | 13.0.1 | MIT | https://github.com/JamesNK/Newtonsoft.Json |
| SQLitePCLRaw (bundle/core/provider) | 2.1.x | Apache-2.0 | https://github.com/ericsink/SQLitePCL.raw |
| System.Memory, System.Runtime.CompilerServices.Unsafe, System.Text.Encoding.CodePages, System.IO.Ports | 4.5.3 / 6.0.0 | MIT | https://github.com/dotnet/runtime |
| SQLite native library (`e_sqlite3`) | bundled with SQLitePCLRaw | Public Domain | https://sqlite.org/copyright.html |

The Apache-2.0 license text is reproduced in
[licenses/Apache-2.0.txt](./licenses/Apache-2.0.txt).

## Node.js dependencies

The VSIX includes production Node.js dependencies under `node_modules`. Each
package retains its own license file in its package directory. Major runtime
dependencies include:

| Package | License |
|---------|---------|
| `@modelcontextprotocol/sdk` | MIT |
| `ajv` | MIT |
| `iconv-lite` | MIT |
| `ini` | ISC |
| `jsonc`, `jsonc-parser` | MIT |
| `mathjs` | Apache-2.0 |
| `micromatch` | MIT |
| `node-7z` | MIT |
| `vscode-cpptools` | MIT |
| `x2js` | MIT |
| `yaml` | ISC |
| `zod` | MIT |

## Project templates and chip packs

EIDE project templates, chip support packs, and files under `res/template` or
`res/data` may contain vendor-supplied code or documentation. Those files remain
subject to their original licenses and notices. This fork does not relicense
third-party vendor content.

## Reporting

If a notice is missing or incorrect, open an issue at
https://github.com/wuwuzhazha/eide-pro/issues.
