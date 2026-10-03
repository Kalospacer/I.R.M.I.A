import 'dart:async';
import 'shell/tray.dart';
import 'dart:io';

import 'package:flutter/material.dart';

import 'api.dart';
import 'ask_card.dart';
import 'her_name.dart';
import 'home.dart';
import 'mention_prompt.dart';
import 'onboarding.dart';
import 'pages/channels_page.dart';
import 'pages/chat_page.dart';
import 'pages/extensions_page.dart';
import 'pages/logs_page.dart';
import 'pages/memory_page.dart';
import 'pages/overview_page.dart';
import 'pages/persona_page.dart';
import 'pages/settings_page.dart';
import 'theme.dart';
import 'title_bar.dart';

/// GUI 外壳与全局状态。页面在 pages/ 下，通过 AppState 拿数据与 token。
/// 结构规格：docs/gui-design.md §3。
class IrmiaApp extends StatefulWidget {
  const IrmiaApp({super.key});

  @override
  State<IrmiaApp> createState() => _IrmiaAppState();
}

/// 页面条目：导航与页面宿主共用同一份定义（一级五项 + 底部「更多」的二级项），
/// 一律按 id 定位页面而不是下标——增删或重排页面时不会错位。
class PageEntry {
  const PageEntry({
    required this.id,
    required this.label,
    required this.icon,
    required this.builder,
    this.solidIcon,
  });

  final String id;
  final String label;
  final IconData icon;
  final IconData? solidIcon;
  final Widget Function(AppState state) builder;

  /// 选中态图标：未单独指定时与常态一致
  IconData get activeIcon => solidIcon ?? icon;
}

/// 默认落点：运行情况（壳的常驻首页）
const defaultPageId = 'overview';

/// 一级入口：只放高频功能，保持五项（docs/gui-design.md §3）
final navPages = <PageEntry>[
  PageEntry(
    id: 'overview',
    label: '运行情况',
    icon: Icons.grid_view_outlined,
    solidIcon: Icons.grid_view_rounded,
    builder: (state) => OverviewPage(state: state),
  ),
  PageEntry(
    id: 'chat',
    label: '聊天',
    icon: Icons.chat_bubble_outline_rounded,
    solidIcon: Icons.chat_bubble_rounded,
    builder: (state) => ChatPage(state: state),
  ),
  PageEntry(
    id: 'persona',
    label: '人格配置',
    icon: Icons.person_outline_rounded,
    solidIcon: Icons.person_rounded,
    builder: (state) => PersonaPage(state: state),
  ),
  PageEntry(
    id: 'channels',
    label: '消息适配器',
    icon: Icons.swap_horiz_rounded,
    solidIcon: Icons.swap_horiz_rounded,
    builder: (state) => ChannelsPage(state: state),
  ),
  PageEntry(
    id: 'extensions',
    label: '扩展',
    icon: Icons.extension_outlined,
    solidIcon: Icons.extension_rounded,
    builder: (state) => ExtensionsPage(state: state),
  ),
];

/// 二级入口：低频功能，收进底部「更多」折叠组，不占一级位置
final morePages = <PageEntry>[
  PageEntry(
    id: 'memory',
    label: '记忆',
    icon: Icons.psychology_outlined,
    solidIcon: Icons.psychology_rounded,
    builder: (state) => MemoryPage(state: state),
  ),
  PageEntry(
    id: 'logs',
    label: '日志',
    icon: Icons.article_outlined,
    solidIcon: Icons.article_rounded,
    builder: (state) => LogsPage(state: state),
  ),
  PageEntry(
    id: 'settings',
    label: '设置',
    icon: Icons.settings_outlined,
    solidIcon: Icons.settings_rounded,
    builder: (state) => SettingsPage(state: state),
  ),
];

/// 全量注册表：一级 + 二级，供按 id 定位
final allPages = <PageEntry>[...navPages, ...morePages];

