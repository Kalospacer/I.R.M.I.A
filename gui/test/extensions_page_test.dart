import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/extensions_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';
import 'package:irmia_gui/ui_state.dart';

/// MCP 与 Hooks 两个页签的空态（用户 ⑰：空态与它下面那张解释卡"太不协调太丑"）。
///
/// 这三条锁钉的是**形态**，不是文案：
///   ① 空态里不再有那枚与页头重复的按钮——页头那枚现在是唯一入口（「消息适配器」页同一条规矩）；
///   ② 空态与"有内容时的卡片"**同一个矩形**（同左沿、同右沿、同顶边）：空态收成了卡内一行，
///      不再是封在 560 宽里、图标 + 居中文字 + 按钮的一大块；
///   ③ 底部那条「从这里开始」并进了空态（不再两块摞着），有内容时它照旧在。
///
/// 写这一组之前先确认过新形态是对的（真机截图 + 与同页「技能」页签有内容时的版式对照），
/// 不是把断言改绿——所以这里断言的是"空态落在哪张卡里、和谁同宽"，不是"有没有某句话"。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;

  /// 只读替身：这一组测试只切页签、不点任何写动作，所以没有 post 记录
  @override
  Future<dynamic> get(String path) async => routes[path];
}

void main() {
  // 本机忽略标记会落 ui_state：测试指向临时文件，别踩真实 %APPDATA% 里的状态
  setUpAll(() {
    stateFileOverride = '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-empty-test.json';
  });

  final skills = <String, dynamic>{
    'items': <dynamic>[],
    'rejected': <dynamic>[],
    'catalogTokens': 0,
    'ignored': <dynamic>[],
  };
  final tools = <String, dynamic>{'groups': <dynamic>[], 'tools': <dynamic>[]};

  final mcpEmpty = <String, dynamic>{
    'servers': <dynamic>[],
    'problems': <dynamic>[],
    'registeredCount': 0,
    'runningCount': 0,
  };
  final mcpOne = <String, dynamic>{
    'servers': [
      {
        'name': 'filesystem',
        'command': 'npx',
        'args': ['-y', '@modelcontextprotocol/server-filesystem'],
        'env': <String, dynamic>{},
        'disabled': false,
        'state': 'never-started',
        'toolsCount': 0,
        'registeredTools': <dynamic>[],
        'toolDetails': <dynamic>[],
      },
    ],
    'problems': <dynamic>[],
    'registeredCount': 0,
    'runningCount': 0,
  };

  final hooksEmpty = <String, dynamic>{
    'entries': <dynamic>[],
    'problems': <dynamic>[],
    'relative': 'data/hooks.json',
    'hookPoints': ['PreToolUse', 'PostToolUse', 'Wake'],
    'defaultTimeoutMs': 10000,
    'enabledCount': 0,
    'disabledCount': 0,
  };
  final hooksOne = <String, dynamic>{
    ...hooksEmpty,
    'entries': [
      {
        'index': 0,
        'hook': 'PreToolUse',
        'matcher': 'pwsh',
        'command': 'node check.mjs',
        'timeoutMs': 10000,
        'enabled': true,
      },
    ],
    'enabledCount': 1,
  };

  /// 开一页扩展页并切到指定页签。宽窗（1400）：左列表与右详情同屏，点行只是换详情。
  Future<void> pumpTab(
    WidgetTester tester, {
    required Map<String, dynamic> mcp,
    required Map<String, dynamic> hooks,
    required String tab,
  }) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = AppState(
      api: _FakeApi({
        '/api/skills': skills,
        '/api/mcp': mcp,
        '/api/tools': tools,
        '/api/hooks': hooks,
      }),
    );
    // 先前卸掉上一棵树，再开这一页。同一个用例里连着开两页做"空态 ⟷ 有内容"的对照时，
    // 直接二次 `pumpWidget` 只是把新的 AppState 交给**原来那个** State——元素按类型原地复用，
    // `initState` 不再跑，页面就拿着上一份数据装作已经加载完了（第 3、4 条曾因此红）。
    // 卸掉才是注释里那句"开一页"，与 `shell_layout_test.dart` 的"重建壳 = 重启"同一招。
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ExtensionsPage(state: state)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.byKey(ValueKey('ext-item-$tab')));
    await tester.pump();
  }

  /// 页头那枚「钩子条目」卡（空态与有内容时都是它）——按标题文字找它最近的 Container：
  /// 标题与这张卡之间没有别的 Container，所以 `.first` 就是卡片本身。
  Finder hooksCard() =>
      find.ancestor(of: find.text('钩子条目'), matching: find.byType(Container)).first;

  /// 卡里不许再长按钮：按钮是页头的事（`ButtonStyleButton` 用谓词匹配，`byType` 不认子类）
  final anyButton = find.byWidgetPredicate((widget) => widget is ButtonStyleButton);

  /// 页头那枚实心按钮：按**子类**找，因为页头是 `FilledButton.icon` 建的——它的运行时类型是
  /// `_FilledButtonWithIcon extends FilledButton`，而 `find.byType` 只认精确类型，
  /// `find.widgetWithText(FilledButton, …)` 在这儿一枚都找不到（就是上面 `anyButton` 那条注释说的事）。
  /// 要钉的语义不变：屏幕上那一处文字，落在一枚实心按钮里。
  Finder filledWith(String text) =>
      find.ancestor(of: find.text(text), matching: find.bySubtype<FilledButton>());

  testWidgets('MCP 空态：一张卡里一行现状 + 解释，页头那枚是唯一入口', (tester) async {
    await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'mcp');

    final empty = find.byKey(const ValueKey('mcp-empty'));
    expect(empty, findsOneWidget, reason: '空态是一张卡（与服务卡同壳），不是跟卡片不同宽的一大块');

    // 页头那枚在，且是那个动作在这一屏上的唯一一枚
    expect(find.text('添加服务'), findsOneWidget, reason: '页头那枚按钮是唯一入口');
    expect(filledWith('添加服务'), findsOneWidget);
    expect(find.descendant(of: empty, matching: anyButton), findsNothing,
        reason: '空态自己再长一枚按钮，就是用户圈出来的"同一个动作一屏两次"');
    expect(find.descendant(of: empty, matching: find.text('添加服务')), findsNothing,
        reason: '空态里不再出现那枚按钮的文字');

    // 那一大块居中提示整块撤掉（不是缩小、不是改文案）
    expect(find.byType(StateBlock), findsNothing);
    expect(find.byType(HintLine), findsNWidgets(3), reason: '现状一行 + 并进来的两句解释');

    // 现状与解释在**同一张卡**里，且解释确实落在卡片矩形之内
    final cardRect = tester.getRect(empty);
    expect(find.descendant(of: empty, matching: find.textContaining('还没有配置 MCP 服务')), findsOneWidget);
    for (final line in ['还没有配置 MCP 服务', '按需拉起', '按 destructive 处理']) {
      // 限定在卡内找（上一行就是这么写的）：页头那行分区简介里也有"按需拉起"这四个字，
      // 同一屏两处，不限定范围会一次命中两个，`getRect` 当场抛 ambiguous。
      // 要钉的语义没变——这一句落在卡片矩形之内，没跑到卡外去。
      final lineRect = tester.getRect(find.descendant(of: empty, matching: find.textContaining(line)));
      expect(cardRect.contains(lineRect.center), isTrue, reason: '「$line」不该跑到卡外去');
    }
    expect(find.text('从这里开始'), findsNothing, reason: '解释并进来了，就不再单独摞一条引导卡');
    expect(tester.takeException(), isNull);
  });

  testWidgets('Hooks 空态：还是「钩子条目」那张卡，卡里一行提示，页头那枚是唯一入口', (tester) async {
    await pumpTab(tester, mcp: mcpOne, hooks: hooksEmpty, tab: 'hooks');

    expect(find.text('钩子条目'), findsOneWidget, reason: '空态用的就是有内容时那张卡（连标题都不变）');
    final card = hooksCard();
    expect(find.text('添加钩子'), findsOneWidget, reason: '页头那枚按钮是唯一入口');
    expect(filledWith('添加钩子'), findsOneWidget);
    expect(find.descendant(of: card, matching: anyButton), findsNothing);
    expect(find.descendant(of: card, matching: find.text('添加钩子')), findsNothing);

    expect(find.byType(StateBlock), findsNothing);
    expect(find.byType(HintLine), findsOneWidget);

    // 现状与"钩子能做什么"这一句解释同处一行（原在底部「从这里开始」里）
    final line = find.textContaining('还没有配置钩子');
    expect(find.descendant(of: card, matching: line), findsOneWidget);
    expect(find.descendant(of: card, matching: find.textContaining('拒绝工具调用')), findsOneWidget);
    expect(tester.getRect(card).contains(tester.getRect(line).center), isTrue);
    expect(find.text('从这里开始'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('空态与"有内容时的卡片"同左沿、同右沿、同顶边（两个页签各比一次）', (tester) async {
    // MCP：空态 ⟷ 第一张服务卡（服务卡与空态共用一个外壳，矩形该一模一样）
    await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'mcp');
    final mcpEmptyRect = tester.getRect(find.byKey(const ValueKey('mcp-empty')));
    await pumpTab(tester, mcp: mcpOne, hooks: hooksOne, tab: 'mcp');
    final mcpCardRect = tester.getRect(find.byKey(const ValueKey('mcp-filesystem')));
    expect(mcpEmptyRect.left, closeTo(mcpCardRect.left, 0.5));
    expect(mcpEmptyRect.right, closeTo(mcpCardRect.right, 0.5));
    expect(mcpEmptyRect.width, closeTo(mcpCardRect.width, 0.5));
    expect(mcpEmptyRect.top, closeTo(mcpCardRect.top, 0.5), reason: '都从摘要行下面那条线开始，不是垂直居中悬浮');

    // Hooks：空态 ⟷ 有条目时那张卡（同一个标题、同一个矩形）
    await pumpTab(tester, mcp: mcpOne, hooks: hooksEmpty, tab: 'hooks');
    final hooksEmptyRect = tester.getRect(hooksCard());
    await pumpTab(tester, mcp: mcpOne, hooks: hooksOne, tab: 'hooks');
    final hooksFilledRect = tester.getRect(hooksCard());
    expect(hooksEmptyRect.left, closeTo(hooksFilledRect.left, 0.5));
    expect(hooksEmptyRect.right, closeTo(hooksFilledRect.right, 0.5));
    expect(hooksEmptyRect.width, closeTo(hooksFilledRect.width, 0.5));
    expect(hooksEmptyRect.top, closeTo(hooksFilledRect.top, 0.5));

    // 两个页签的空态同左沿同宽：四个页签的第一个方块落在同一条线上
    expect(mcpEmptyRect.left, closeTo(hooksEmptyRect.left, 0.5));
    expect(mcpEmptyRect.right, closeTo(hooksEmptyRect.right, 0.5));
    expect(tester.takeException(), isNull);
  });

  testWidgets('有内容时底部那条「从这里开始」照旧（空态只是把它并进去了，没删）', (tester) async {
    await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'hooks');
    expect(find.byKey(const ValueKey('hook-0')), findsOneWidget);
    expect(find.text('从这里开始'), findsOneWidget, reason: '有内容时引导条照旧摆在最下面');

    await pumpTab(tester, mcp: mcpOne, hooks: hooksOne, tab: 'mcp');
    expect(find.text('从这里开始'), findsOneWidget);
    expect(find.byKey(const ValueKey('mcp-filesystem')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
