import 'dart:io';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'app.dart';
import 'shell/tray.dart';

/// Irmia GUI 入口。
///
/// 窗口尺寸（1350×900）与落位由 windows/runner/main.cpp 设定，见 docs/gui-design.md §2；
/// 标题栏是自绘的（lib/title_bar.dart），见 docs/gui-revision.md ①——自绘要求
/// 「客户区 = 整个窗口」，这条约定由 runner 守着（win32_window.cpp 与
/// flutter_window.cpp 里的 WM_NCCALCSIZE）。
///
/// **托盘化**（2026-10-04 用户要的）：她是常驻的，界面不该"关掉就没了"。所以：
///   • 关窗 = 收进托盘（不退出）；
///   • 托盘菜单：显示/隐藏、重启前后端、退出；
///   • 退出只有两条路——托盘菜单里的"退出"，或者任务管理器。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  // 窗口几何**交回 C++ runner**（windows/runner/main.cpp 的 origin/size 是客户区口径），
  // 这里只负责"把已经建好的窗口显示出来"。
  //
  // ⚠️ `WindowOptions` 里**不要**给 `titleBarStyle`，让它保持 null。原因不是审美：
  //   一旦给了值（哪怕是看着最"正确"的 `TitleBarStyle.hidden`——毕竟标题栏是我们自绘的），
  //   window_manager 就会调 setTitleBarStyle，它 Windows 侧的插件随即在 WM_NCCALCSIZE 里
  //   把客户区四边各削掉 8 物理像素（硬编码、不随 DPI 缩放，见 window_manager_plugin.cpp
  //   的 adjustNCCALCSIZE），Flutter 子窗口因此比窗口小一圈，右侧与底部露出 L 形黑边。
  //   2026-10-04 就是这么黑起来的。runner 侧现在会抢在插件之前认领 WM_NCCALCSIZE
  //   （flutter_window.cpp），但这里仍然不给值——两道锁比一道稳。
  //   也别拿 `TitleBarStyle.normal` 顶替：那个值同样会走 DwmExtendFrameIntoClientArea
  //   （参数全 0），把 runner 为窗口阴影与圆角留的那 1px DWM 边框一并抹掉。
  const options = WindowOptions(title: 'Irmia Agent Framework');
  await windowManager.waitUntilReadyToShow(options, () async {
    await windowManager.show();
    await windowManager.focus();
  });

  // 关窗收进托盘：这里拦的是"关闭"，不是"最小化"
  await windowManager.setPreventClose(true);
  windowManager.addListener(_CloseToTray());

  // 托盘在 app.dart 里装（那里拿得到命令通道；这里只管窗口）
  runApp(const IrmiaApp());
}

/// 关窗 → 隐藏（收进托盘）。真退出走托盘菜单里的那一项。
class _CloseToTray extends WindowListener {
  @override
  void onWindowClose() {
    // **托盘在，才收进托盘**：托盘没装成（或装着失败）时关窗就是关窗——
    // 否则人会点一下 X 就再也叫不回界面，只能去任务管理器（子代理实测踩到过）。
    if (IrmiaTray.instance.installed) {
      // 界面收起来，她不跟着走：agent 是独立进程，界面只是她的一个窗口
      unawaited(windowManager.hide());
      return;
    }
    unawaited(windowManager.destroy());
  }
}

/// `dart:async` 的 unawaited，避免为一行 import 引整个包
void unawaited(Future<void> future) {
  future.ignore();
}

/// 让分析器知道这个文件用到了 dart:io（托盘图标路径要用 Platform 判断）
// ignore: unused_element
final _platformIsWindows = Platform.isWindows;
