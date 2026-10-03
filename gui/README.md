# IRMIA GUI

IRMIA 的 Windows 桌面外壳（Flutter）。后端是仓库根那个 Node 服务，本界面只是它的一个窗口：
关窗收进托盘，agent 照常常驻运行。

构建：

```
flutter pub get
flutter build windows --release
```

产物在 `build\windows\x64\runner\Release\irmia_gui.exe`。仓库里的 `scripts/start-gui.ps1` 会顺带把
观测台的 token 复制到界面能读到的地方再启动它。
