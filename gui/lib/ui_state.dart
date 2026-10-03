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
