import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/shell/tray.dart';

/// 托盘菜单：**两项退出必须都在，而且措辞上分得清**（用户 2026-10-17 ②）。
///
/// 现场：原来菜单上只有一项「退出」，它只 `windowManager.destroy()`——后端照旧在跑，
/// 而"退出"这两个字被人读成"整个应用都退了"。修法是把两件事分成两项：
///   · 「退出界面（她继续在后台运行）」= 老行为，零风险；
///   · 「退出全部（界面 + 后端）」= 真把后端（连同协议端）停掉，代价写在确认框里。
///
/// 这一组只钉菜单与分发（不碰插件、不弹真托盘）：`trayMenuItems` 与 `dispatchTrayMenu`
/// 都是纯函数，正好可以把"哪一项做什么、写得说不说得清"钉住。
void main() {
  group('菜单内容', () {
    test('五项 + 两个分隔线：顺序与 key 固定', () {
      final items = trayMenuItems(const ZhStrings());
      final keys = <String>[
        for (final item in items)
          if (item.key != null) item.key!,
      ];
      expect(keys, <String>[
        kTrayKeyShow,
        kTrayKeyHide,
        kTrayKeyRestart,
        kTrayKeyQuitUi,
        kTrayKeyQuitAll,
      ]);
      // 三个分隔线位：显示/收进托盘 与 重启 之间、重启 与 退出 之间、以及……这里只核数量不猜位置
      expect(items.where((item) => item.key == null).length, greaterThanOrEqualTo(2),
          reason: '分隔线把"显示/收进托盘""重启""退出"三族分开');
    });

    test('两项退出的文案把区别说清：一项提后台、一项提后端', () {
      final items = trayMenuItems(const ZhStrings());
      String labelOf(String key) =>
          items.firstWhere((item) => item.key == key).label ?? '';

      final quitUi = labelOf(kTrayKeyQuitUi);
      final quitAll = labelOf(kTrayKeyQuitAll);
      expect(quitUi, contains('界面'));
      expect(quitUi, contains('后台'), reason: '只关界面时她还在跑——这句话必须在菜单上就能读到');
      expect(quitUi, isNot(contains('后端')), reason: '只关界面不动后端，别把它说成重动作');
      expect(quitAll, contains('后端'), reason: '这一项才是真的连后端一起');
      expect(quitUi, isNot(quitAll), reason: '两项一模一样的字等于没有分开');
    });

    test('英文菜单同样分开（i18n 口径：两条各一条，别只迁一半）', () {
      final items = trayMenuItems(const EnStrings());
      String labelOf(String key) =>
          items.firstWhere((item) => item.key == key).label ?? '';
      expect(labelOf(kTrayKeyQuitUi).toLowerCase(), contains('ui'));
      expect(labelOf(kTrayKeyQuitAll).toLowerCase(), contains('backend'));
      expect(labelOf(kTrayKeyQuitUi), isNot(labelOf(kTrayKeyQuitAll)));
      expect(labelOf(kTrayKeyRestart), isNotEmpty);
    });
  });

  group('点击分发', () {
    test('每一项调且只调自己那一个动作', () async {
      final calls = <String>[];
      final actions = TrayActions(
        show: () => calls.add('show'),
        hide: () => calls.add('hide'),
        restart: () async => calls.add('restart'),
        quitUi: () => calls.add('quitUi'),
        quitAll: () => calls.add('quitAll'),
      );
      const expected = <String, String>{
        kTrayKeyShow: 'show',
        kTrayKeyHide: 'hide',
        kTrayKeyRestart: 'restart',
        kTrayKeyQuitUi: 'quitUi',
        kTrayKeyQuitAll: 'quitAll',
      };
      for (final entry in expected.entries) {
        calls.clear();
        dispatchTrayMenu(entry.key, actions);
        // restart 是 async：让它的第一段跑完再看
        await Future<void>.delayed(Duration.zero);
        expect(calls, <String>[entry.value], reason: '${entry.key} 只该做 ${entry.value}');
      }
    });

    test('认不出的 key 什么都不做（将来加了菜单项却忘了接线时，不点瞎动作）', () async {
      final calls = <String>[];
      final actions = TrayActions(
        show: () => calls.add('show'),
        hide: () => calls.add('hide'),
        restart: () async => calls.add('restart'),
        quitUi: () => calls.add('quitUi'),
        quitAll: () => calls.add('quitAll'),
      );
      dispatchTrayMenu('no-such-item', actions);
      dispatchTrayMenu('', actions);
      await Future<void>.delayed(Duration.zero);
      expect(calls, isEmpty);
    });
  });
}