/// 按 id 取页面条目；未知 id 返回 null，由调用方兜底
PageEntry? pageEntryById(String id) {
  for (final page in allPages) {
    if (page.id == id) return page;
  }
  return null;
}

class _IrmiaAppState extends State<IrmiaApp> {
  late final AppState state;

  @override
  void initState() {
    super.initState();
    final port = Platform.environment['IRMIA_WEB_PORT'] ?? '7788';
    state = AppState(
      api: IrmiaApi(baseUrl: 'http://127.0.0.1:$port')..token = AppState.storedToken(),
    );
    if (state.api.token != null) state.startPolling();
    // **托盘接线**（2026-10-04）：菜单里的「重启前后端」复用界面这条命令通道，
    // 与运行情况页那颗按钮走同一个后端动作（免得两处各写一份重启逻辑）。
    // 放在 initState 里而不是 main()：这里拿得到 state.api（token 也在这一步就位）。
    unawaited(IrmiaTray.instance.install(
      post: (command, payload) => state.api.post(
        '/api/commands/$command',
        payload,
        confirm: command,
      ),
      // 托盘提示里是**她的名字**（读不到时由 her_name.dart 决定显示什么）
      displayName: state.herDisplayName,
    ));
    // 名字是异步读来的（`persona/IDENTITY.md`），读到之后托盘提示也跟着换一次；
    // 每次轮询都会调到这里，而 setDisplayName 在值没变时直接返回（不做无用的系统调用）
    state.addListener(_syncTrayName);
  }

  /// 状态一变就把她的名字同步给托盘（真正的判断在 [IrmiaTray.setDisplayName] 里）
  void _syncTrayName() => unawaited(IrmiaTray.instance.setDisplayName(state.herDisplayName));

  @override
  void dispose() {
    state.removeListener(_syncTrayName);
    state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        return MaterialApp(
          // 窗口标题 = **她的名字**（读不到时回退成产品名，见 her_name.dart 的口径）。
          // 产品名 `Irmia Agent Framework` 是另一件事：它在自绘标题栏与 C++ runner 里，
          // 与她叫什么无关，所以这里不跟它走。
          //
          // 实测（2026-10-03，release 版跑起来用 GetWindowText 读原生标题）：Windows 上这一行
          // **到不了原生窗口标题**——标题是 main.dart 的 `WindowOptions(title: …)`（产品名）
          // 定的，一直显示 `Irmia Agent Framework`。所以改这里不会动到产品名，也不会像按下
          // 开关那样换掉标题；它是"这个应用对外自称什么"的声明位（别的平台/无障碍会读它），
          // 放着与她的名字一致是对的，但不能拿它当"窗口标题跟配置走"的证据。
          title: herNameOrFallback(state.herName),
          debugShowCheckedModeBanner: false,
          theme: IrmiaTheme.light(),
          darkTheme: IrmiaTheme.dark(),
          themeMode: state.themeMode,
          // 自绘标题栏画在所有页面之上（含 token 门）：窗口已经没有系统标题栏，
          // 这条既是标题也是唯一的拖动区（docs/gui-revision.md ①）。
          builder: (context, child) => Column(
            children: [
              const IrmiaTitleBar(),
              Expanded(child: child ?? const SizedBox.shrink()),
            ],
          ),
          home: state.api.token == null
              ? TokenGate(state: state)
              // 三层宿主包住整壳，从外到内：
              //   · OnboardingHost —— 首次启动引导（一次性的，判据见 onboarding.dart）；
              //   · MentionPromptHost —— 「她怎么被称呼」的首次提示；
              //   · AskCardHost —— 她此刻在问的那张卡（每次都来）。
              // 引导放最外层：它是"第一次用的人"最先该看到的东西，而它读的现状（人格种子、
              // 密钥、通道）全都要先有 token——所以它也只能在 TokenGate 之后（见 onboarding.dart 顶部）。
              : OnboardingHost(
                  state: state,
                  child: MentionPromptHost(
                    state: state,
                    child: AskCardHost(state: state, child: HomeShell(state: state)),
                  ),
                ),
        );
      },
    );
  }
}

