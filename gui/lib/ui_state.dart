/// 壳的界面状态持久化：把「更多」折叠组这类纯 UI 偏好写到
/// `%APPDATA%/Irmia/ui-state.json`。
///
/// 零依赖（只用 dart:io + dart:convert，不引 shared_preferences）；
/// 读写一律失败静默——状态文件丢了只是回到默认值，不该影响使用。
/// 做法照 AstrBot `VerticalSidebar.vue` 的 `sidebar_openedItems`：
/// 只记「哪些组是展开的」，读回来缺项即折叠。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

// ValueNotifier：把「关窗时收进托盘」的内存镜像给窗口关闭回调用（那里做不了异步读盘）
import 'package:flutter/foundation.dart';

/// 「关窗时收进托盘」这个偏好在本机状态文件里的键名。
///
/// **默认 false（点 × 就退出界面）**，2026-10-04 修正：原来是无条件"关窗 = 收进托盘"，
/// 而 Windows 11 默认把新出现的托盘图标收进"隐藏的图标"面板（通知区域那个 `^` 里）——
/// 于是用户眼里的现象是"窗口没了、托盘里也找不着、再也叫不回来"（已踩过两次，
/// 只能靠外部命令 ShowWindow 捞回来）。
///
/// 为什么默认值这么定：**她是独立进程，关掉界面不影响她运行**。所以"关窗=退出界面"
/// 没有任何风险（她照常干活，想再看界面重新打开即可），而"关窗=藏起来"在托盘图标
/// 不可见时就是个陷阱。想收进托盘的人自己打开这个开关，那是**显式选择**。
const kCloseToTrayFlag = 'close-to-tray';

/// 开关的内存镜像（只读方拿它，写方走 [setCloseToTray]）。
///
/// 为什么要有这个东西而不是每次去问文件：窗口的关闭事件是**同步**回调
/// （window_manager 的 `onWindowClose`），里面来不及做一次异步读盘；
/// 而 main() 启动时已经读过一次盘了。设置页改开关时同步更新它 + 落盘，
/// 于是"设置页打开开关 → 关窗就收进托盘"在同一次运行里也成立。
final ValueNotifier<bool> closeToTray = ValueNotifier<bool>(false);

/// 改「关窗时收进托盘」：先更新内存镜像（立刻生效），再落盘（下次启动读它）。
Future<void> setCloseToTray(bool value) {
  closeToTray.value = value;
  return saveFlag(kCloseToTrayFlag, value);
}

/// 从状态文件读回「关窗时收进托盘」（读不到即默认 false）。
///
/// 启动时调一次；**结果同时灌进 [closeToTray]**，免得读到的值与内存镜像两处不一致。
Future<bool> restoreCloseToTray() async {
  final value = await loadFlag(kCloseToTrayFlag);
  closeToTray.value = value;
  return value;
}

/// 状态文件路径覆盖：测试指向临时文件，避免踩到真实 %APPDATA% 里的状态。
/// 换文件即重开写入队列——旧链上没跑完的写入属于旧文件。
String? _override;

String? get stateFileOverride => _override;

set stateFileOverride(String? path) {
  _override = path;
  _queue = Future<void>.value();
}

/// 当前状态文件路径（Windows 上 `%APPDATA%/Irmia/ui-state.json`）
String stateFilePath() {
  final override = _override;
  if (override != null && override.isNotEmpty) return override;
  final appData = Platform.environment['APPDATA'] ?? Directory.systemTemp.path;
  return '$appData${Platform.pathSeparator}Irmia${Platform.pathSeparator}ui-state.json';
}

/// 写入队列：loadFlag/saveFlag 串行落盘，避免并发读改写互相覆盖
Future<void> _queue = Future<void>.value();

/// 读一个布尔开关：文件不存在、JSON 坏了、键缺失都当作 false
Future<bool> loadFlag(String key) async {
  await _queue;
  try {
    final file = File(stateFilePath());
    if (!await file.exists()) return false;
    final decoded = jsonDecode(await file.readAsString());
    if (decoded is! Map) return false;
    return decoded[key] == true;
  } catch (_) {
    return false;
  }
}

/// 写一个布尔开关：读改写整份文件，失败静默；并发调用按调用顺序串行
Future<void> saveFlag(String key, bool value) {
  final next = _queue.then((_) => _writeFlag(key, value));
  _queue = next;
  return next;
}

Future<void> _writeFlag(String key, bool value) async {
  try {
    final file = File(stateFilePath());
    final flags = <String, dynamic>{};
    if (await file.exists()) {
      final decoded = jsonDecode(await file.readAsString());
      if (decoded is Map) flags.addAll(decoded.cast<String, dynamic>());
    }
    flags[key] = value;
    await file.parent.create(recursive: true);
    await file.writeAsString(jsonEncode(flags));
  } catch (_) {
    // 写不进去不影响使用：本次会话内照常按内存里的展开态渲染
  }
}
