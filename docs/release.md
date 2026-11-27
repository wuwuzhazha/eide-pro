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

## Enable VS Code Marketplace publishing

GitHub Actions uses [Marketplace Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing).
It does not need a Marketplace PAT or Azure secret.

1. In GitHub, configure the `vscode-marketplace` environment to allow
   deployments only from branch `dev` and version tags matching `v*`.
2. Sign in to [Marketplace publisher management](https://marketplace.visualstudio.com/manage)
   with an account that can publish as `wuwuzhazha`. Under this publisher,
   select **Trusted Publishing → Create** and set:

   | Field | Value |
   | --- | --- |
   | Policy name | EIDE Pro Release |
   | Repository owner | `wuwuzhazha` |
   | Repository | `eide-pro` |
   | Workflow | `release.yml` |
   | Environment | `vscode-marketplace` |

3. To run or retry only the Microsoft release, go to **Actions → Release → Run workflow**,
   select `dev`, and enter the version matching the selected revision (for example
   `v4.3.5`). The workflow builds and verifies the Marketplace VSIX from source,
   without publishing to GitHub Releases or Open VSX.
4. After this succeeds, set the repository Actions variable
   `VS_MARKETPLACE_ENABLED` to `true`. Future version tags will then publish
   to Marketplace after the existing GitHub Release and Open VSX job succeeds.
   Leave the variable unset to keep tag releases unchanged.

Verify publication at
<https://marketplace.visualstudio.com/items?itemName=wuwuzhazha.eide-ai>.
An existing Marketplace version cannot be replaced; use a new release version
if the VSIX needs to change.

## Cut a release

1. Bump the version in `package.json` and the root version in
   `package-lock.json` and sync the bundled MCP skill version, for example:

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
- Once enabled, a separately packaged VSIX from the same source is published to
  [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=wuwuzhazha.eide-ai).
  Both packages display **EIDE AI**. Open VSX keeps `wuwuzhazha.eide-pro`
  for existing installations; the Microsoft package uses `wuwuzhazha.eide-ai`.

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
