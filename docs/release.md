# Release

Releases are cut from tags named `v<version>`, for example `v4.1.0`. The tag
version must equal the `version` field in `package.json`; the workflow stops
before installing dependencies when they differ.

## Required secret

| Secret | Purpose |
| --- | --- |
| `OPEN_VSX_PAT` | Open VSX access token allowed to publish under the `wuwuzhazha` publisher namespace. Create it in the Open VSX user settings and add it under repository Settings → Secrets and variables → Actions. |

`GITHUB_TOKEN` is provided by Actions automatically. The workflow declares
`permissions: contents: write` so that token can create or update the GitHub
Release.

The release workflow checks `OPEN_VSX_PAT` before installing dependencies and
fails at the `Require Open VSX token` step when the secret is missing.

## Cut a release

1. Bump the version in `package.json` and the root version in
   `package-lock.json`, for example:

   ```bash
   npm version <version> --no-git-tag-version
   ```

2. Commit the version bump, push it to `dev`, and wait for CI to pass.
3. Tag that commit and push the tag:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```

The tag push starts `.github/workflows/release.yml`.

## Published artifacts

- A GitHub Release for the tag containing:
  - `eide-pro-<version>.vsix`, built with `npm run vscode:prepublish` and
    packaged by the pinned `@vscode/vsce@2.15.0`.
  - `eide-pro-headless-<version>.tgz`, the standalone `eide-cli`/`eide-mcp`
    package built by `npm run package:headless`.
  - `eide-mcp-tools-skill.zip`, containing `eide-mcp-tools/SKILL.md` at the
    archive root, so extracting it into an agent skills directory produces
    `<skills>/eide-mcp-tools/SKILL.md`.
- The same VSIX published to Open VSX under the `wuwuzhazha` publisher:
  https://open-vsx.org/extension/wuwuzhazha/eide-pro

## Binaries payloads

The extension downloads its runtime payloads (`~/.eide/bin`) from releases
tagged `binaries/<version>`, not from `github0null/eide-resource`. Each such
release carries one asset per runtime id:

```
bin-win32.7z
bin-linux-x86_64.7z
bin-linux-arm64.7z
bin-osx-x86_64.7z
bin-osx-arm64.7z
```

The extension lists `https://api.github.com/repos/wuwuzhazha/eide-pro/releases`,
keeps the `binaries/` tags whose release has the asset for the current runtime,
and installs the highest version matching the major version in
`res/data/config.yaml` (`binary_min_version`). Raising that major version forces
every existing install to migrate on the next start.

Build the payloads with the bundled `7za`; the script downloads the upstream
eide-resource archives, prunes them to what the extension actually calls, and
self-checks the result (win32 runs `bash -c 'echo ok && /bin/tar --version'`
from the extracted payload):

```bash
node scripts/build-binaries-payload.js all --out <dir> --version 13.0.0
```

`win32` keeps only `builder/msys/{bin,etc}` (bash, tar, the MSYS runtime DLLs
and the shell builtins), `utils/stvp_tools`, `include/internal_headers` and
`VERSION`. The other platforms keep only `include/internal_headers` and
`VERSION`, because they use the system shell.

Publish by creating a release with tag `binaries/<version>` and uploading the
five assets:

```bash
gh release create binaries/13.0.0 <dir>/bin-*.7z --title "binaries 13.0.0"
```

## Rerun a failed release

Open Actions → Release, select the failed run for the tag, and choose
"Re-run failed jobs". The GitHub Release step updates an existing release and
overwrites its assets. If the Open VSX publish step already uploaded the
version before failing, the rerun fails because that version exists; bump the
version and push a new tag instead of reusing or moving the old tag.
