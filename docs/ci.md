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