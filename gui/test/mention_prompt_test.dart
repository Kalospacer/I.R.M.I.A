import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/mention_prompt.dart';
import 'package:irmia_gui/ui_kit.dart';
import 'package:irmia_gui/ui_state.dart';

/// 「她被怎么称呼」的三件事（文本提及唤醒的界面那一半）：
///   ① **该不该问**：没问过且名单空着才问（判据抽成纯函数，直接钉住）；
///   ② **卡面**：标题/按钮/说明都是框架写死的常量，返回值是切好的词表，取消 = null；
///   ③ **保存**：走那条专用命令（`POST /api/commands/set-mention-keywords`，body 是数组）。
///
/// 为什么不在 widget 层测"首次进界面会弹"：那条路要读状态文件、问 `/api/config`、再弹卡，
/// 全是真实异步（实测在 widget 测试里很脆）——判据与卡面分别钉住，接线的部分只剩几行。
class _FakeApi extends IrmiaApi {
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:1');

  final posts = <Map<String, dynamic>>[];

  @override
  Future<dynamic> get(String path) async => <String, dynamic>{'ok': true};

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    posts.add({'path': path, 'body': body, 'confirm': confirm});
    return <String, dynamic>{'ok': true};
  }

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) => const Stream.empty();
}

/// 让卡弹出来：一个按钮触发 [showMentionKeywordsCard]，返回值写进 [result]
Future<void> _pumpCard(
  WidgetTester tester,
  void Function(List<String>?) onResult, {
  List<String> initial = const [],
}) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (context) => Center(
          child: TextButton(
            onPressed: () async => onResult(await showMentionKeywordsCard(context, initial: initial)),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() {
    // 状态文件指向临时文件：别踩真实 %APPDATA% 里的 ui-state.json
    final path = '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-mention-test.json';
    stateFileOverride = path;
  });

  test('该不该问：没问过且名单空着才问', () {
    expect(shouldAskMentionKeywords(askedBefore: false, current: const []), isTrue);
    expect(shouldAskMentionKeywords(askedBefore: true, current: const []), isFalse, reason: '点过「以后再说」就不再问');
    expect(shouldAskMentionKeywords(askedBefore: false, current: const ['弥亚小姐']), isFalse, reason: '已经填过就不打扰');
    expect(shouldAskMentionKeywords(askedBefore: true, current: const ['弥亚小姐']), isFalse);
  });

  testWidgets('卡面：标题与按钮是框架常量，说明说清这几个词干什么用', (tester) async {
    await _pumpCard(tester, (_) {});
    expect(find.text(kMentionCardTitle), findsOneWidget);
    expect(find.text(kMentionCardSaveLabel), findsOneWidget);
    expect(find.text(kMentionCardLaterLabel), findsOneWidget);
    expect(find.text(kMentionCardNote), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('编辑已有名单：回填现值；保存回的是切好的词表', (tester) async {
    List<String>? got;
    await _pumpCard(tester, (value) => got = value, initial: const ['伊尔弥亚', '弥亚小姐']);
    expect(find.text('伊尔弥亚、弥亚小姐'), findsOneWidget, reason: '回填现值，改一个词不用重打一遍');

    await tester.enterText(find.byType(TextField), '伊尔弥亚、弥亚小姐, Irmia  伊尔弥亚');
    await tester.tap(find.text(kMentionCardSaveLabel));
    await tester.pumpAndSettle();
    expect(got, ['伊尔弥亚', '弥亚小姐', 'Irmia'], reason: '去重且保序');
    // 输入控制器是"退场之后再销毁"的（600ms，见 ui_kit 里那段注释）：把那个定时器走完，
    // 否则测试结束时会报"A Timer is still pending"
    await tester.pump(const Duration(milliseconds: 700));
  });

  testWidgets('取消：回 null（调用方据此一个字节都不写）', (tester) async {
    var called = false;
    List<String>? got;
    await _pumpCard(tester, (value) {
      called = true;
      got = value;
    });
    await tester.tap(find.text(kMentionCardLaterLabel));
    await tester.pumpAndSettle();
    expect(called, isTrue);
    expect(got, isNull);
    await tester.pump(const Duration(milliseconds: 700));
  });

  testWidgets('保存走 set-mention-keywords，body 是数组（与其它写配置的命令同一条纪律）', (tester) async {
    final api = _FakeApi();
    final state = AppState(api: api);
    final problem = await state.saveMentionKeywords(const ['弥亚小姐', 'Irmia']);
    expect(problem, isNull);
    expect(api.posts.single['path'], '/api/commands/set-mention-keywords');
    expect(api.posts.single['confirm'], 'set-mention-keywords');
    expect(api.posts.single['body']['keywords'], ['弥亚小姐', 'Irmia']);
  });

  test('词表切分与服务端同一口径：逗号/顿号/空白都是分隔符，去重且保序', () {
    expect(splitMentionKeywords('伊尔弥亚、弥亚小姐, Irmia'), ['伊尔弥亚', '弥亚小姐', 'Irmia']);
    expect(splitMentionKeywords('  伊尔弥亚   伊尔弥亚  '), ['伊尔弥亚']);
    expect(splitMentionKeywords(''), isEmpty);
    expect(splitMentionKeywords('、，  '), isEmpty);
  });
}
