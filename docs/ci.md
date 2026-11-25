# Continuous Integration

EIDE Pro projects can be built in CI without VS Code. The `eide-cli` and
`eide-mcp` commands come from the headless package and use the same project
loader and builder as the extension.

## Prerequisites

- Node.js 18+
- .NET 6+ runtime (the bundled builder is framework-dependent)
- The toolchain for your project, e.g.
  [GNU Arm Embedded](https://developer.arm.com/downloads/-/gnu-rm)
- The headless package: download `eide-pro-headless-<version>.tgz` from
  [GitHub Releases](https://github.com/wuwuzhazha/eide-pro/releases) and
  `npm install -g` it

See [headless.md](./headless.md) for the full requirements.

## First build

Create a project from a template (skip if you already have one):

```bash
eide-cli create --name firmware --template stm32f1xx_gcc --output ./projects
```

Build it:

```bash
eide-cli build \
  --project ./projects/firmware \
  --toolchain-path /opt/gcc-arm-none-eabi
```

`--toolchain-path` maps to the toolchain's normal `EIDE.*` install setting; the
executable folder is derived as `bin` (or `stm8/bin`) inside it.

Each command prints one JSON object to stdout; logs go to stderr. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Build or flash operation failed |
| `3` | Invalid invocation, project configuration, or unsupported request |
| `4` | Failed to start the external tool |

`plan` produces the build plan without compiling, useful to validate project
configuration in CI without a toolchain.

## Caching

Incremental build artifacts live in the output directory reported by `plan`
(`outDir`, `<project>/build/<target>` by default). Cache that directory and
non-rebuild builds stay incremental. `eide-cli clean` deletes the whole
directory, which forces a full rebuild.

Cache key suggestion: the `configHash` from `eide-cli plan` (it changes when
`-D`, `--cflag`-style inputs change) combined with a source-file hash, for
example:

```yaml
    # example — adjust to your project
    - name: Cache build output
      uses: actions/cache@v4
      with:
        path: firmware/build
        key: eide-${{ hashFiles('firmware/.eide/**', '**/*.c', '**/*.h') }}
```

## GitHub Actions example

Example only — adjust paths, runner, and toolchain.

```yaml
name: firmware-build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: 8.x
      - name: Install GNU Arm Embedded
        run: sudo apt-get update && sudo apt-get install -y gcc-arm-none-eabi
      - name: Install EIDE Pro headless package
        run: npm install -g ./eide-pro-headless.tgz   # commit or download from Releases
      - name: Build
        run: |
          eide-cli build \
            --project ./firmware \
            --toolchain-path /usr
```

The GCC executable folder is derived from `--toolchain-path`; on Debian/Ubuntu
`gcc-arm-none-eabi` installs `arm-none-eabi-gcc` under `/usr/bin`, so `/usr`
is the toolchain root in this example.

## Verified toolchain builds

| Toolchain | Template or fixture | Verified by | Result |
| --- | --- | --- | --- |
| ARM GCC | `cortex-m3` fixture, `stm32f1xx_gcc` template | real `arm-none-eabi-gcc` build, ELF produced | verified build |
| 8051 SDCC | `mcs51_sdcc` template | `apt install sdcc`, `create` + `build`, `.ihx` in `artifacts` (commit `9955741`) | verified build |
| RISC-V GCC (`gd32vf103_riscv`) | template | Debian/Ubuntu `gcc-riscv64-unknown-elf` | not supported with apt toolchain |
| STM8 SDCC | `stm8s_sdcc` template | `apt install sdcc`, needs `sdcc` + `sdasstm8`, build succeeded, `.hex`/`.ihx` accepted | verified build |
| AVR | `avr_atmega128_rtos` template | current avr-libc | template incompatible with current avr-libc |
| MIPS, IAR, AC5/AC6 | templates | none | unverified |

The `toolchain-builds` job and the `headless-package` E2E in
`.github/workflows/ci.yml` run these checks; inspect their logs to reproduce.

On Debian/Ubuntu, the apt RISC-V toolchain cannot build the
`gd32vf103_riscv` template: `riscv-none-embed-gcc: fatal error: cannot read
spec file 'nosys.specs'`. The Debian package ships no `specs` files, no
`libnosys`, and no `/usr/lib/riscv64-unknown-elf/lib/` (only
`picolibc-riscv64-unknown-elf`). The template requires the xPack
`riscv-none-embed` toolchain, which bundles newlib.

The `avr_atmega128_rtos` template does not compile against modern avr-libc:
`attempt to use poisoned "SIG_OUTPUT_COMPARE0"` (poisoned at
`/usr/lib/avr/include/avr/iom128.h:1262`). Its bundled RTOS9 port uses
old-style interrupt names; covering it requires fixing the template contents
first (e.g. `ISR(TIMER0_COMP_vect)`), which is outside CI scope.

MIPS and the commercial toolchains (IAR, AC5/AC6) have no real build
verification: commercial licenses cannot be obtained in CI, and the MIPS
template has not been run in this configuration. Plan-only checks exist for
their schemas; treat build results as unverified.
