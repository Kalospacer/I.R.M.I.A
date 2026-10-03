import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/ui_state.dart';

/// 「关窗时收进托盘」这个界面偏好的**默认值与往返**（2026-10-04）。
///
/// 锁三件事：
///   ① 键名是 `close-to-tray`、**默认 false**——默认值就是那个交互陷阱的根：
///      关窗=藏起来而托盘图标被系统收进"隐藏的图标"面板时，窗口再也叫不回来；
///   ② 写盘之后 `restoreCloseToTray()` 读回来是同值（main.dart 启动时靠它决定拦不拦关闭）；
///   ③ 键缺失 / 文件坏掉一律回落到 false，**不**回落成 true——
///      读不到偏好时"点 × 干净地退出"永远比"点 × 藏起来"安全。
void main() {
  late Directory tmpDir;
  late String path;

  setUp(() {
    tmpDir = Directory.systemTemp.createTempSync('irmia-ui-state-close-');
    path = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';
    stateFileOverride = path;
    // 内存镜像是全局的：每条用例从默认值起跑，免得互相串
    closeToTray.value = false;
  });

  tearDown(() {
    stateFileOverride = null;
    closeToTray.value = false;
    try {
      tmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 清不掉临时目录不影响断言
    }
  });

  /// 直接读那份 json（不走 loadFlag）：要断言的是"盘上到底写了什么键"
  Map<String, dynamic> readFile() =>
      jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;

  test('默认 false：没写过这个键时读回来就是 false（关窗 = 退出界面）', () async {
    expect(kCloseToTrayFlag, 'close-to-tray');
    expect(await loadFlag(kCloseToTrayFlag), isFalse);
    expect(closeToTray.value, isFalse, reason: '内存镜像的默认值同样是 false');
    expect(await restoreCloseToTray(), isFalse);
    expect(closeToTray.value, isFalse);
  });

  test('打开开关：写盘 + 内存镜像立刻变 true，重启后读得回来', () async {
    await setCloseToTray(true);

    expect(closeToTray.value, isTrue, reason: '本次运行里就该生效（关窗回调读的是内存镜像）');
    expect(readFile()[kCloseToTrayFlag], isTrue, reason: '键名与值都要落盘');
    // 「重启」那一步：重新读一次盘（restoreCloseToTray 就是 main() 启动时那个动作）
    closeToTray.value = false;
    expect(await restoreCloseToTray(), isTrue);
    expect(closeToTray.value, isTrue);
  });

  test('关回去：写盘也是 false，重启后回到默认行为', () async {
    await setCloseToTray(true);
    await setCloseToTray(false);

    expect(closeToTray.value, isFalse);
    expect(readFile()[kCloseToTrayFlag], isFalse);
    closeToTray.value = true;
    expect(await restoreCloseToTray(), isFalse);
    expect(closeToTray.value, isFalse);
  });

  test('改这个键不动别的键（整份文件是读改写，不是覆写）', () async {
    await saveFlag('moreGroupOpen', true);
    await setCloseToTray(true);

    final flags = readFile();
    expect(flags['moreGroupOpen'], isTrue, reason: '别人的键要留着');
    expect(flags[kCloseToTrayFlag], isTrue);
  });

  test('文件坏掉时回落 false，不回落 true', () async {
    await setCloseToTray(true);
    File(path).writeAsStringSync('{ 这不是 json');

    expect(await loadFlag(kCloseToTrayFlag), isFalse);
    expect(await restoreCloseToTray(), isFalse);
    expect(closeToTray.value, isFalse);
  });
}