/// 全局状态：token、状态句、主题、当前页、徽章
class AppState extends ChangeNotifier {
  AppState({required this.api});

  final IrmiaApi api;
  String dotKind = 'loading';
  String stateText = '正在连接…';
  String subText = '';
  ThemeMode themeMode = ThemeMode.light;

  /// **她的名字**：`persona/IDENTITY.md` 里 `名字：` 那一行的值，null = 还没读到/还没写。
  ///
  /// 界面上凡是要显示"她叫什么"的地方（窗口标题、侧栏品牌区、托盘提示、"她问你"那张卡的标题）
  /// 一律读它，读不到就按 [herDisplayName] / her_name.dart 里的口径回退——
  /// **绝不**再写死一个名字：写死意味着换个人装这个框架，界面照样管他的 agent 叫伊尔弥亚。
  ///
  /// 名字是异步读来的，所以第一帧通常还没有它（回退值先上屏，读到之后 notifyListeners 换掉）。
  String? herName;

  /// 界面上显示的名字（窗口标题、托盘提示这一族）
  String get herDisplayName => herNameOrFallback(herName);

  /// 侧栏品牌区那一个（位置窄，回退文案见 her_name.dart）
  String get herBrandLabel => herBrandName(herName);

  /// 当前页 id（默认「运行情况」）
  String pageId = defaultPageId;
  int needsReview = 0;
  bool online = false;

  /// **她在问**的那些卡（design §6）：按提问先后排好的一队，界面一次只弹队首那张（§6.3）。
  ///
  /// 空表示台面上没有她没答复的提问。卡上的字：`question`/`context` 是她的原话，
  /// 标题与按钮由界面写死（防伪）——所以这里只搬数据，不做措辞。
  ///
  /// 「稍后」是**本地**动作（不写日志、不产生决定，§6.1），服务端不知道哪几张被收起来了，
  /// 所以它给一串而不是只给队首：只给队首的话，人一按「稍后」就永远轮不到后面那几张。
  List<AskCardData> askCards = const [];
  /// 台面上还没答复的总条数（含 `askCards` 之外没下发的那几件）：左栏角标读它
  int askTotal = 0;

  Timer? _poll;

  static const _tokenFileEnv = 'APPDATA';

  /// token 存 %APPDATA%/Irmia/gui-token（不放项目目录，避免随项目分发泄漏）
  static String _tokenFile() {
    final appData = Platform.environment[_tokenFileEnv] ?? Directory.systemTemp.path;
    return '$appData${Platform.pathSeparator}Irmia${Platform.pathSeparator}gui-token';
  }

  static String? storedToken() {
    try {
      final file = File(_tokenFile());
      if (!file.existsSync()) return null;
      final value = file.readAsStringSync().trim();
      return value.isEmpty ? null : value;
    } catch (_) {
      return null;
    }
  }

  Future<void> saveToken(String value) async {
    final trimmed = value.trim();
    if (trimmed.isEmpty) return;
    try {
      final file = File(_tokenFile());
      file.parent.createSync(recursive: true);
      file.writeAsStringSync(trimmed);
    } catch (_) {
      // 写不进去也能用（本次会话内）
    }
    api.token = trimmed;
    notifyListeners();
    startPolling();
  }

  void startPolling() {
    _poll?.cancel();
    unawaited(pollOnce());
    // 名字跟着同一条生命周期的起点读一次（她改名走界面那几条路时会再读，见 refreshHerName）
    unawaited(refreshHerName());
    _poll = Timer.periodic(const Duration(seconds: 10), (_) => unawaited(pollOnce()));
  }

