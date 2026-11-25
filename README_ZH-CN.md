# EIDE Pro

<img src="./res/icon/icon.png" width="96" align="right" alt="EIDE Pro 图标">

EIDE Pro 是面向 VS Code 和 Headless 自动化的嵌入式 MCU 开发环境。它管理面向
ARM Cortex-M、8051/STM8、RISC-V、MIPS 以及任意 GCC 目标的 EIDE 工程；使用目标
平台的原生工具链构建工程；通过受支持的烧录器烧录设备；并通过 CLI 和 MCP 服务器
对外提供与扩展相同的工程模型和构建模型。

[![仓库](https://img.shields.io/badge/repo-wuwuzhazha%2Feide-pro-blue)](https://github.com/wuwuzhazha/eide-pro)
[![发布](https://img.shields.io/github/v/release/wuwuzhazha/eide-pro)](https://github.com/wuwuzhazha/eide-pro/releases)
[![Open VSX](https://img.shields.io/open-vsx/v/wuwuzhazha/eide-pro)](https://open-vsx.org/extension/wuwuzhazha/eide-pro)
[![许可证](https://img.shields.io/github/license/wuwuzhazha/eide-pro)](./LICENSE)

[English](./README.md)

## 概述

- **Agent 自动化** — 同一个 EIDE 工程，两种工作方式：在 VS Code 里开发，在
  CI、脚本和 AI agent 里通过 CLI 与 MCP 服务器构建、烧录、调试同一个工程。
  GDB/MI 调试覆盖读取变量、单步执行、解码 Cortex-M fault 寄存器、查询 SVD
  外设；调试回路（连接、断点、栈帧、读变量、fault 解码、断开）已在 CI 中
  用 QEMU 实跑。见 [Headless CLI 与 MCP 指南](./docs/headless.md#mcp-server-stdio)。
- **工程创建** — 使用内置模板创建工程，或在编辑器内导入 Keil 5 (MDK)、IAR、
  Eclipse 工程；导入即写入 `miscInfo.uid`，导入后的工程可直接被 CLI 打开和
  构建。Cortex-M 工程可安装标准 Keil 芯片支持包。Keil 导入的源码、目标/分组/
  文件级宏定义与分组头文件路径已通过 headless GCC 构建端到端验证
  （[验证状态](./docs/keil-import-status.md)）。IAR 与 Eclipse 导入的持久化与
  headless 可加载性也已验证；RTE 组件解析与 ARMCC 产物仍未验证。
- **构建** — 使用 AC5、AC6、GCC、LLVM_ARM、IAR_ARM、Keil_C51、SDCC、
  GNU_SDCC_MCS51、IAR_STM8、COSMIC_STM8、RISCV_GCC、MTI_GCC 和 ANY_GCC
  工具链进行编译、重新编译和清理。
- **烧录** — 通过 J-Link、ST-Link、OpenOCD、pyOCD、probe-rs 烧录器烧录设备。
  自定义命令烧录器仅在 VS Code 扩展中可用；headless CLI 与 MCP 会显式报错
  （STVP 和 stcgal 同样），与 headless 的
  [Limits](./docs/headless.md#limits) 一致。
- **调试集成** — 为受支持的探针生成 Cortex-Debug launch 和 attach 配置，并
  为 `probe-rs-debug` 和 `gdbtarget` 调试适配器提供配置。
- **编辑器工具** — Cppcheck 静态分析、无需 `c_cpp_properties.json` 的
  cpptools IntelliSense provider、CMSIS Config Wizard、反汇编视图、map 视图、
  工程资源浏览器、Windows 上的 MSYS shell，以及 GCC 调用图视图。
- **自动化** — `eide-cli` 提供 build、rebuild、clean、plan 和 flash；
  `eide-mcp` 提供 stdio MCP 服务器。两者都复用扩展的工程加载器和构建器。

## 支持的工程与工具链

| 工程类型 | 工具链 |
| --- | --- |
| ARM | `AC5`、`AC6`、`GCC`、`LLVM_ARM`、`IAR_ARM` |
| C51 / STM8 | `Keil_C51`、`SDCC`、`GNU_SDCC_MCS51`、`IAR_STM8`、`COSMIC_STM8` |
| RISC-V | `RISCV_GCC` |
| MIPS | `MTI_GCC` |
| ANY-GCC | `ANY_GCC` |

工程使用 EIDE 工程格式（`.eide/eide.yml`）。可导入 Keil 5、IAR、Eclipse
工程，Cortex-M 工程支持标准 Keil 芯片包。

## 安装

### Open VSX

```bash
code --install-extension wuwuzhazha.eide-pro
```

扩展以 **EIDE Pro** 名称发布在
[Open VSX](https://open-vsx.org/extension/wuwuzhazha/eide-pro)。请在配置了
Open VSX 的编辑器（例如 VSCodium 或 code-server）中执行该命令。标准 VS Code
默认不查询 Open VSX；请改用下方的 VSIX。

### GitHub Releases

从 [GitHub Releases](https://github.com/wuwuzhazha/eide-pro/releases) 下载最新的
`eide-pro-<version>.vsix`，然后通过命令行或在 VS Code 中执行
**Extensions: Install from VSIX...** 安装：

```bash
code --install-extension ./eide-pro-4.3.0.vsix
```

### Headless CLI 与 MCP

从 [GitHub Releases](https://github.com/wuwuzhazha/eide-pro/releases) 下载
`eide-pro-headless-<version>.tgz`，然后全局安装：

```bash
npm install -g ./eide-pro-headless-<version>.tgz
```

这会安装 `eide-cli` 和 `eide-mcp` 命令，无需 VS Code。安装包内含工具链模型、
构建器二进制和资源目录；运行环境需要 Node.js 18+ 和 .NET 6+ runtime。详见
[Headless CLI 与 MCP 指南](./docs/headless.md)。

### 从源码构建

环境要求：Node.js 18、npm 和 Git。构建需要 `lib/node-utility` 子模块。该子模块
在 `.gitmodules` 中的 URL 使用 SSH；如果没有配置 GitHub SSH 凭据，请改写为
HTTPS。

```bash
git clone https://github.com/wuwuzhazha/eide-pro.git
cd eide-pro
git -c url."https://github.com/".insteadOf="git@github.com:" submodule update --init --recursive
npm install
npm test
npm run vscode:prepublish
```

`npm run vscode:prepublish` 会构建扩展和两个 Headless bundle。使用 Node.js 18
打包 VSIX 时，请使用该项目一直沿用的 vsce 版本：

```bash
npx @vscode/vsce@2.15.0 package
```

日常开发中，`npm run webpack` 以开发模式构建扩展，`npm run webpack:headless`
只构建 CLI 与 MCP bundle。

## 快速开始

1. 安装 EIDE Pro。
2. 安装受支持的工具链，并在 EIDE Pro 的 **Operations** 视图中设置其路径。
3. 从模板创建工程，或导入已有的 Keil、IAR 或 Eclipse 工程。
4. 构建工程，然后在工程视图中烧录设备或启动调试会话。

## Headless CLI 与 MCP

Headless 宿主加载相同的 `.eide/eide.yml` 工程模型，并使用与 VS Code 扩展相同的
`CodeBuilder` 生成构建参数。因此，Headless 构建遵循 `.eide/env.ini`、虚拟源码
目录、`dependenceList` 分组、单文件选项、工作区设置、动态 overrides 以及由
xpack 管理的工具链。从原版 EIDE 迁移而来？见
[migrating-from-eide.md](./docs/migrating-from-eide.md)。扩展与 CLI/MCP 工具是
两个独立的安装——见 ["Two ways to run EIDE"](./docs/headless.md#two-ways-to-run-eide)。

### CLI

使用已安装的发行包构建：

```bash
eide-cli build \
  --project ./firmware \
  --toolchain-path ./gcc
```

命令包括 `create`、`build`、`rebuild`、`clean`、`plan` 和 `flash`。
`eide-cli create --name firmware --template stm32f1xx_gcc` 可从内置模板创建
可直接构建的工程。`plan` 与 `build --dry-run` 只生成构建计划而不执行编译；
`flash --dry-run` 只打印烧录命令
而不访问硬件。结果以一个 JSON 对象输出到 stdout；日志输出到 stderr。完整选项、
退出码、构建结果字段和烧录选项见 [docs/headless.md](./docs/headless.md)。

独立 bundle 为 `dist/eide_cli.js` 和 `dist/eide_mcp.js`；对应的 package bin
名称为 `eide-cli` 和 `eide-mcp`。从开发树直接运行时使用 `node dist/...`。

### MCP

```bash
eide-mcp \
  --project ./firmware \
  --toolchain-path ./gcc
```

stdio 服务器提供工程 build/rebuild、clean、flash、目标/源码/头文件路径配置、
栈使用量和调用图工具。使用 `--gdb` 启动时，还会提供基于 GDB 的工具，用于连接、
读取寄存器和内存、设置和列出断点、获取调用栈、选择线程和栈帧、读取局部变量、
单步执行（over/into/out）、继续和中断执行、求值表达式、解码 Cortex-M fault，
以及查找 SVD 符号（支持 `derivedFrom` 继承）。

VS Code 还提供 HTTP MCP 服务器。通过 `EIDE.MCP.Server.Enable` 启用，并通过
`EIDE.MCP.Server.Port` 设置端口（默认 `8940`）。客户端配置里的条目名可以自行决定，
服务端自身标识为 `EIDE Pro`：

```json
{
  "servers": {
    "EIDE Pro": { "url": "http://localhost:8940/mcp", "type": "http" }
  }
}
```

Headless 烧录支持 J-Link、OpenOCD、pyOCD、ST-Link 和 probe-rs。Headless 模式
不支持 STVP、stcgal 和自定义命令烧录器。

Agent 安装与配置见 [EIDE MCP skill](./docs/skills/README.md)。skill 目录为
`docs/skills/eide-mcp-tools`。

## 环境要求

- **VS Code** — 1.89 或更新版本，或兼容的、可从 Open VSX 或 VSIX 文件安装扩展的
  编辑器。
- **工具链** — 单独安装目标平台所需的编译器、汇编器和链接器，然后在 EIDE Pro 中
  配置其路径。Headless 模式接受 `--toolchain-path` 或 `--settings` 文件。
- **Node.js** — Headless CLI、MCP 服务器以及从源码构建需要 Node.js 18 或更新
  版本。
- **工程** — 一个 EIDE 工程。Headless 模式要求 `.eide/eide.yml` 中存在
  `miscInfo.uid`。
- **平台** — Windows x64（Windows 10 或更新版本）、Linux x64 和 macOS。上游仅在
  10.15 x64 上测试过 macOS。

## 与上游的关系

EIDE Pro 是 [github0null/eide](https://github.com/github0null/eide) 的非官方分支，
由 [wuwuzhazha/eide-pro](https://github.com/wuwuzhazha/eide-pro) 维护。本分支的所有
改动均由 AI 执行，并且涉及工程加载和构建核心链路；将这些改动提交上游会给上游
维护者带来不成比例的审查和稳定性负担。因此，EIDE Pro 作为独立的参考实现和可安装
扩展维护。上游仍然是
[github0null/eide](https://github.com/github0null/eide)。

EIDE Pro 使用与上游相同的 `.eide/eide.yml` 工程模型和工具链定义，并拥有独立的
扩展标识，因此与上游 EIDE 分开安装。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `src/extension.ts` | 扩展激活、命令和调试配置 provider |
| `src/EIDEProject.ts` | `.eide/eide.yml` 工程模型与配置 |
| `src/CodeBuilder.ts` | 所有工具链的构建参数生成 |
| `src/core/` | Headless 构建与烧录服务、工程快照、问题解析、GDB/SVD 辅助代码 |
| `src/cli/` | `eide-cli` 入口（`src/cli/eide_cli.ts`）、参数解析与命令分发 |
| `src/headless/` | Headless 宿主、设置解析和 VS Code API shim |
| `src/mcp/` | `eide-mcp` 入口（`src/mcp/eide_mcp.ts`）、stdio 服务器、工具与 GDB 集成 |
| `src/html/` | Webview 资源，包括调用图视图 |
| `res/` | 模板、工具链元数据、内置工具和图标 |
| `test/` | 测试运行器、测试脚本和安装包 E2E fixture |
| `scripts/` | 发布和 Headless 打包脚本 |
| `docs/` | Headless CLI/MCP 与 agent skill 文档 |
| `lib/node-utility/` | 共享工具子模块 |

## 测试与验证

运行完整测试套件：

```bash
npm test
```

该命令编译 `src` 和 `test`，然后通过 `test/run-tests.js` 运行 `test/scripts`
中的每个脚本。测试覆盖工程模型、构建器、Headless 构建与烧录路径、工具链矩阵、
MCP 协议行为以及 GDB/SVD 解析。

常用命令：

```bash
npm run compile                # 使用 tsc 编译 src
npm run webpack                # 以开发模式构建扩展
npm run webpack:headless       # 构建 dist/eide_cli.js 和 dist/eide_mcp.js
npm run package:headless       # 生成 artifacts/eide-pro-headless-<version>.tgz
npm run test:headless-package  # 安装 tgz、构建 Cortex-M fixture 并验证 MCP
```

安装包 E2E 需要 ARM GCC（`ARM_GCC_ROOT`，默认 `/usr`）和 .NET 6+ runtime。

## 贡献

分支、测试和 pull request 流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全
问题请按 [SECURITY.md](./SECURITY.md) 私下报告。

## 许可证

MIT。详见 [LICENSE](./LICENSE) 和
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。其他第三方许可证文本位于
[licenses](./licenses)。

## 链接

- [贡献指南](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [更新日志](./CHANGELOG.md)
- [Headless CLI 与 MCP 指南](./docs/headless.md)
- [EIDE MCP skill](./docs/skills/README.md)
- [GitHub Releases](https://github.com/wuwuzhazha/eide-pro/releases)
- [Open VSX](https://open-vsx.org/extension/wuwuzhazha/eide-pro)
- [上游 EIDE](https://github.com/github0null/eide)
