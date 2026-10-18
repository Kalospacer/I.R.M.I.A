// TODO(i18n): 本文件还有 1 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/shell/tray.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:tray_manager/tray_manager.dart';

import '../her_name.dart';
import '../i18n/app_strings.dart';

/// Irmia GUI 的**托盘**（2026-10-04 用户要的托盘化）。
///
/// 她是常驻的，界面不该"关掉就没了"。所以：
///   • 关窗默认**退出界面**（她照常跑），只有人在设置页显式打开「关窗时收进托盘」才隐藏
///     ——见 main.dart 的 `_CloseToTray` 与 ui_state.dart 的 [kCloseToTrayFlag]；
///   • **菜单五项**（2026-10-17 改）：显示界面 / 收进托盘 / 重启前后端 /
///     **退出界面** / **退出全部（界面 + 后端）**。"收进托盘"作为**显式动作**永远可用，
///     与关窗那个偏好是两件事；
///   • **重启只有一条路**：`lib/restart_action.dart` 的 [performRestart] —— 与首页那颗
///     「重启前后端」**同一个函数、同一套三态判据**（改之前两条路一套严一套松，现场见那个文件）；
///   • **退出为什么分成两项**（用户 2026-10-17 ②）：
///     原来的「退出」只 `windowManager.destroy()`，后端照旧在跑——而菜单上那句话是"退出"，
///     人读成"整个应用都退了"。可是"关掉界面、她继续值守"恰恰是这个框架的**常态**
///     （见 main.dart 的说明：她是独立进程），一刀切把它变成"连后端一起退"会把最常用的
///     那个动作变危险。两项各有各的语义、各有各的代价，所以分开摆：
///       · 「退出界面（她继续在后台运行）」= 老行为，**零风险**（后端与协议端都不动）；
///       · 「退出全部（界面 + 后端）」= 真把后端（连同它拉起的协议端）停掉，代价写在确认框里
///         （硬杀：`session/end` 与协议端收尸都会丢，协议端可能要重登一次）。
///     判据：一个"退出"若两件事都做，就没有任何入口能做那件安全的事；反过来若只做安全那件，
///     人就被迫去任务管理器做另一件（正是用户报的毛病）。**两项**是唯一都对得上的形状。
///   • 悬停提示写的是**她的名字**（`persona/IDENTITY.md` 的「名字：」那一行），
///     不再是写死的一个名字：名字读不到时显示产品名（见 [setDisplayName] 与 her_name.dart）。
///
/// 本文件**只认菜单与插件**：窗口怎么显示/隐藏、退出要不要写标记、怎么停后端，
/// 全在宿主（app.dart）注入的 [TrayActions] 里。这样"菜单项 → 哪一个动作"可以用例钉住
/// （[dispatchTrayMenu] 是纯函数），而插件那一层不需要在测试里跑。
class IrmiaTray with TrayListener {
  IrmiaTray._();

  static final IrmiaTray instance = IrmiaTray._();

  /// 宿主注入的四个动作（都来自 app.dart，本文件不碰窗口、不碰后端）
  TrayActions _actions = const TrayActions(
    show: _noop,
    hide: _noop,
    restart: _noopAsync,
    quitUi: _noop,
    quitAll: _noop,
  );

  bool _installed = false;

  /// **托盘提示里的名字**（悬停时那行字）。
  ///
  /// 它显示的是她的名字，而名字是异步读来的（`persona/IDENTITY.md`），所以这里先留一个
  /// 回退值：`her_name.dart` 的保守口径——读不到就显示产品名，绝不显示一个像是她名字的东西。
  /// 托盘是**常驻**的（关窗之后它是唯一还看得见的东西），猜错一个名字比空着更糟。
  String _displayName = kProductName;

  /// 托盘**真的装上了**没有。
  ///
  /// 给宿主判断用：装不上（某些精简系统没有通知区域、或 Shell_NotifyIcon 失败）时，
  /// 绝不能把关窗改成"隐藏"——那会让人点一下 X 就再也叫不回界面，只能任务管理器。
  bool get installed => _installed;

  /// 装托盘。`actions` 是四个动作的落点（见 [TrayActions]）；
  /// `strings` 只用来画菜单文字（`refreshMenu` 换了语言再画一遍）。
  Future<void> install({
    required TrayActions actions,
    required AppStrings strings,
    String? displayName,
  }) async {
    _actions = actions;
    if (displayName != null && displayName.trim().isNotEmpty) _displayName = displayName.trim();
    if (_installed) return;

    trayManager.addListener(this);
    await trayManager.setIcon(_iconPath);
    await trayManager.setToolTip(_displayName);
    await trayManager.setContextMenu(Menu(items: trayMenuItems(strings)));
    _installed = true;
  }

  /// 语言换了之后把菜单文字重画一遍（`effectiveLanguage` 一变就调）。
  ///
  /// 为什么值得单独一个方法：菜单是**插件那边的原生对象**，不跟着 Flutter 重建；
  /// 不重画的话"切到 English 了、托盘还是中文"，而这种不一致没人会想到去查。
  Future<void> refreshMenu(AppStrings strings) async {
    if (!_installed) return;
    try {
      await trayManager.setContextMenu(Menu(items: trayMenuItems(strings)));
    } catch (_) {
      // 重画失败不影响托盘还活着：下次 `install`（下一次启动）会画对
    }
  }