  /// 读一遍她的名字：`GET /api/persona/file?path=IDENTITY.md`（**复用现成的读端点**，
  /// 不新增服务端接口——理由见 her_name.dart 的文件头）。
  ///
  /// 什么时候读：拿到 token 时（[startPolling]）、引导第 1 步写完名字时、人格配置页保存后。
  /// 为什么不放进 10 秒的轮询里：为了"她在别处改了名字"每 10 秒读一趟人格文件不值——
  /// 那不是一条便宜的状态查询，而是一份会越来越长的人格正文。代价说清楚：从 CLI 或
  /// 她自己的提案改了名字，界面要重开一次才看到（界面上改的会立刻跟手）。
  ///
  /// 读不到时**保持上一次读到的值**，不清空：清空会让侧栏在服务端抖一下的瞬间闪回产品名。
  /// 从来没读到过就是 null，由 her_name.dart 决定显示什么（产品名，不是某个猜的名字）。
  Future<void> refreshHerName() async {
    String? next;
    try {
      final view =
          await api.get('/api/persona/file?path=${Uri.encodeComponent(kIdentityFile)}');
      final content = view is Map ? view['content'] : null;
      if (content is! String) return;
      next = herNameFromIdentity(content);
    } on ApiAuthError {
      // token 失效那一套由 pollOnce 负责说（这里不抢话）
      return;
    } catch (_) {
      return;
    }
    if (next == herName) return;
    herName = next;
    notifyListeners();
  }

  Future<void> pollOnce() async {
    try {
      final stats = await api.get('/api/stats/dashboard');
      if (stats is Map<String, dynamic>) {
        final state = stats['state'] as String?;
        final tiles = stats['tiles'];
        needsReview = tiles is Map ? ((tiles['needsReview'] ?? 0) as num).toInt() : 0;
        stateText = IrmiaTheme.humanState(state, needsReview: needsReview);
        dotKind = state ?? 'idle';
        final days = stats['guardedDays'] ?? 0;
        final next = stats['nextWakeAt'];
        subText = '已运行 $days 天'
            '${next is String && next.isNotEmpty ? ' · 下次唤醒 ${hhmm(next)}' : ''}';
        // 她在问的卡跟着同一个轮询走（不另开一条通道：这是全 app 唯一的心跳）
        final ask = stats['ask'];
        if (ask is Map) {
          final raw = ask['cards'];
          askCards = raw is List
              ? raw.map(AskCardData.fromJson).whereType<AskCardData>().toList(growable: false)
              : const <AskCardData>[];
          askTotal = ((ask['queued'] ?? askCards.length) as num).toInt();
        } else {
          // 老服务端（没有这个字段）时当作"没有卡"，而不是拿上一次的卡继续弹
          askCards = const <AskCardData>[];
          askTotal = 0;
        }
      }
      online = true;
    } on ApiAuthError {
      api.token = null;
      online = false;
      dotKind = 'offline';
      stateText = '认证失败（token 无效）';
      _poll?.cancel();
    } catch (_) {
      online = false;
      dotKind = 'offline';
      stateText = '连接中断';
    }
    notifyListeners();
  }

  /// 按注册表 id 切页；未知 id 视为无效操作，保持当前页
  void setPage(String id) {
    if (pageId == id || pageEntryById(id) == null) return;
    pageId = id;
    notifyListeners();
  }

  /// 答复她在问的那一条：`POST /api/commands/answer` 带上 `askSeq`。
  ///
  /// 为什么必须带 askSeq：台面上可能同时摆着她问的卡与一条待批准的计划，服务端凭这个 seq
  /// 才知道人答的是哪一条（§6 的一张卡一层含义）。返回 null = 记上了；返回文字 = 失败原因
  /// （卡还在，再答一次即可，不静默吞掉）。
  Future<String?> answerAsk(int askSeq, String answer) async {
    try {
      await api.post('/api/commands/answer', {'answer': answer, 'askSeq': askSeq});
    } on ApiAuthError catch (err) {
      return err.message;
    } catch (err) {
      return '$err';
    }
    // 立刻刷新：答掉一张之后，排队里的下一张该马上浮上来（等 10 秒的轮询会让人以为卡丢了）
    await pollOnce();
    return null;
  }

