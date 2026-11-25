# EIDE MCP Skill

The `eide-mcp-tools` skill teaches an AI agent to operate EIDE Pro projects
through MCP: VS Code HTTP MCP, headless stdio MCP, build/flash configuration,
stack/callgraph queries, and GDB debugging.

## Download

- Headless package (preferred): the skill ships inside
  `eide-pro-headless-<version>.tgz` at `skills/eide-mcp-tools/SKILL.md`, or
  print it with `eide-mcp --print-skill`.
- Direct file:
  https://raw.githubusercontent.com/wuwuzhazha/eide-pro/dev/docs/skills/eide-mcp-tools/SKILL.md
- Release archive (latest):
  https://github.com/wuwuzhazha/eide-pro/releases/latest/download/eide-mcp-tools-skill.zip
- Repository clone:
  `git clone --depth 1 -b dev https://github.com/wuwuzhazha/eide-pro.git`

## Install

The directory name must be `eide-mcp-tools`; the skill frontmatter name matches
it.

### ZCode

User scope:

```bash
mkdir -p ~/.agents/skills/eide-mcp-tools
curl -fsSL https://raw.githubusercontent.com/wuwuzhazha/eide-pro/dev/docs/skills/eide-mcp-tools/SKILL.md \
  -o ~/.agents/skills/eide-mcp-tools/SKILL.md
```

Project scope:

```bash
mkdir -p .agents/skills/eide-mcp-tools
curl -fsSL https://raw.githubusercontent.com/wuwuzhazha/eide-pro/dev/docs/skills/eide-mcp-tools/SKILL.md \
  -o .agents/skills/eide-mcp-tools/SKILL.md
```

### Claude Code

```bash
mkdir -p ~/.claude/skills/eide-mcp-tools
curl -fsSL https://raw.githubusercontent.com/wuwuzhazha/eide-pro/dev/docs/skills/eide-mcp-tools/SKILL.md \
  -o ~/.claude/skills/eide-mcp-tools/SKILL.md
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.agents\skills\eide-mcp-tools" | Out-Null
Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/wuwuzhazha/eide-pro/dev/docs/skills/eide-mcp-tools/SKILL.md" `
  -OutFile "$HOME\.agents\skills\eide-mcp-tools\SKILL.md"
```

### Release archive

Download `eide-mcp-tools-skill.zip`, extract it into the agent's skills
directory so the result is `<skills-dir>/eide-mcp-tools/SKILL.md`, then restart
or reload the agent session.

## Verify

```bash
head -5 ~/.agents/skills/eide-mcp-tools/SKILL.md
```

Expected frontmatter:

```yaml
---
name: eide-mcp-tools
version: 4.3.0
description: >-
  Operate EIDE Pro embedded MCU projects through MCP tools...
---
```

## Keep it current

A copied skill goes stale silently: after upgrading EIDE Pro the installed copy
still describes the previous tool surface. The frontmatter `version` is the
release the skill describes — compare it with `eide-mcp --version` (or the
extension version) and refresh when they differ:

```bash
eide-mcp --print-skill > ~/.agents/skills/eide-mcp-tools/SKILL.md
```

Point the redirect at whichever path you installed to (`.claude`, `.agents`,
project scope).

The skill is documentation for agents. It is not required for EIDE Pro itself
and is not bundled into the VSIX.