  /// 她的名字读到（或改了）之后更新托盘提示。
  ///
  /// 三件事：值没变就直接返回（宿主每次轮询都会调到这里，不该每 10 秒捅一次系统托盘）；
  /// 托盘没装成就只记下来（[install] 下次用它）；系统调用失败就吞掉——
  /// 一个提示文字换不掉，不值得让界面上报错，更不该把已经装好的托盘标记成没装。
  Future<void> setDisplayName(String name) async {
    final next = name.trim().isEmpty ? kProductName : name.trim();
    if (next == _displayName) return;
    _displayName = next;
    if (!_installed) return;
    try {
      await trayManager.setToolTip(_displayName);
    } catch (_) {
      // 忽略：提示文字是锦上添花
    }
  }

  /// 拆掉托盘（退出流程用；托盘是常驻资源，退出前要收干净）
  Future<void> remove() async {
    if (!_installed) return;
    _installed = false;
    try {
      trayManager.removeListener(this);
      await trayManager.destroy();
    } catch (_) {
      // 拆不掉也不该拦住退出
    }
  }

  /// 托盘图标：直接用 runner 里那份应用图标（省得再放一份、两份还会不一致）
  String get _iconPath {
    if (Platform.isWindows) {
      final exeDir = File(Platform.resolvedExecutable).parent.path;
      return '$exeDir${Platform.pathSeparator}data${Platform.pathSeparator}flutter_assets'
          '${Platform.pathSeparator}assets${Platform.pathSeparator}tray.ico';
    }
    return 'assets/tray.ico';
  }

  @override
  void onTrayIconMouseDown() {
    // 左键点图标：显示并聚焦（Windows 上的习惯）
    _actions.show();
  }

  @override
  void onTrayIconRightMouseDown() {
    // **bringAppToFront: true 不是可选项**：Win32 要求托盘菜单的属主窗口先成为前台窗口，
    // 否则菜单点外面不会消失（MSDN 明写）。tray_manager 的默认值是 false，所以必须显式传。
    // 这个参数被标了 deprecated（插件作者说以后会移除），但它是目前**唯一**能让菜单正常
    // 消失的开关；等插件给出替代写法再换，先按下不表（analyze 这行显式豁免，别当没看见）。
    // ignore: deprecated_member_use
    unawaited(trayManager.popUpContextMenu(bringAppToFront: true));
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    dispatchTrayMenu(menuItem.key ?? '', _actions);
  }
}

/// 托盘菜单项的**点击分发**（纯逻辑：不碰插件、不碰窗口，用例可以直接调它钉住"哪一项做哪件事"）。
///
/// 认不出的 key 什么都不做：菜单将来加了项而这里忘了接，症状是"点了没反应"，
/// 比"点了一个不知道是什么的动作"好些。
void dispatchTrayMenu(String key, TrayActions actions) {
  switch (key) {
    case kTrayKeyShow:
      actions.show();
      break;
    case kTrayKeyHide:
      actions.hide();
      break;
    case kTrayKeyRestart:
      // 与首页那颗按钮**同一个函数**（见 lib/restart_action.dart）：
      // 请求、三态判据、说的话、等回来的窗口，全部只有一份。
      unawaited(actions.restart());
      break;
    case kTrayKeyQuitUi:
      actions.quitUi();
      break;
    case kTrayKeyQuitAll:
      actions.quitAll();
      break;
  }
}

/// 菜单项 key（字符串：`MenuItem.key` 是 String?，插件那边也是这个值回来）
const String kTrayKeyShow = 'show';
const String kTrayKeyHide = 'hide';
const String kTrayKeyRestart = 'restart';
const String kTrayKeyQuitUi = 'quit-ui';
const String kTrayKeyQuitAll = 'quit-all';

/// 四个动作的落点（宿主注入；测试里可以给空实现）。
class TrayActions {
  const TrayActions({
    required this.show,
    required this.hide,
    required this.restart,
    required this.quitUi,
    required this.quitAll,
  });

  /// 显示并聚焦窗口
  final VoidCallback show;

  /// 收进托盘（界面还在跑）
  final VoidCallback hide;

  /// 重启前后端（与首页那颗按钮同一个函数）
  final Future<void> Function() restart;

  /// 只退出界面（后端继续在后台跑）
  final VoidCallback quitUi;

  /// 退出全部（界面 + 后端）
  final VoidCallback quitAll;
}

/// 菜单的**内容与措辞**（顺序就是屏幕上从上到下）。纯函数 + 文案表：
/// 中英各一份由 [AppStrings] 给，菜单文字不在这里写死。
List<MenuItem> trayMenuItems(AppStrings strings) => <MenuItem>[
      MenuItem(key: kTrayKeyShow, label: strings.trayShow),
      MenuItem(key: kTrayKeyHide, label: strings.trayHide),
      MenuItem.separator(),
      MenuItem(key: kTrayKeyRestart, label: strings.trayRestart),
      MenuItem.separator(),
      // **两项退出**：一个只关界面（安全、常用），一个连后端一起（重、有代价）。
      // 措辞里就把区别写清楚——菜单只有一行字的地方，正是最该说准的地方。
      MenuItem(key: kTrayKeyQuitUi, label: strings.trayQuitUi),
      MenuItem(key: kTrayKeyQuitAll, label: strings.trayQuitAll),
    ];

void _noop() {}

Future<void> _noopAsync() async {}

void unawaited(Future<void> future) {
  future.ignore();
}