  void toggleTheme() {
    themeMode = themeMode == ThemeMode.light ? ThemeMode.dark : ThemeMode.light;
    notifyListeners();
  }

  /// 保存「她被怎么称呼」：`POST /api/commands/set-mention-keywords`。
  ///
  /// 返回 null = 写进去了；返回文字 = 失败原因（界面照实弹出来，不静默吞掉）。
  /// 服务端会热更运行期那份判据（`onMentionKeywords`），所以**改完下一句消息就生效**——
  /// 这几个词本来就是要当场试的。
  Future<String?> saveMentionKeywords(List<String> keywords) async {
    try {
      await api.post(
        '/api/commands/set-mention-keywords',
        {'keywords': keywords},
        confirm: 'set-mention-keywords',
      );
    } on ApiAuthError catch (err) {
      return err.message;
    } catch (err) {
      return '$err';
    }
    return null;
  }

  static String hhmm(String iso) {
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return '';
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }
}

/// 她问的那张卡（`/api/stats/dashboard` 的 `ask.card`）。
///
/// 字段只有四个 + 一个超时标记，**没一个能改卡的样子**：标题、按钮、说明全是界面写死的
/// （design §6 防伪——她只能决定问什么）。多出来的字段一律不读：服务端将来加字段时，
/// 界面不会因为"多了个 title/acceptLabel"就把系统口吻交给不可信内容。
class AskCardData {
  const AskCardData({
    required this.seq,
    required this.question,
    required this.context,
    required this.expiredAt,
  });

  /// `human/asked` 的 seq：答复时带回服务端，配对用
  final int seq;
  /// 她的原话（问题）
  final String question;
  /// 她的原话（为什么问、查到哪一步）
  final String context;
  /// 非空 = 已超时无人答（**未批准、未拒绝**：她已收到这条事实，卡仍然有效）
  final String? expiredAt;

  /// 服务端给的 JSON → 模型；形状不对时返回 null（宁可不弹，也不弹一张字段是猜的卡）
  static AskCardData? fromJson(dynamic raw) {
    if (raw is! Map) return null;
    final seq = raw['seq'];
    final question = raw['question'];
    if (seq is! num || question is! String || question.trim().isEmpty) return null;
    final context = raw['context'];
    final expired = raw['expiredAt'];
    return AskCardData(
      seq: seq.toInt(),
      question: question,
      context: context is String ? context : '',
      expiredAt: expired is String && expired.isNotEmpty ? expired : null,
    );
  }
}

/// token 门：她的脸 + 暗号（与 Web 同一扇门）
class TokenGate extends StatefulWidget {
  const TokenGate({super.key, required this.state});
  final AppState state;

  @override
  State<TokenGate> createState() => _TokenGateState();
}

class _TokenGateState extends State<TokenGate> {
  final controller = TextEditingController();
  bool busy = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: Center(
        child: Container(
          width: 380,
          padding: const EdgeInsets.all(24),
          decoration: BoxDecoration(
            color: scheme.surface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: scheme.outlineVariant),
            boxShadow: IrmiaTheme.hairline,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Center(child: HerFace(size: 64, radius: 20)),
              const SizedBox(height: 14),
              Text('连接本地服务', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 6),
              Text(
                '粘贴启动时输出的 token。token 仅保存在本机，后续请求自动携带。',
                style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant, height: 1.6),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: controller,
                autofocus: true,
                decoration: const InputDecoration(hintText: 'token'),
                onSubmitted: (_) => unawaited(_submit()),
              ),
              const SizedBox(height: 14),
              FilledButton(onPressed: busy ? null : () => unawaited(_submit()), child: const Text('保存并连接')),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _submit() async {
    setState(() => busy = true);
    await widget.state.saveToken(controller.text);
    if (mounted) setState(() => busy = false);
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }
}
