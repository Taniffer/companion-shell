# 来源与依赖

伴随工作台与随附桥接源码采用 MIT 许可。`bridge-kit` 保留此前同一工作区生成的 Codex Desktop 飞书桥接；`vendor/feishu-bridge` 是用于兼容测试的桥接核心快照，不包含用户配置和数据。

运行依赖固定在各自的 package-lock.json：工作台使用 selfsigned 5.5.0、飞书 Node SDK 1.76.0 与 qrcode 1.5.4；兼容桥接使用飞书 Node SDK 1.74.0。依赖及其传递依赖分别遵循各包随附的许可。Windows 接入包中的 Node.js 22.19.0 附带原运行时 LICENSE。

项目未包含模型厂商客户端、Android SDK/JDK、用户登录数据、飞书密钥或 Android 签名私钥。Codex、飞书、Android 等名称属于相应权利人，项目不是这些产品的官方客户端。
