import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/onboarding.dart';
// 信任范围那一步的两档字面量与那个二选一控件都在设置页里（两处共用一份，见 TrustModeChoice）
import 'package:irmia_gui/pages/settings_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 让假服务"真的写下去"：这样第二次读现状时看到的就是改过之后的样子
void applyCommand(Map<String, dynamic> config, Map<String, dynamic> keys, Map<String, String> persona,
    String path, Map<String, dynamic> body) {
  switch (path) {
    case '/api/commands/set-mention-keywords':
      (config['channels'] as Map<String, dynamic>)['mentionKeywords'] = body['keywords'];
    case '/api/commands/config-update':
      for (final entry in (body['fields'] as Map).entries) {
        final segments = (entry.key as String).split('.');
        Map<String, dynamic> cursor = config;
        for (final segment in segments.take(segments.length - 1)) {
          cursor = cursor[segment] as Map<String, dynamic>;
        }
        cursor[segments.last] = entry.value;
      }
    case '/api/commands/set-key':
      keys[body['name'] as String] = {'configured': true, 'mask': 'sk-…t3st'};
    case '/api/commands/persona-edit':
      persona[body['file'] as String] = body['content'] as String;
  }
}

/// 首次启动引导（四步：她叫什么 / API 配置 / 消息适配器 / 人格）：
///   ① **判据**（[shouldShowOnboarding]）——抽成纯函数，直接钉住；
///   ② **四步各写哪条通道、带什么确认短语**——用真实 loopback 假服务记下每一次 POST；
///   ③ **"不再弹"落在 ui-state.json**——走完一次之后，再开一次宿主就不该弹。
///
/// 假服务的响应形状照 src/web/server.ts 的真实回包写（persona/files 的 isSeed、
/// set-key 的 {configured,mask}、persona-edit 的 changed）。
void main() {
  late HttpServer server;
  late AppState state;
  late Map<String, dynamic> config;
  late Map<String, dynamic> keys;
  late Map<String, String> persona;
  late List<Map<String, dynamic>> posts;

  /// 假服务是否拒绝写命令（用来钉住"失败留在原地、不静默丢"）
  bool failCommands = false;

  /// 种子模板与"人写过的一份"：形状照 src/persona/loader.ts 的 SEEDS 抄——
  /// 种子里那句「名字：（改成她的名字）」是**占位符**，不是她的名字（判据见 her_name.dart）。
  const seedIdentity = '<!-- SEED 填写后删除本行 -->\n'
      '<!-- 她的名字写在下面「名字：」那一行 -->\n'
      '# 我是谁\n\n'
      '名字：（改成她的名字）\n\n'
      '（身份、核心性格。）\n';
  const writtenIdentity = '# 我是谁\n\n我是小七，这台机器上常驻的伙伴。\n';

  setUp(() async {
    // TestWidgetsFlutterBinding 默认把所有 HttpClient 请求挡成 400，本组要打真实服务
    HttpOverrides.global = null;
    failCommands = false;
    posts = [];
    config = {
      'models': {
        'heavy': {'model': 'deepseek-chat', 'baseUrl': 'https://api.deepseek.com'},
        'light': {'model': 'deepseek-chat', 'baseUrl': 'https://api.deepseek.com'},
      },
      'channels': {
        'qqOfficial': {'enabled': false},
        'onebot': {'enabled': false},
        'mentionKeywords': <String>[],
      },
    };
    keys = {
      'heavy': {'configured': false, 'mask': null},
      'light': {'configured': false, 'mask': null},
    };
    persona = {'IDENTITY.md': seedIdentity, 'CONSTITUTION.md': '<!-- SEED -->\n# 行为宪法\n'};

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final response = req.response..headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path.startsWith('/api/commands/')) {
        final body = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>;
        posts.add({
          'path': path,
          'body': body,
          'confirm': req.headers.value('X-Confirm'),
        });
        if (failCommands) {
          response.statusCode = 400;
          response.write(jsonEncode({
            'error': {'code': 'bad-request', 'message': '测试里故意失败'},
          }));
        } else {
          applyCommand(config, keys, persona, path, body);
          response.write(jsonEncode({'ok': true}));
        }
      } else if (path == '/api/config') {
        response.write(jsonEncode(config));
      } else if (path == '/api/keys') {
        response.write(jsonEncode(keys));
      } else if (path == '/api/persona/files') {
        response.write(jsonEncode({
          'root': 'D:/irmia/data/persona',
          'files': [
            for (final entry in persona.entries)
              {
                'path': entry.key,
                'name': entry.key,
                'bytes': utf8.encode(entry.value).length,
                'mtime': '2026-10-01T00:00:00.000Z',
                'reserved': true,
                'tokens': 20,
                'proposalCount': 0,
                'proposals': 0,
                'isSeed': entry.value.contains('<!-- SEED'),
              },
          ],
          'relationships': <String>[],
          'proposals': <String>[],
        }));
      } else if (path == '/api/persona/file') {
        final asked = req.uri.queryParameters['path'] ?? '';
        response.write(jsonEncode({
          'path': asked,
          'content': persona[asked] ?? '',
          'bytes': 0,
          'mtime': '2026-10-01T00:00:00.000Z',
          'tokens': 0,
          'reserved': true,
        }));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({'error': {'message': '接口不存在'}}));
      }
      unawaited(response.close());
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
  });

  tearDown(() async {
    state.dispose();
    await server.close(force: true);
  });

  /// 状态文件指向每次独立的临时文件：别踩真实 %APPDATA% 里的 ui-state.json，
  /// 也别让上一条用例留下的 `onboarding-done` 把下一条挡住。
  ///
  /// 文件名里带上**进程号**：同一个临时目录里跑两份用例（两个工作区、两个进程同时验这套东西）
  /// 时，两份进程会用同一个路径，先跑的那份把文件占住，后一份连删都删不掉
  /// （实测：`deleteSync` 报 OS Error 32，用例在第一步就挂）。加了 pid 各写各的。
  void useStateFile(String name) {
    final path = '${Directory.systemTemp.path}${Platform.pathSeparator}'
        'irmia-ui-state-$name-$pid.json';
    stateFileOverride = path;
    final file = File(path);
    if (file.existsSync()) file.deleteSync();
  }

  /// 交替推进真异步与假时钟：HttpClient 每一步都要先让真实 I/O 跑完，再 pump 落进树
  Future<void> pumpUntil(WidgetTester tester, Finder target, {int rounds = 80}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      if (target.evaluate().isNotEmpty) {
        await tester.pump();
        return;
      }
    }
    fail('等待目标未出现：$target');
  }

  /// 收尾：把还在飞的请求、toast 与"退场后销毁控制器"的定时器跑完。
  ///
  /// 顺序很重要：**先**让真实 I/O 跑完（`runAsync`），**再**把假时钟推过 600ms 那道关
  /// （`disposeLater` 的定时器）——反过来的话，定时器是在推时钟之后才被创建的，测试收尾时
  /// 就会报 "A Timer is still pending"（实测踩到过）。
  Future<void> drain(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
    await tester.pump(const Duration(seconds: 2));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
  }

  /// 用例收尾：把树拆掉（卡片 dispose 会排下"退场后销毁控制器"的定时器），再 flush 一次。
  ///
  /// 为什么不能只用 [drain]：卡还挂在树上时那几个定时器压根没被创建，drain 推完时钟它们才出现，
  /// 测试框架收尾时照样报 "A Timer is still pending"。
  Future<void> closeOut(WidgetTester tester) async {
    await drain(tester);
    await tester.pumpWidget(const SizedBox.shrink());
    await drain(tester);
  }

  /// 把宿主挂起来（与 app.dart 的接线同一层）：引导会自己读现状、自己决定弹不弹
  Future<void> pumpHost(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1350, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: OnboardingHost(
        state: state,
        child: const Scaffold(body: Center(child: Text('壳'))),
      ),
    ));
    await tester.pump();
  }

  /// 只等"卡弹出来了"（弹不出来也不会挂满 80 轮）
  Future<void> expectCardShown(WidgetTester tester) async {
    for (var round = 0; round < 60; round++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      if (find.text(kOnboardingTitle).evaluate().isNotEmpty) return;
    }
    fail('引导卡没有弹出来');
  }

  Future<void> expectNoCard(WidgetTester tester) async {
    for (var round = 0; round < 25; round++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
    expect(find.text(kOnboardingTitle), findsNothing, reason: '已经走过引导的机器不该再被弹一次');
  }

  /// 点卡脚那颗主按钮（「继续」/「完成」）——步骤条上的标题也是「继续」这几个字，
  /// 所以一律按控件类型定位，不按文字。
  ///
  /// 每一轮都套着 `runAsync`：结算是一次真的 HTTP，不把事件循环放出去跑，按钮点下去
  /// 永远停在"正在结算"，后面的断言会看到一个还没动的界面。
  Future<void> tapPrimary(WidgetTester tester) async {
    await pumpUntil(tester, find.byType(FilledButton));
    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    for (var i = 0; i < 12; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
  }

  /// 点一个文字按钮，并等这次点击触发的请求跑完（理由同 [tapPrimary]）。
  ///
  /// 一律在**卡片内部**找（`find.descendant`）：壳上、步骤条上也可能有同名文字，
  /// 点错一个按钮会得到一段看着像"逻辑坏了"的怪异行为——那其实是测试点歪了。
  Future<void> tapAndSettle(WidgetTester tester, Finder target) async {
    final inCard = find.descendant(of: find.byType(Dialog), matching: target);
    await pumpUntil(tester, inCard);
    expect(inCard, findsOneWidget, reason: '卡片里应当只有一个 $target');
    await tester.tap(inCard);
    await tester.pump();
    for (var i = 0; i < 12; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
  }

  Map<String, dynamic> postFor(String path) =>
      posts.firstWhere((entry) => entry['path'] == path, orElse: () => <String, dynamic>{});

  /// 最后一次发往这条通道的请求（第一步与第四步都走 persona-edit，得能分开看）
  Map<String, dynamic> lastPostFor(String path) =>
      posts.lastWhere((entry) => entry['path'] == path, orElse: () => <String, dynamic>{});

  /// 信任范围那一步的某一档现在是不是选中的。
  ///
  /// 判据是**屏上真的画出来的那一眼**（[TrustModeChoice] 选中态的描边比未选中粗），
  /// 不是"页面自己记了什么"——这个断言要锁的正是"默认高亮哪一档"。
  /// 与 settings_page_test 里那份同一个读法（两处各留一份：测试文件之间不互相 import）。
  bool trustChoiceSelected(WidgetTester tester, String mode) {
    final box = tester.widget<Container>(
      find
          .descendant(of: find.byKey(ValueKey('trust-mode-$mode')), matching: find.byType(Container))
          .first,
    );
    final border = (box.decoration as BoxDecoration).border as Border;
    return border.top.width > 1;
  }

  int postsOf(String path) => posts.where((entry) => entry['path'] == path).length;

  /// 读状态文件里的开关。
  ///
  /// 必须走 `tester.runAsync`：这是**真的**文件 I/O，而在 testWidgets 的 FakeAsync 区里直接
  /// `await file.readAsString()` 永远不会完成（实测：测试就那么挂住，一条日志都不再打）。
  Future<bool> flagOf(WidgetTester tester, String key) async =>
      (await tester.runAsync(() => loadFlag(key))) ?? false;

  group('判据（纯函数）', () {
    test('人格还是种子模板、且 API 或通道没配好 → 弹', () {
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: true, apiReady: false, channelsReady: false),
        isTrue,
      );
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: true, apiReady: true, channelsReady: false),
        isTrue,
        reason: 'API 配好了、通道还没开，也还是"没配完"',
      );
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: true, apiReady: false, channelsReady: true),
        isTrue,
      );
    });

    test('人格已经写过了 → 不弹（老用户升级到这一版不会被补弹一次）', () {
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: false, apiReady: false, channelsReady: false),
        isFalse,
      );
    });

    test('人格现状读不到 → 不弹（宁可漏弹，也不要拿猜的现状去挡人）', () {
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: null, apiReady: false, channelsReady: false),
        isFalse,
      );
    });

    test('本地记着"走过一次" → 不弹（重启之后仍然管用）', () {
      expect(
        shouldShowOnboarding(askedBefore: true, identityIsSeed: true, apiReady: false, channelsReady: false),
        isFalse,
      );
    });

    test('全配齐了 → 不弹', () {
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: true, apiReady: true, channelsReady: true),
        isFalse,
      );
    });
  });

  group('读现状', () {
    test('首次启动的机器：人格是种子、API 与通道都没配', () async {
      final signals = await readOnboardingSignals(state);
      expect(signals.identityIsSeed, isTrue);
      expect(signals.apiReady, isFalse);
      expect(signals.channelsReady, isFalse);
      expect(signals.model, 'deepseek-chat');
      expect(signals.baseUrl, 'https://api.deepseek.com');
      expect(signals.identityContent, seedIdentity, reason: '第四步要能接着这份模板改');
      expect(signals.mentionKeywords, isEmpty);
      expect(signals.herName, isNull,
          reason: '种子模板里「名字：（改成她的名字）」是占位符、示例句也不是她——认不出就是认不出');
    });

    test('配好的机器：人格已填写、密钥已配、通道开着 → 三项都就绪', () async {
      persona['IDENTITY.md'] = writtenIdentity;
      keys['heavy'] = {'configured': true, 'mask': 'sk-…t3st'};
      (config['channels'] as Map<String, dynamic>)['qqOfficial'] = {'enabled': true};
      final signals = await readOnboardingSignals(state);
      expect(signals.identityIsSeed, isFalse);
      expect(signals.apiReady, isTrue);
      expect(signals.channelsReady, isTrue);
      expect(signals.herName, '小七', reason: '老实例把名字写在散文里（"我是小七"），也要认得出来');
      expect(
        shouldShowOnboarding(
          askedBefore: false,
          identityIsSeed: signals.identityIsSeed,
          apiReady: signals.apiReady,
          channelsReady: signals.channelsReady,
        ),
        isFalse,
      );
    });

    test('名字行说了算：有「名字：」那一行时不去正文里猜', () async {
      persona['IDENTITY.md'] = '# 我是谁\n\n名字：小七（Xiaoqi）\n\n我是伊尔弥亚。\n';
      final signals = await readOnboardingSignals(state);
      expect(signals.herName, '小七', reason: '括号里的是注解；正文里那个旧名字不作数');
    });

    test('人格条目读不到 → identityIsSeed 是 null（判据据此不弹）', () async {
      persona.remove('IDENTITY.md');
      final signals = await readOnboardingSignals(state);
      expect(signals.identityIsSeed, isNull);
      expect(signals.herName, isNull, reason: '读不到正文就没名字可认——界面回退成产品名，不猜');
    });
  });

  group('四步走完', () {
    testWidgets('首次启动：四步各写对各条通道，并落盘"不再弹"', (tester) async {
      useStateFile('onboarding-e2e');

      await pumpHost(tester);
      await expectCardShown(tester);

      // ── 第 1 步：她叫什么（名字 → 人格资产；唤醒词 → 通道配置） ──
      expect(find.text('她叫什么'), findsWidgets);
      expect(find.byType(TextField).evaluate().length, 2, reason: '第 1 步是名字 + 唤醒词两格');
      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();
      expect(
        (tester.widget<TextField>(find.byType(TextField).at(1))).controller!.text,
        '小七',
        reason: '填了名字，唤醒词框顺手跟着填一份（人没自己写过才同步）',
      );
      await tapPrimary(tester);

      // ① 名字进人格资产：IDENTITY.md 的「名字：」那一行（旧版本快照由服务端落）
      //    模板里已有那一行（占位符），所以是**换掉它**，不是另插一行
      expect(postFor('/api/commands/persona-edit')['body'], {
        'file': 'IDENTITY.md',
        'content': seedIdentity.replaceFirst('名字：（改成她的名字）', '名字：小七'),
      });
      expect(postFor('/api/commands/persona-edit')['confirm'], isNull,
          reason: 'persona-edit 在 CONFIRM_PHRASES 里是 null');
      // ② 唤醒词进通道配置：从名字派生的第一份默认值
      expect(postFor('/api/commands/set-mention-keywords')['body'], {
        'keywords': ['小七'],
      });
      expect(postFor('/api/commands/set-mention-keywords')['confirm'], isNull,
          reason: 'set-mention-keywords 在 CONFIRM_PHRASES 里是 null');
      // 界面上的称呼立刻跟手（宿主重读了人格资产，而不是把输入框里的字当结论）
      expect(state.herName, '小七', reason: '窗口标题 / 侧栏 / 托盘读的就是它');
      await pumpUntil(tester, find.text('API 配置').first);

      // ── 第 2 步：API 配置（模型名与端点与默认值一致 = 不写 config，只写密钥） ──
      expect(find.text(keysRequiredNote), findsNothing, reason: '还没点继续，不该先报缺密钥');
      final fields = find.byType(TextField);
      await tester.enterText(fields.at(2), 'sk-test-key');
      await tester.pump();
      await tapPrimary(tester);

      expect(postFor('/api/commands/set-key')['body'], {'name': 'heavy', 'value': 'sk-test-key'});
      expect(postFor('/api/commands/set-key')['confirm'], 'set-key');
      expect(postsOf('/api/commands/config-update'), 0, reason: '模型名与端点没改就不该写 config');

      // ── 第 3 步：消息适配器 ──
      await pumpUntil(tester, find.text('QQ 官方 Bot API'));
      await tester.tap(find.byType(Checkbox).first);
      await tester.pump();
      await tapPrimary(tester);

      expect(postFor('/api/commands/config-update')['body'], {
        'fields': {'channels.qqOfficial.enabled': true},
      });
      expect(postFor('/api/commands/config-update')['confirm'], 'config-update');

      // ── 第 4 步：人格（清掉模板，写一份真的） ──
      await pumpUntil(tester, find.text('人格').first);
      final personaField = find.byType(TextField).last;
      expect(
        (tester.widget<TextField>(personaField)).controller!.text,
        seedIdentity.replaceFirst('名字：（改成她的名字）', '名字：小七'),
        reason: '第一步写的名字行要跟着进第四步的框——不然在这里换一份正文就把名字冲掉了',
      );
      await tester.enterText(personaField, writtenIdentity);
      await tester.pump();
      await tapPrimary(tester); // 「继续」→ 最后一步

      expect(postsOf('/api/commands/persona-edit'), 2, reason: '第一步一次（名字）、第四步一次（正文）');
      expect(lastPostFor('/api/commands/persona-edit')['body'], {
        'file': 'IDENTITY.md',
        // 框里的首尾空白是手滑，不是人格的一部分；名字行由框架带上（见 her_name.dart）
        'content': '名字：小七\n${writtenIdentity.trim()}',
      });
      expect(lastPostFor('/api/commands/persona-edit')['confirm'], isNull,
          reason: 'persona-edit 在 CONFIRM_PHRASES 里是 null');

      // ── 第 5 步：信任范围（默认档 = 配置默认值，不动它就不写盘） ──
      await pumpUntil(tester, find.text('信任范围').first);
      expect(trustChoiceSelected(tester, kTrustFull), isTrue,
          reason: '默认高亮「完全信任」——与 src/config/config.ts 的默认值同一个字面量');
      expect(trustChoiceSelected(tester, kTrustWorkspace), isFalse);
      expect(find.text('她能读写整台电脑上的文件、也能在任意目录跑命令。'), findsOneWidget);
      expect(find.textContaining('她只能在'), findsOneWidget,
          reason: '两种选择各一句后果说明（只限工作目录那句要把路径念出来）');
      expect(postsOf('/api/commands/config-update'), 1,
          reason: '还没点完成：到这一步为止只写过通道开关那一次');
      await tapPrimary(tester); // 「完成」

      expect(postsOf('/api/commands/config-update'), 1,
          reason: '信任范围与盘上那份一致（都是默认的 full）→ 一个字节都不写');
      expect(find.text(kOnboardingTitle), findsNothing, reason: '完成之后卡片应关掉');

      // 「不再弹」是落盘的，不是内存里记了一笔
      await drain(tester);
      expect(await flagOf(tester, kOnboardingDoneFlag), isTrue, reason: 'onboarding-done 要写进状态文件');
      final saved = jsonDecode(File(stateFilePath()).readAsStringSync()) as Map<String, dynamic>;
      expect(saved[kOnboardingDoneFlag], isTrue);

      // 再开一次宿主：现状其实还没配完（服务端那份配置是重启后接管的），但本地记着走过一次了
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await pumpHost(tester);
      await expectNoCard(tester);
      await closeOut(tester);
    });

    testWidgets('失败就留在原地：写不进去时卡片不关、原因写在卡上', (tester) async {
      useStateFile('onboarding-fail');
      await pumpHost(tester);
      await expectCardShown(tester);

      failCommands = true;
      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();
      await tapPrimary(tester);

      expect(find.textContaining('名字没写进去'), findsOneWidget, reason: '失败原因要写在卡上');
      expect(find.text(kOnboardingTitle), findsOneWidget, reason: '没写成就不该往下走');
      await closeOut(tester);
    });

    testWidgets('API 那一步：没密钥会提示（但不拦），照样能往下走', (tester) async {
      useStateFile('onboarding-key');
      await pumpHost(tester);
      await expectCardShown(tester);

      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步：跳过
      expect(find.text('API 配置'), findsWidgets);

      await tapPrimary(tester); // 第 2 步：空着点「继续」
      expect(find.text(keysRequiredNote), findsOneWidget, reason: '缺密钥要说清为什么这一次没写进去');
      expect(postsOf('/api/commands/set-key'), 0, reason: '没填就不该写一把空密钥');
      // 走到第 3 步了：提示是"这一步没写成"，不是"不许往下走"
      expect(find.text('QQ 官方 Bot API'), findsOneWidget, reason: '提示不等于把人锁在这一步');
      expect(find.text(keysRequiredNote), findsOneWidget, reason: '缺的东西仍摆在卡上，等人回头填');
      await closeOut(tester);
    });

    testWidgets('缺密钥不拦「以后再说」：缺的东西只摆在卡上，退出照旧', (tester) async {
      useStateFile('onboarding-key-later');
      await pumpHost(tester);
      await expectCardShown(tester);

      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步：跳过 → 第 2 步（API）
      await tapPrimary(tester); // 空着点「继续」→ 卡上报"还没填密钥"
      expect(find.text(keysRequiredNote), findsOneWidget);

      // 缺一样东西与"写失败"是两件事：前者不该把人锁在卡里
      await tapAndSettle(tester, find.text('以后再说'));
      expect(find.text(kOnboardingTitle), findsNothing, reason: '没填密钥也要能退出去');
      expect(await flagOf(tester, kOnboardingDoneFlag), isTrue);
      await closeOut(tester);
    });

    testWidgets('「以后再说」：填好的照样落盘，卡片关掉', (tester) async {
      useStateFile('onboarding-later');

      await pumpHost(tester);
      await expectCardShown(tester);
      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();

      // 卡头上的关闭键与「以后再说」是同一条路：结算当前这步，再退出
      await tapAndSettle(tester, find.byTooltip(kOnboardingCloseLabel));
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text(kOnboardingTitle), findsNothing);
      expect(postsOf('/api/commands/persona-edit'), 1, reason: '名字进人格资产');
      expect(postsOf('/api/commands/set-mention-keywords'), 1, reason: '唤醒词也跟着写');
      expect(
          postFor('/api/commands/set-mention-keywords')['body'],
          {
            'keywords': ['小七'],
          },
          reason: '人填过的东西不该因为"没点完成"丢掉');
      // 读状态文件之前先把这一趟还在飞的真 I/O（名字那条 POST、宿主那句 saveFlag 的写盘）跑完：
      // `flagOf` 自己也走 runAsync，两个真 I/O 挤在同一个窗口里会互相等——实测会把用例挂死
      // （flutter_test 的假时钟与真 I/O 交错，一条日志都不再打）。这是本文件既有的姿势：
      // 写完先 drain 再断言（见"四步走完"那条用例）。
      await drain(tester);
      expect(await flagOf(tester, kOnboardingDoneFlag), isTrue);
      await closeOut(tester);
    });

    testWidgets('上一步：回退时不写，回去改完再往前走才写', (tester) async {
      useStateFile('onboarding-back');
      await pumpHost(tester);
      await expectCardShown(tester);

      // 第 1 步不填，直接跳过 → 到第 2 步
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel));
      expect(postsOf('/api/commands/set-mention-keywords'), 0, reason: '跳过 = 一个字节都不写');
      expect(postsOf('/api/commands/persona-edit'), 0, reason: '名字那一步跳过了，人格资产一个字节都不碰');
      expect(find.byType(TextField).evaluate().length, 3, reason: '第 2 步是模型名 / Base URL / 密钥三格');

      // 回退到第 1 步：回退本身不该触发任何写
      await tapAndSettle(tester, find.text(kOnboardingBackLabel));
      expect(posts, isEmpty);
      expect(find.byType(TextField).evaluate().length, 2, reason: '退**一步**就到第 1 步（名字 + 唤醒词），不是一步跳回开头');
      expect(find.text('她叫什么'), findsWidgets);

      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();
      await tapPrimary(tester);
      expect(postsOf('/api/commands/persona-edit'), 1);
      expect(postsOf('/api/commands/set-mention-keywords'), 1);
      expect(find.byType(TextField).evaluate().length, 3, reason: '改完往前走一步，回到第 2 步');
      await closeOut(tester);
    });

    testWidgets('词表清空 = 只认 @：人自己的决定不会被"名字同步"又填回去', (tester) async {
      useStateFile('onboarding-name-only');
      // 现状里已经有一份词表（老实例的写法）：改名字不该顺手把它覆盖掉，
      // 人要清空它才是"只认 @"这个决定
      (config['channels'] as Map<String, dynamic>)['mentionKeywords'] = <String>['旧名'];
      await pumpHost(tester);
      await expectCardShown(tester);

      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();
      expect(
        (tester.widget<TextField>(find.byType(TextField).at(1))).controller!.text,
        '旧名',
        reason: '已经有词表 = 人做过的决定，名字不覆盖它',
      );

      await tester.enterText(find.byType(TextField).at(1), '');
      await tester.pump();
      await tapPrimary(tester);

      expect(postFor('/api/commands/persona-edit')['body'], {
        'file': 'IDENTITY.md',
        'content': seedIdentity.replaceFirst('名字：（改成她的名字）', '名字：小七'),
      });
      expect(postFor('/api/commands/set-mention-keywords')['body'], {
        'keywords': <String>[],
      }, reason: '清空是人写下的值，原样写进去（空 = 只认平台的 @）');
      await closeOut(tester);
    });

    testWidgets('信任范围那一步：默认高亮完全信任；改选工作目录才写 trust.mode', (tester) async {
      useStateFile('onboarding-trust');
      // 盘上那份就是配置默认值（服务端把 workspaceRoot 一起算出来给界面念）
      (config)['trust'] = {'mode': 'full', 'workspaceRoot': r'C:\path\to\config\workspace'};
      await pumpHost(tester);
      await expectCardShown(tester);

      // 前四步一路往前走（不填、不改）：这一条只看最后那一屏。
      // 第 1~3 步走卡脚的「跳过这一步」（真的一个字都不写），第 4 步走主按钮
      // ——**不能一直按「跳过」**：它在最后一步上等价于「完成」，会把卡直接关掉。
      for (var i = 0; i < 3; i++) {
        await tapAndSettle(tester, find.text(kOnboardingSkipLabel));
      }
      await tapPrimary(tester); // 第 4 步（人格）不填 → 往前走一步到信任范围
      await pumpUntil(tester, find.text('信任范围').first);
      expect(posts, isEmpty, reason: '前四步什么都没填 = 一个字节都没写过');

      // ① **默认高亮「完全信任」**（与 src/config/config.ts 的 buildDefaults 同一个字面量）
      expect(trustChoiceSelected(tester, kTrustFull), isTrue);
      expect(trustChoiceSelected(tester, kTrustWorkspace), isFalse);
      // ② 两种选择各一句后果说明，且受限那档要把路径念出来
      expect(find.text('她能读写整台电脑上的文件、也能在任意目录跑命令。'), findsOneWidget);
      expect(
        find.text(r'她只能在 C:\path\to\config\workspace 里活动；越界的读写与命令会被拒绝。'),
        findsOneWidget,
      );

      // ③ 改选「只限工作目录」：走既有的 config-update 通道，带 X-Confirm
      await tester.tap(find.byKey(const ValueKey('trust-mode-workspace')));
      await tester.pump();
      expect(trustChoiceSelected(tester, kTrustWorkspace), isTrue, reason: '点哪一档就选哪一档');
      expect(trustChoiceSelected(tester, kTrustFull), isFalse);
      await tapPrimary(tester); // 「完成」→ 结算这一步

      expect(postFor('/api/commands/config-update')['body'], {
        'fields': {'trust.mode': 'workspace'},
      });
      // 改 `trust.mode` 的 `X-Confirm` 必须**同时**含两个短语：命令短语（声明性）+
      // 字段短语 `trust-full-access`（服务端 DANGEROUS_FIELDS 真的在校验它，两个方向都要）。
      // 少了那半截，这一步会吃 400——引导走不到底，而人只会看到一句"信任范围没写进去"。
      expect(postFor('/api/commands/config-update')['confirm'], kTrustConfirm);
      expect(postFor('/api/commands/config-update')['confirm'], contains('trust-full-access'));
      expect(find.text(kOnboardingTitle), findsNothing, reason: '完成之后卡片应关掉');
      await closeOut(tester);
    });
  });

  group('强制弹出的判据（环境变量在测试进程里设不了，只钉纯函数）', () {
    test('配好的机器：常规判据说不弹，强制口子说弹；但"走过一次"连强制也拦下', () {
      const configured = (identityIsSeed: false, apiReady: true, channelsReady: true);
      expect(
        shouldShowOnboardingNow(
          askedBefore: false,
          identityIsSeed: configured.identityIsSeed,
          apiReady: configured.apiReady,
          channelsReady: configured.channelsReady,
          forceEnv: null,
        ),
        isFalse,
      );
      expect(
        shouldShowOnboardingNow(
          askedBefore: false,
          identityIsSeed: configured.identityIsSeed,
          apiReady: configured.apiReady,
          channelsReady: configured.channelsReady,
          forceEnv: '1',
        ),
        isTrue,
        reason: '设了 IRMIA_GUI_FORCE_ONBOARDING=1 就能在配好的机器上看这张卡',
      );
      expect(
        shouldShowOnboardingNow(
          askedBefore: true,
          identityIsSeed: true,
          apiReady: false,
          channelsReady: false,
          forceEnv: '1',
        ),
        isFalse,
        reason: '人点过「以后再说」之后，连强制也不该再把卡拍在他脸上',
      );
    });

    testWidgets('配好的机器：宿主不会弹', (tester) async {
      persona['IDENTITY.md'] = writtenIdentity;
      keys['heavy'] = {'configured': true, 'mask': 'sk-…t3st'};
      (config['channels'] as Map<String, dynamic>)['qqOfficial'] = {'enabled': true};
      useStateFile('onboarding-force');

      await pumpHost(tester);
      await expectNoCard(tester);
      await closeOut(tester);
    });
  });
}
