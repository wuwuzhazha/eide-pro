# HardFault demo: let your AI agent find the crashing line

一个会崩溃的 Cortex-M3 小固件，加上 EIDE Pro 的 MCP 服务，让 AI 代理在几秒内告诉你**是哪一行代码引发了 HardFault**。不需要开发板，用 QEMU 模拟。

固件里有一张传感器表，`humidity` 这一项忘了填回调：

```c
static Sensor sensors[] = {
    { "temperature", temperature_ready },
    { "humidity", 0 },          /* on_event 是 NULL */
};

static void poll(const Sensor *sensor)
{
    sensor->on_event();         /* 跳到地址 0，HardFault */
}
```

## 你需要

- `eide-pro-headless`（[GitHub Releases](https://github.com/wuwuzhazha/eide-pro/releases)，`npm install -g ./eide-pro-headless-<version>.tgz`）
- `arm-none-eabi-gcc` 与 `arm-none-eabi-gdb`（Linux 上 GDB 也可以是 `gdb-multiarch`）
- `qemu-system-arm`
- 任意支持 MCP 的 AI 代理（Claude Code、Cursor、Codex 等）

## 5 分钟复现

1. 把本目录拷到任意位置，在你的 AI 代理里添加 MCP 服务：

   ```json
   {
     "mcpServers": {
       "eide-pro": {
         "command": "eide-mcp",
         "args": [
           "--project", "/path/to/hardfault-demo",
           "--toolchain-path", "/path/to/gcc-arm-none-eabi",
           "--gdb", "/path/to/gcc-arm-none-eabi/bin/arm-none-eabi-gdb"
         ]
       }
     }
   }
   ```

2. 对代理说：

   > 构建这个工程，用 QEMU（`-M netduinoplus2`，GDB 端口 1234）运行固件，在 `HardFault_Handler` 下断点并继续运行，然后诊断这次崩溃，告诉我该改哪一行。

3. 代理会依次调用 `eide_build`、`eide_debug_connect`、`eide_debug_set_breakpoint(HardFault_Handler)`、`eide_debug_continue`、`eide_debug_fault`，你会得到：

   ```text
   reasons:         FORCED, INVSTATE
   faultLocation:   address 0 (no symbol)       <- 程序被跳到了地址 0
   callerLocation:  poll, main.c:15             <- sensor->on_event();  要修的就是这一行
   ```

`callerLocation` 取的是压栈 LR-1，也就是**发起坏跳转的那条调用指令所在行**；`faultLocation` 是被跳进去的坏地址，通常不是要改的地方。

## 它为什么可信

这个工程是 EIDE Pro CI 的一部分：每次提交都会在真实的 QEMU + GDB 上重新构建、制造这次崩溃，并断言上面的结果。示例不会和代码脱节。
