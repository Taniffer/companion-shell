# Android 构建

应用使用原生 Android SDK，没有 Gradle、AndroidX 或远程运行依赖。安装最低 Android 8.0（API 26），目标为 API 35。

需要 JDK 17、Android SDK Platform 35、Build Tools 35.0.0 和 Python 3。首版实际构建使用的下载来源与校验值保存在 `android-toolchain.json`，工具本体与签名私钥不进入源码包。

`scripts/build-android.py --tools <目录>` 期望以下目录结构，子目录可以保留下载包原来的版本名称：

```text
工具目录/
  jdk/           .../bin/javac.exe、java.exe、jar.exe、keytool.exe
  platform/      .../android.jar
  build-tools/   .../aapt2.exe、zipalign.exe、lib/d8.jar、lib/apksigner.jar
```

在项目目录执行：

```powershell
python scripts/build-android.py --tools "D:\Android构建工具"
```

脚本编译资源和 Java、生成 DEX、对齐 APK、签名并运行签名验证，产物为 `dist/companion-capture-0.2.0.apk`。首次构建会在指定工具目录生成本地开发签名，私钥不会放入产物。

当前交付 APK 使用开发签名，已验证 v2 和 v3 签名。正式对外维护版本应固定维护者签名和升级策略；不同签名无法直接覆盖已安装的同包名应用。构建通过不代表实体手机上的分享面板、后台同步和特定厂商省电策略已经验证。

## 在模拟器复验

使用 Android Emulator 和 Google APIs API 35 系统镜像。仅对独立测试模拟器启用 ADB；应用本身不需要 ADB。

测试源应用位于 `test/android-host`。它没有网络权限，提供合成阅读材料和临时授权的 `content://` 图片，可通过真实 Android 系统分享面板验证；不声称模拟了小红书或微信的内部接口。

```powershell
python scripts/build-android.py --tools "D:\Android构建工具" --project test/android-host --apk-name companion-test-source.apk
```

安装两只 APK，开启悬浮权限，然后依次验证：其他应用上点“记”→输入保存→回到原应用；系统分享链接/图片→旋转保留编辑→保存；离线登记→恢复网络同步；进程重启后记录保留；旧版升级保留资料。配对时保留真实证书指纹，用模拟器的 `10.0.2.2` 访问宿主机。勿将临时配对票据或个人数据库提交到仓库。
