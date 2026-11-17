# Codex Desktop 飞书桥接基础包

这是伴随工作台使用的底层桥接源码，随包不含账号、配置、消息账本或密钥。实际模型执行使用已登录的 Codex Desktop，不启动独立 Codex CLI。

首次安装请从 Codex Desktop 对话中的终端运行 `scripts/install.ps1 -NoStart`，按配置窗口连接自己的飞书应用。当前对话环境用于建立控制接口；之后用 `src/pairing.mjs` 显示绑定口令，向机器人私聊完成绑定。具体步骤见上级项目的 `docs/安装与日常使用.md`。

Node.js 22.19+。源码开发先运行 `npm ci`，验证用 `npm test`。本目录采用上级项目的 MIT 许可。运行依赖 `@larksuiteoapi/node-sdk` 1.74.0 按其自身许可分发。
