import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import 'app.dart';
import 'her_name.dart';
import 'theme.dart';
import 'ui_kit.dart';
import 'ui_state.dart';

/// 首次启动引导（四步：她叫什么 / API 配置 / 消息适配器 / 人格）。
///
/// 形制与「她在问」的那张卡同族（[AskCardHost]）：**顶层**（包住整个壳，人在哪一页都看得见）、
/// 遮罩之上一次只一张、四步在同一张卡里前后走完——不是新开一页。
///
/// 三件事先说清：
///   ① **判据**（[shouldShowOnboarding]）：见那个函数的注释，一句话——人格还是种子模板、
///      且 API 或通道还没配好。判据读的是**服务端的现状**，不是"我这次弹过没有"：
///      只在内存里记一个"弹过了"，重启就没了。
///   ② **不再弹**照 [MentionPromptHost] 的姿势持久化：`ui-state.json` 里的
///      `onboarding-done` 开关（与"更多"折叠组、提及提示同一份文件）。
///   ③ **每一步只写它自己那一件事**（每次点「继续 / 完成」时结算，失败就把原因说清并留在原地）：
///        · 名字 → `POST /api/commands/persona-edit`（写 persona/IDENTITY.md 的「名字：」那一行）
///                 **和** `POST /api/commands/set-mention-keywords`（唤醒词：从名字派生，人可改）
///        · API  → `POST /api/commands/config-update`（`X-Confirm: config-update`）
///                 + `POST /api/commands/set-key`（`X-Confirm: set-key`）
///        · 通道 → `POST /api/commands/config-update`（`X-Confirm: config-update`）
///        · 人格 → `POST /api/commands/persona-edit`（危险表里是 null，不带确认短语）
///
/// **第一步为什么写两件事**：这一屏问的其实是两件事——"她叫什么"（她的人格身份，落在
/// persona/IDENTITY.md）与"群里喊什么算在叫她"（机器配置 channels.mentionKeywords）。
/// 以前只写了后者，于是名字从来没被真正配置过：换个人装这个框架，界面照样管他的 agent
/// 叫伊尔弥亚（那些字面量的来历与现在的口径见 her_name.dart）。
///
/// 为什么引导排在 `AuthGate` **之后**（见 app.dart 的接线）：`/api/*` 全部要会话凭据，
/// 没有它连 `/api/config` 都读不到——密钥与配置一个字节也写不进去。
/// 所以那道门（首次设密码 / 登录）是第一步，凭据有了才谈得上"引导她把第一次配置做完"。

/// 「引导已经出现过」这个事实的存放键（`ui-state.json`）
const kOnboardingDoneFlag = 'onboarding-done';

/// 允许强制弹出引导（排障与人工验证用；正式运行不要设）。
///
/// 为什么留这个口子：判据读的是服务端现状——在一台**已经配好**的机器上（比如用户的开发机），
/// 引导永远不该弹，于是"弹出来长什么样、四步走得通吗"就只能靠改配置去凑。有了它，
/// `$env:IRMIA_GUI_FORCE_ONBOARDING='1'` 起一次界面就能看那张卡（不写任何服务端状态：
/// 点「以后再说」/关闭就直接退出）。
const kForceOnboardingEnv = 'IRMIA_GUI_FORCE_ONBOARDING';

/// 卡片的标题（写死的框架口吻：这张卡与"她在问"那张一样，标题不由内容决定）
const kOnboardingTitle = '首次启动引导';

/// 引导卡的最大宽度。
///
/// 比 [kDialogMaxWidth]（400，确认框与"她在问"那张卡）宽：那两张卡只有一段话，
/// 这张卡里有四个输入框与一组通道选项，400 会把密钥框挤成一条缝。
/// 也不跟着窗口无限长：卡片再宽就成"第二层窗口"，与它"浮在壳之上的一张卡"的定位不符。
const kOnboardingCardWidth = 620.0;

/// 步骤区的最小高度：四步的内容长短不一，不钉住高度就会一跳一跳
const _bodyMinHeight = 268.0;

/// 引导要读的那几项**服务端现状**。三个字段刻意给得很直白，判据（[shouldShowOnboarding]）
/// 只读它们，不读原始 JSON——"怎么读"与"根据它决定什么"分开，换端点时判据一个字都不用动。
class OnboardingSignals {
  const OnboardingSignals({
    required this.identityIsSeed,
    required this.apiReady,
    required this.channelsReady,
    required this.model,
    required this.baseUrl,
    required this.apiKeyConfigured,
    required this.qqEnabled,
    required this.onebotEnabled,
    required this.mentionKeywords,
    required this.identityContent,
    required this.herName,
  });

  /// 人格是否**确定**还停在种子模板（IDENTITY.md 里还有 `<!-- SEED` 那行）。
  /// null = 读不到（端点在、但响应形状不对）——那时按"不确定"处理，见判据。
  final bool? identityIsSeed;

  /// API 侧就绪：配了模型名 / 端点，且有可用的密钥
  final bool apiReady;

  /// 通道侧就绪：QQ 官方 或 OneBot 至少开了一个
  final bool channelsReady;

  /// 当前生效的四个值：既是判据的输入，也用来回填输入框与判断"这一格改没改"
  final String model;
  final String baseUrl;
  final bool apiKeyConfigured;
  final bool qqEnabled;
  final bool onebotEnabled;

  /// 她当前被怎么称呼（可能被喊的那些词）：回填第一步的词表
  final List<String> mentionKeywords;

  /// IDENTITY.md 的现正文（null = 读不到）：回填第四步的文本框，同时是第一步写名字时的**底稿**
  final String? identityContent;

  /// 她现在的名字（从 [identityContent] 里认出来的；null = 认不出）。
  /// 回填第一步的名字格——老实例（名字写在正文散文里）也能被回填成结构化那一行。
  final String? herName;
}

/// 该不该弹首次引导。
///
/// 判据三句：
///   · `askedBefore` —— 本地状态文件里的 `onboarding-done`：人走过一次（或明说过"以后再说"）
///     就不再打扰；这是**唯一**的"不再弹"来源，重启后照旧管用；
///   · `identityIsSeed` —— 服务端说 IDENTITY.md 里还留着 `<!-- SEED` 那行（种子模板没动过）。
///     人格是"她的存在方式"，装好就把名字与身份写了的机器，几乎一定不是第一次启动；
///     反过来**只有**人格还是模板才会往下判，于是老用户升级到这一版不会被补弹一次；
///   · `apiReady` / `channelsReady` —— 这两样她还缺一样，才值得把卡摆出来。
///
/// 为什么 `identityIsSeed` 为 null（读不到）时**不弹**：读不到现状就无法排除"他是老用户"，
/// 误弹的代价是每个老用户开界面都被挡一张卡；漏弹的代价只是他自己去设置页填——
/// 两害相权，宁可不弹（与 mention_prompt 里"配置读不到就不问"同一条纪律）。
///
/// 注意判据里**没有**"她叫什么"这一项：词表是不是空的，只决定第一步要不要提醒，不决定弹不弹
/// ——群里打不打 @ 是外部习惯，不该拿来判断"这是不是第一次启动"。
bool shouldShowOnboarding({
  required bool askedBefore,
  required bool? identityIsSeed,
  required bool apiReady,
  required bool channelsReady,
}) {
  if (askedBefore) return false;
  if (identityIsSeed != true) return false;
  return !apiReady || !channelsReady;
}

/// 要不要把引导摆出来——**唯一**的那处判断（宿主只读结果，不再自己加条件）。
///
/// [forceEnv] 是 [kForceOnboardingEnv] 的原始值（宿主从环境变量读来传进来；纯函数才好测）。
/// 它是排障口子：在一台已经配好的机器上想看这张卡长什么样，设 `IRMIA_GUI_FORCE_ONBOARDING=1`
/// 起一次界面即可——但它**只放宽**判据，不放宽"已经走过就不再弹"：
/// 人点过「以后再说」之后，连强制也不该再把卡拍在他脸上。
bool shouldShowOnboardingNow({
  required bool askedBefore,
  required bool? identityIsSeed,
  required bool apiReady,
  required bool channelsReady,
  String? forceEnv,
}) {
  if (askedBefore) return false;
  if (forceEnv == '1') return true;
  return shouldShowOnboarding(
    askedBefore: askedBefore,
    identityIsSeed: identityIsSeed,
    apiReady: apiReady,
    channelsReady: channelsReady,
  );
}

/// 读一遍服务端的现状。任何一项读不到都退化成"只有真相的那部分"——
/// 这里**不抛**：引导是个提示，读不到就不弹（判据那边兜住），不该让壳崩。
Future<OnboardingSignals> readOnboardingSignals(AppState state) async {
  dynamic cfg;
  try {
    cfg = await state.api.get('/api/config');
  } catch (_) {
    cfg = null;
  }

  var apiKeyConfigured = false;
  try {
    final keys = await state.api.get('/api/keys');
    final heavy = keys is Map ? keys['heavy'] : null;
    apiKeyConfigured = heavy is Map && heavy['configured'] == true;
  } catch (_) {
    // 读不到就当作"没配"：这一点只影响"这一步要不要提醒"，不影响是否弹卡（人格那边说了算）
  }

  final model = _text(cfg, 'models.heavy.model');
  final baseUrl = _text(cfg, 'models.heavy.baseUrl');

  final keywords = <String>[];
  final rawKeywords = _at(cfg, 'channels.mentionKeywords');
  if (rawKeywords is List) {
    keywords.addAll(rawKeywords.whereType<String>().map((w) => w.trim()).where((w) => w.isNotEmpty));
  }

  final qqEnabled = _at(cfg, 'channels.qqOfficial.enabled') == true;
  final onebotEnabled = _at(cfg, 'channels.onebot.enabled') == true;

  // 人格现状：`GET /api/persona/files` 的 `isSeed` 逐份给。
  //
  // 为什么读这条而不是 dashboard 的某个字段：本机这份服务端的 dashboard 里**没有**人格种子
  // 标记（`personaIsSeed` 不在响应里，实测过），人格的 isSeed 只出现在这里。读不到 IDENTITY.md
  // 条目就当"不确定"（null）——判据会因此不弹，不会误伤老用户。
  bool? identityIsSeed;
  String? identityContent;
  try {
    final files = await state.api.get('/api/persona/files');
    final list = files is Map ? files['files'] : null;
    if (list is List) {
      for (final raw in list) {
        if (raw is! Map) continue;
        if (raw['path']?.toString() != kIdentityFile) continue;
        identityIsSeed = raw['isSeed'] == true;
      }
      if (identityIsSeed != null) {
        final view = await state.api.get('/api/persona/file?path=${Uri.encodeComponent(kIdentityFile)}');
        final content = view is Map ? view['content'] : null;
        identityContent = content is String ? content : null;
      }
    }
  } catch (_) {
    // 保持 null = 不确定
  }

  return OnboardingSignals(
    identityIsSeed: identityIsSeed,
    // 判据口径：模型名与端点非空、且密钥有着落，才算 API 侧就绪。
    // 语义侧那一半在 src/config/config.ts：`models.light` 整块缺省时会回落到与 heavy 同一份默认，
    // 而 DsClient 用的是 heavy 的 baseUrl 与 heavy 那把密钥（src/main.ts:415）——所以这里只问 heavy。
    apiReady: model.isNotEmpty && baseUrl.isNotEmpty && apiKeyConfigured,
    channelsReady: qqEnabled || onebotEnabled,
    model: model,
    baseUrl: baseUrl,
    apiKeyConfigured: apiKeyConfigured,
    qqEnabled: qqEnabled,
    onebotEnabled: onebotEnabled,
    mentionKeywords: keywords,
    identityContent: identityContent,
    // 名字就地认出来（同一份正文，不必再发一条请求）：口径全在 her_name.dart——
    // 认不出来就是 null，第一步的名字格留空，界面显示回退值，**不猜**。
    herName: herNameFromIdentity(identityContent),
  );
}

/// 引导宿主：包住整个壳，首帧之后看一眼要不要弹。
///
/// 与 [AskCardHost] 的分工：那张卡是**她**问的、每次运行都可能再来；这张卡是**一次性的**，
/// 走完（或人点过"以后再说"）就写盘，此后不再出现。
class OnboardingHost extends StatefulWidget {
  const OnboardingHost({super.key, required this.state, required this.child});

  final AppState state;
  final Widget child;

  @override
  State<OnboardingHost> createState() => _OnboardingHostState();
}

class _OnboardingHostState extends State<OnboardingHost> {
  /// 本次运行里已经处理过（弹过、或读完现状判定不弹）：一次会话里只做一次判断
  bool checked = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_maybeShow()));
  }

  Future<void> _maybeShow() async {
    if (checked || !mounted) return;
    checked = true;

    final askedBefore = await loadFlag(kOnboardingDoneFlag);
    if (!mounted) return;
    final force = Platform.environment[kForceOnboardingEnv];
    // 强制口子下不必读现状：它要答的问题是"这张卡长什么样、四步走得通吗"，
    // 而在一台配好的机器上现状永远说"不该弹"（见 shouldShowOnboardingNow）。
    final signals = force == '1' ? null : await readOnboardingSignals(widget.state);
    if (!mounted) return;
    if (!shouldShowOnboardingNow(
      askedBefore: askedBefore,
      identityIsSeed: signals?.identityIsSeed,
      apiReady: signals?.apiReady ?? false,
      channelsReady: signals?.channelsReady ?? false,
      forceEnv: force,
    )) {
      return;
    }
    await _show(signals: signals);
  }

  Future<void> _show({OnboardingSignals? signals}) async {
    final ready = signals ?? await readOnboardingSignals(widget.state);
    if (!mounted) return;
    final wrote = await showOnboardingCard(context, state: widget.state, signals: ready);
    // 先落「问过了」再提示：写盘失败也只是下次再问一遍，不阻塞任何人
    await saveFlag(kOnboardingDoneFlag, true);
    if (!mounted) return;
    IrmiaToast.show(
      context,
      wrote ? '引导走完了，之后不再自动弹出' : '先记着这件事——设置页与人格配置页里随时能填',
      kind: wrote ? ToastKind.success : ToastKind.info,
    );
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// 四步的标题与一句人话（标题也当步骤条的标签用：一处措辞，两处显示）
class _Step {
  const _Step(this.key, this.title, this.note);

  final String key;
  final String title;
  final String note;
}

const _steps = <_Step>[
  _Step('name', '她叫什么', '名字是她的身份；下面那份词表是"机器怎么认出在叫她"——群里不打 @ 直接喊到它，框架才当作在叫她。'),
  _Step('api', 'API 配置', '她用的是哪家模型。写进 config.json 与 data/.keys.json，进程重启后接管。'),
  _Step('channel', '消息适配器', '她从哪个通道收消息。密钥与端点细节在「消息适配器」页里补齐。'),
  _Step('persona', '人格', '她是谁。这一段写进 persona/IDENTITY.md，是她的常驻人格。'),
];

/// 打开引导卡，返回**有没有真的写进去过东西**（false = 四步都跳过了或原地关掉）。
///
/// 返回这个 boolean 是为了让宿主那句收尾提示说准：全跳过的场合说"走完了"是假的。
Future<bool> showOnboardingCard(
  BuildContext context, {
  required AppState state,
  required OnboardingSignals signals,
}) async {
  if (!context.mounted) return false;
  final result = await showDialog<bool>(
    context: context,
    // 点遮罩不关：这张卡里有四个输入框，误点一下就把人刚打的字丢了
    barrierDismissible: false,
    builder: (_) => _OnboardingCard(state: state, signals: signals),
  );
  return result ?? false;
}

class _OnboardingCard extends StatefulWidget {
  const _OnboardingCard({required this.state, required this.signals});

  final AppState state;
  final OnboardingSignals signals;

  @override
  State<_OnboardingCard> createState() => _OnboardingCardState();
}

class _OnboardingCardState extends State<_OnboardingCard> {
  int step = 0;

  /// 正在结算：一次只允许一个请求飞（按钮同时按下去，避免连点写出两份）
  bool busy = false;

  /// 写失败的原因（留在卡上，不塞进 toast——输入框还在，人要照着改）
  String? problem;

  /// "这一屏还缺一样东西"（比如没填密钥）：与 [problem] 一样摆在卡上，但**不拦人退出**
  /// ——"我这次先不填"是完全正常的决定，退出时不该被自己的提示挡住。
  String? requirement;

  /// 有没有真的写进去过东西
  bool wrote = false;

  /// 已经被处理过的步骤（手动「跳过」，或结算成功）：不再重复写
  final settled = <int>{};

  /// 人有没有**主动**前后走过一步（点卡脚那两个键）。
  ///
  /// 为什么要它在：「上一步」只在第 2 步之后才摆出来，如果它一出现就占住位置，卡脚那排按钮
  /// 会在第 1→2 步之间整体挪一下（主按钮横向跳一格）。所以第一次往前走之后就一直留着它——
  /// 位置稳定比"少一个用不上的按钮"重要（这是照着 [ConfirmDialog] 那族"按钮位置不跳"的分寸）。
  bool navigated = false;

  // ── 第一步：她叫什么（两格：名字 + 唤醒词表） ──
  /// 她的名字 → persona/IDENTITY.md 的「名字：」那一行
  late final TextEditingController nameCtl =
      TextEditingController(text: widget.signals.herName ?? '');

  /// 群里喊哪些词算在叫她 → channels.mentionKeywords（机器配置）
  late final TextEditingController keywordsCtl =
      TextEditingController(text: widget.signals.mentionKeywords.join('、'));

  /// 上一次由名字**自动**填进唤醒词框的内容。
  ///
  /// 为什么记它：填名字的时候顺手把唤醒词填上（"小七"填完，词表里就有"小七"），
  /// 但**只在人没有自己写过词表时**这么干——人改过的词表是一个决定，不能被名字的输入覆盖掉。
  /// 判据就是这个字段：框里的内容还是我们上次填的那份（或本来是空的），才可以再同步一次。
  String autoKeywords = '';

  // ── 第二步：API 配置 ──
  late final TextEditingController modelCtl = TextEditingController(text: widget.signals.model);
  late final TextEditingController baseCtl = TextEditingController(text: widget.signals.baseUrl);
  final keyCtl = TextEditingController();

  // ── 第三步：消息适配器（现状 + 人这次的选择；勾上的就是"这次要开"的） ──
  late bool qqOn = widget.signals.qqEnabled;
  late bool onebotOn = widget.signals.onebotEnabled;

  // ── 第四步：人格 ──
  late final TextEditingController personaCtl =
      TextEditingController(text: widget.signals.identityContent ?? '');

  /// 第四步输入框的**基准**（= 服务端那句"现正文"）。
  ///
  /// 为什么要一个可变字段而不是每次读 `signals.identityContent`：第一步写完名字之后，
  /// 服务端那份正文就变了（多了「名字：」那一行），基准得跟着走——否则第四步会把
  /// 第一步刚写的名字当成"人的改动"，或者反过来把名字冲掉。
  late String personaBase = widget.signals.identityContent ?? '';

  @override
  void dispose() {
    // 退场动画跑完再销毁输入控制器：`showDialog` 的 Future 在路由弹出时就 resolve，
    // 而这几个 TextField 还要几十毫秒才从树上摘掉（原因见 ui_kit 里那段注释）。
    for (final ctl in [nameCtl, keywordsCtl, modelCtl, baseCtl, keyCtl, personaCtl]) {
      disposeLater(ctl);
    }
    super.dispose();
  }

  /// 输入框的值变没变（统一 trim：尾部空格是手滑，不是值）
  bool get _modelDirty =>
      modelCtl.text.trim() != widget.signals.model || baseCtl.text.trim() != widget.signals.baseUrl;

  bool get _keyDirty => keyCtl.text.trim().isNotEmpty;

  bool get _personaDirty => personaCtl.text.trim() != personaBase.trim();

  /// 现在"她叫什么"这件事上已知的名字：第一步那一格填着就用它，否则用读到的现状。
  /// 第四步写正文时用它把「名字：」那一行带上（换了正文不该把名字弄丢）。
  String get _knownName {
    final typed = sanitizeHerNameInput(nameCtl.text);
    return typed.isNotEmpty ? typed : sanitizeHerNameInput(widget.signals.herName ?? '');
  }

  /// 名字格敲字时把唤醒词框顺手带上（只在人没自己写过词表时，理由见 [autoKeywords]）
  void _syncKeywordsFromName() {
    final current = keywordsCtl.text.trim();
    if (current.isNotEmpty && current != autoKeywords) return;
    final next = sanitizeHerNameInput(nameCtl.text);
    if (next == current) return;
    autoKeywords = next;
    keywordsCtl.text = next;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: kOnboardingCardWidth),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(scheme),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 4, 22, 14),
              child: _stepStrip(scheme),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 4),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: _bodyMinHeight),
                  child: _body(scheme),
                ),
              ),
            ),
            if (problem != null) _problemBar(scheme),
            if (requirement != null) _requirementBar(scheme),
            _footer(scheme),
          ],
        ),
      ),
    );
  }

  // ── 卡头：她的脸 + 标题 + 关闭 ──

  Widget _header(ColorScheme scheme) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 20, 14, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const HerFace(size: 40),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Text(kOnboardingTitle,
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                    const SizedBox(width: 8),
                    Text('${step + 1} / ${_steps.length}',
                        style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                  ],
                ),
                const SizedBox(height: 4),
                Text('四步把她的基本配置填完，跳过的那几项之后在设置页里随时能改。',
                    style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          IconButton(
            onPressed: busy ? null : () => unawaited(_finish()),
            icon: const Icon(Icons.close_rounded, size: 18),
            color: scheme.onSurfaceVariant,
            tooltip: kOnboardingCloseLabel,
          ),
        ],
      ),
    );
  }

  /// 步骤条：序号 + 标题。点已经走过的那几步可以一步一步退回去改（与「上一步」同一条路）
  Widget _stepStrip(ColorScheme scheme) {
    return Row(
      children: [
        for (var i = 0; i < _steps.length; i++) ...[
          if (i > 0)
            Expanded(
              child: Container(
                height: 1,
                margin: const EdgeInsets.symmetric(horizontal: 6),
                color: i <= step ? scheme.primary.withValues(alpha: 0.45) : scheme.outlineVariant,
              ),
            ),
          _stepChip(i, scheme),
        ],
      ],
    );
  }

  Widget _stepChip(int index, ColorScheme scheme) {
    final active = index == step;
    final done = index < step;
    final tone = active ? scheme.primary : (done ? scheme.primary : scheme.onSurfaceVariant);
    return InkWell(
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      onTap: (busy || index >= step) ? null : () => unawaited(_stepBack(index)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 18,
              height: 18,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: active ? scheme.primary : Colors.transparent,
                border: Border.all(color: tone.withValues(alpha: active ? 1 : 0.5)),
                shape: BoxShape.circle,
              ),
              child: Text(
                '${index + 1}',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: active ? scheme.onPrimary : tone,
                ),
              ),
            ),
            const SizedBox(width: 6),
            Text(
              _steps[index].title,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                color: tone,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _problemBar(ColorScheme scheme) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(22, 6, 22, 0),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: IrmiaTheme.danger.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: IrmiaTheme.danger.withValues(alpha: 0.32)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline_rounded, size: 16, color: IrmiaTheme.danger),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              problem!,
              style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
            ),
          ),
        ],
      ),
    );
  }

  /// 「这一屏还缺一样东西」：与 [_problemBar] 同一块版式，只是换成 warn 色。
  ///
  /// 为什么与"写失败"分开：[problem] 是"这次没成，改完再来"，会把人留在卡里；而缺一样东西
  /// 是"还没填，你要么现在填、要么明确跳过"——后者不该把人锁住（见 [_finish]）。
  /// 出路就是卡脚那颗「跳过这一步」，所以这里不再放第二个同名按钮（两个一样的动作只会让人犹豫点哪个）。
  Widget _requirementBar(ColorScheme scheme) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(22, 6, 22, 0),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: IrmiaTheme.warn.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: IrmiaTheme.warn.withValues(alpha: 0.32)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.info_outline_rounded, size: 16, color: IrmiaTheme.warn),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              requirement!,
              style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
            ),
          ),
        ],
      ),
    );
  }

  Widget _footer(ColorScheme scheme) {
    final last = step == _steps.length - 1;
    return Container(
      padding: const EdgeInsets.fromLTRB(22, 12, 22, 16),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(
        children: [
          TextButton(
            onPressed: busy ? null : () => unawaited(_finish()),
            style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
            child: const Text('以后再说'),
          ),
          const Spacer(),
          // 「上一步」第一次往前走之后就一直留着（位置不跳，理由见 navigated）
          if (step > 0 || navigated) ...[
            TextButton(
              onPressed: (busy || step == 0) ? null : () => unawaited(_back()),
              child: const Text(kOnboardingBackLabel),
            ),
            const SizedBox(width: 6),
          ],
          TextButton(
            onPressed: busy ? null : () => unawaited(_skipStep()),
            child: const Text(kOnboardingSkipLabel),
          ),
          const SizedBox(width: 6),
          FilledButton(
            onPressed: busy ? null : () => unawaited(last ? _finish() : _next()),
            child: busy
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(last ? kOnboardingDoneLabel : kOnboardingNextLabel),
          ),
        ],
      ),
    );
  }

  // ── 每步的正文 ──

  Widget _body(ColorScheme scheme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(_steps[step].title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Text(_steps[step].note,
            style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 16),
        switch (step) {
          0 => _nameStep(scheme),
          1 => _apiStep(scheme),
          2 => _channelStep(scheme),
          _ => _personaStep(scheme),
        },
      ],
    );
  }

  /// 框下面那行旁注：与设置页的 note 同一形态（12px / 行高 1.7 / onSurfaceVariant）
  Widget _note(String text, ColorScheme scheme) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(text, style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant)),
      );

  /// 第一步：她的名字（人格资产）+ 唤醒词表（机器配置）。
  ///
  /// 为什么是两格而不是一格：这是**两件事**，以前挤在一格里（只写词表）正是这次的 bug。
  ///   ① 名字 = 她是谁，落在 `persona/IDENTITY.md` 的「名字：」那一行——界面上的称呼
  ///      （窗口标题、左侧栏、托盘提示、"她问你"那张卡）读的都是它；
  ///   ② 词表 = 机器怎么认出在叫她，落在 `channels.mentionKeywords`——是**唤醒判据**，
  ///      从名字派生出来的第一份默认值，人可以按群里的叫法改宽或改窄。
  /// 名字改了而词表没改，群里喊新名字她照样听不见——所以两格并排摆着，关系写在旁注里。
  Widget _nameStep(ColorScheme scheme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('她的名字', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        TextField(
          controller: nameCtl,
          autofocus: true,
          style: const TextStyle(fontSize: 13),
          onChanged: (_) => setState(() {
            problem = null;
            _syncKeywordsFromName();
          }),
          decoration: const InputDecoration(hintText: '小七'),
        ),
        _note('写进 persona/IDENTITY.md 的「名字：」那一行——她的人格身份（服务端写前会留一份'
            '旧版本快照，人格配置页里能看能回滚）。界面上显示的就是这个名字。', scheme),
        const SizedBox(height: 16),
        Text('群里喊哪些词算在叫她', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        TextField(
          controller: keywordsCtl,
          style: const TextStyle(fontSize: 13),
          onChanged: (_) => setState(() => problem = null),
          decoration: InputDecoration(hintText: mentionKeywordsHint(_knownName)),
        ),
        _note('写进通道配置 channels.mentionKeywords：正文里出现这几个词就当作"在叫她"'
            '（与平台的 @ 走同一条路）。用逗号或顿号隔开；上面填了名字这里会自动跟着填一份，'
            '你可以改宽或改窄；**清空 = 只认平台的 @**。', scheme),
      ],
    );
  }

  Widget _apiStep(ColorScheme scheme) {
    // 已配置时的样子（蓝、居中）与设置页的密钥格共用一份：ui_kit 的 secretLook
    final look = secretLook(
      context,
      configured: widget.signals.apiKeyConfigured,
      hintFontSize: 13,
      base: InputDecoration(
        hintText: widget.signals.apiKeyConfigured ? '已配置；粘贴新密钥可覆盖' : 'sk-…',
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('模型名', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        TextField(
          controller: modelCtl,
          autocorrect: false,
          enableSuggestions: false,
          style: const TextStyle(fontSize: 13),
          onChanged: (_) => setState(() => problem = null),
          decoration: const InputDecoration(hintText: 'deepseek-chat'),
        ),
        const SizedBox(height: 12),
        Text('Base URL', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        TextField(
          controller: baseCtl,
          autocorrect: false,
          enableSuggestions: false,
          style: const TextStyle(fontSize: 13),
          onChanged: (_) => setState(() => problem = null),
          decoration: const InputDecoration(hintText: 'https://api.deepseek.com'),
        ),
        _note('API 根地址，不含 /responses。', scheme),
        const SizedBox(height: 12),
        Text('API Key', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        TextField(
          controller: keyCtl,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          style: const TextStyle(fontSize: 13),
          textAlign: look.textAlign,
          onChanged: (_) => setState(() => problem = null),
          decoration: look.decoration,
        ),
        _note('密钥只写不读（写进 data/.keys.json，界面此后只显示掩码）。'
            '轻量那条 lane 跟着这里的主配置走，不必再填一遍。', scheme),
      ],
    );
  }

  Widget _channelStep(ColorScheme scheme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _channelTile(
          scheme,
          label: 'QQ 官方 Bot API',
          detail: '官方开放平台那条通道；AppID 与 AppSecret 在「消息适配器」页里填。',
          value: qqOn,
          wasOn: widget.signals.qqEnabled,
          onChanged: (next) => setState(() {
            qqOn = next;
            problem = null;
          }),
        ),
        const SizedBox(height: 8),
        _channelTile(
          scheme,
          label: 'OneBot 11',
          detail: '连本机协议端（NapCat / go-cqhttp）的正向 WebSocket；ws 地址与 access_token 在「消息适配器」页里填。',
          value: onebotOn,
          wasOn: widget.signals.onebotEnabled,
          onChanged: (next) => setState(() {
            onebotOn = next;
            problem = null;
          }),
        ),
        _note(!widget.signals.channelsReady
            ? '两个都关着 = 她收不到任何消息；之后在「消息适配器」页里随时能开。'
            : '现在开着的那条不会再被这里关掉（这一屏只负责"要开哪条"）。', scheme),
      ],
    );
  }

  Widget _channelTile(
    ColorScheme scheme, {
    required String label,
    required String detail,
    required bool value,
    required bool wasOn,
    required ValueChanged<bool> onChanged,
  }) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 10, 12, 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: value ? scheme.primary.withValues(alpha: 0.45) : scheme.outlineVariant),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Checkbox(
            value: value || wasOn,
            // 现成就开着的那条只读：这一屏的语义是"启用哪个入站通道"，不是"顺手关掉一个"
            onChanged: wasOn ? null : (next) => onChanged(next ?? false),
            visualDensity: VisualDensity.compact,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurface)),
                const SizedBox(height: 3),
                Text(detail, style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          if (wasOn)
            Padding(
              padding: const EdgeInsets.only(left: 8, top: 2),
              child: Text('现在开着', style: TextStyle(fontSize: 11, color: scheme.primary)),
            ),
        ],
      ),
    );
  }

  Widget _personaStep(ColorScheme scheme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          height: 148,
          child: TextField(
            controller: personaCtl,
            maxLines: null,
            expands: true,
            textAlignVertical: TextAlignVertical.top,
            keyboardType: TextInputType.multiline,
            style: TextStyle(fontFamily: 'monospace', fontSize: 12.5, height: 1.7, color: scheme.onSurface),
            onChanged: (_) => setState(() => problem = null),
            decoration: const InputDecoration(
              hintText: '# 我是谁\n\n（名字、身份、核心性格。500 token 以内）',
            ),
          ),
        ),
        _note('这段文字就是 persona/IDENTITY.md 的全部内容（写上去 = 替换整份文件，服务端会先留一份'
            '旧版本快照，人格配置页里能看能回滚）。留空或没改动就不写；'
            '框里是空的且你现在写点什么，那就是用这段文字替掉文件里原来的内容。'
            '第一步填过名字的话，它会作为开头那一行「名字：…」跟着写进去——别删掉那一行，'
            '界面上的称呼与唤醒词的默认值都读它。', scheme),
      ],
    );
  }

  // ── 结算 ──

  /// 把第 [i] 步结算掉（没写过就跳过）并记下；返回失败原因（null = 成了）
  Future<String?> _settleOnce(int i) async {
    if (settled.contains(i)) return null;
    requirement = null;
    final err = await _settle(i);
    if (err == null) settled.add(i);
    return err;
  }

  /// 往前走**一步**：把**当前这一步**结算掉再过去。
  ///
  /// 为什么只结算当前这步：往后那几步人**还没开始填**（第 2 步的密钥、第 4 步的人格都在后面），
  /// 顺手一起结算只会撞上"还没填"的拦阻——那正是"往前走一步"该走成的动作。
  /// 一路走到底时每步各结算各的；中途关卡的场合由 [_finish] 把剩下的补齐。
  Future<void> _next() async {
    if (busy || step >= _steps.length - 1) return;
    setState(() {
      busy = true;
      problem = null;
      requirement = null;
    });
    final err = await _settleOnce(step);
    if (!mounted) return;
    if (err != null) {
      setState(() {
        problem = err;
        busy = false;
      });
      return;
    }
    setState(() {
      navigated = true;
      step += 1;
      busy = false;
    });
  }

  /// 往后退**一步**：只回退，不结算。
  ///
  /// 退回去的那一步会从 [settled] 里放出来（连同它后面已经走过的几步），于是人改完再往前走时
  /// 会重新结算一次——"点过跳过、后来又想填"是完全正常的顺序，不该因为先跳过就再也写不进去。
  ///
  /// 为什么是"一步"而不是"跳到第 N 步"：后者要顺带结算中间每一步，于是点一次「上一步」
  /// 可能往回跳好几步——实测踩到过，那种"点一下退两步"的界面最像坏了。
  Future<void> _back() async {
    if (busy || step == 0) return;
    settled.removeWhere((index) => index >= step - 1);
    setState(() {
      navigated = true;
      problem = null;
      step -= 1;
    });
  }

  /// 跳到已经走过的那一步（步骤条上的圆点）：**只能往回**，且同样一步一脚印地退。
  ///
  /// 为什么不做"点第 4 步就跳到第 4 步"：那等于替人跳过中间两步（跳过 = 一个字节都不写，
  /// 与他自己按「跳过这一步」是两件事）；这里退一步，他再点一次就再退一步，明明白白。
  ///
  /// [index] 只用来判"是不是往回"——具体退到第几步由 [_back] 说了算（一步），
  /// 两处各退各的迟早会分叉。
  Future<void> _stepBack(int index) async {
    if (busy || index >= step) return;
    await _back();
  }

  /// 跳过这一步：这一步**一个字节都不写**，只是不再问它（退回来再填照样能写进去）
  Future<void> _skipStep() async {
    if (busy) return;
    if (step == _steps.length - 1) {
      await _finish();
      return;
    }
    setState(() {
      navigated = true;
      problem = null;
      requirement = null;
      step += 1;
    });
  }

  /// 完成 / 关闭 / 以后再说：把**还没结算的那几步**补上，再退出。
  ///
  /// 补的是哪几步：人可能在第 1 步填完称呼就一路按「以后再说」，也可能退回去改过模型又直接关掉
  /// ——凡是这一趟填过、却还没落盘的东西，都在这里补写（每步自己判"改了没有"，重复走不会重复写）。
  ///
  /// 两类"没成"在这里是**两件事**：
  ///   · [_problem]（写失败：网络断了、服务端拒了）——**把人留住**并说清原因，退出去就是静默丢；
  ///   · [_requirement]（这一屏还没填：比如没填密钥）——**照旧退出**，只在卡上报一句。
  ///     人这次就是不想填，退出时被自己的提示挡住是最没道理的一种拦阻。
  ///
  /// 「以后再说」与关闭的区别只在措辞：两者都写 `onboarding-done`（不再自动弹），
  /// 但已经填好的那几步照样落盘——人填了东西却因为"没点完成"而丢掉，最没道理。
  Future<void> _finish() async {
    if (busy) return;
    setState(() {
      busy = true;
      problem = null;
      requirement = null;
    });
    for (var i = 0; i < _steps.length; i++) {
      final err = await _settleOnce(i);
      if (err != null) {
        if (!mounted) return;
        setState(() {
          step = i;
          problem = err;
          busy = false;
        });
        return;
      }
    }
    if (!mounted) return;
    Navigator.of(context).pop(wrote);
  }

  /// 结算第 [i] 步：返回 null = 成了（或本来就没东西可写），返回文字 = 失败原因。
  ///
  /// "还缺一样东西"（[requirement]）不算失败：它把话摆在卡上，但**不**拦住这一次动作
  /// ——人按「继续」时看到"缺密钥"就说明白了（这一步没写成），按关闭/以后再说则直接退出。
  Future<String?> _settle(int index) async {
    switch (_steps[index].key) {
      case 'name':
        return _settleName();
      case 'api':
        return _settleApi();
      case 'channel':
        return _settleChannel();
      default:
        return _settlePersona();
    }
  }

  /// 第一步 → 两条通道，各写各的：
  ///   · 名字 → `POST /api/commands/persona-edit`（{file:'IDENTITY.md', content: 正文 + 名字行}）
  ///   · 词表 → `POST /api/commands/set-mention-keywords`（{keywords: [...]}）
  ///
  /// 顺序是刻意的：先写人格身份（"她是谁"），再写唤醒判据（"机器怎么认出在叫她"）。
  /// 前一步失败就停在原地报原因，不往下写——人看到的现状与盘上的一致，重试一次即可。
  Future<String?> _settleName() async {
    final name = sanitizeHerNameInput(nameCtl.text);
    if (name.runes.length > kHerNameMaxChars) {
      return '名字最多 $kHerNameMaxChars 个字，未保存';
    }
    final keywords = splitMentionKeywords(keywordsCtl.text);

    // ── ① 名字 → 人格资产 ──
    if (name.isNotEmpty && name != widget.signals.herName) {
      final base = widget.signals.identityContent;
      // **底稿必须是真的正文**：读不到就只能不写。拿一份空串当底稿，等于用"名字：小七"
      // 一行覆盖掉她整个人格——这是这一步唯一会造成实质破坏的可能，所以宁可报错。
      if (base == null) {
        return '读不到 persona/IDENTITY.md 的现正文，名字没写（去人格配置页改「名字：」那一行）';
      }
      final next = upsertHerNameLine(base, name);
      try {
        await widget.state.api
            .post('/api/commands/persona-edit', {'file': kIdentityFile, 'content': next});
      } catch (err) {
        return '名字没写进去：$err';
      }
      wrote = true;
      // 第四步那个框跟着走：不这么做，人接着往下走、在第四步写一份正文，就把刚填的名字冲掉了
      // （他手上那份稿子也补上同一行——他要是已经改过稿，改过的那份不能被我们丢掉）
      personaCtl.text = upsertHerNameLine(personaCtl.text, name);
      personaBase = next;
      // 界面上的称呼（窗口标题 / 侧栏 / 托盘）立刻跟手：重读一遍盘上那份，而不是把输入当结论
      await widget.state.refreshHerName();
    }

    // ── ② 唤醒词 → 通道配置（机器配置；从名字派生的第一份默认值） ──
    if (keywords.join('、') != widget.signals.mentionKeywords.join('、')) {
      try {
        await widget.state.api.post('/api/commands/set-mention-keywords', {'keywords': keywords});
      } catch (err) {
        return '唤醒词没写进去：$err';
      }
      wrote = true;
    }
    return null;
  }

  /// 第二步 → 模型与端点走 `config-update`（短语 config-update），密钥走 `set-key`（短语 set-key）
  Future<String?> _settleApi() async {
    final model = modelCtl.text.trim();
    final baseUrl = baseCtl.text.trim();
    final key = keyCtl.text.trim();
    final fields = <String, dynamic>{};

    if (_modelDirty) {
      // 两格是一个整体：只改一半的配置写下去，下一次启动就是连不上的那一半
      if (model.isEmpty) return '模型名不能为空，未保存';
      if (baseUrl.isEmpty) return 'Base URL 不能为空，未保存';      if (model != widget.signals.model) fields['models.heavy.model'] = model;
      if (baseUrl != widget.signals.baseUrl) fields['models.heavy.baseUrl'] = baseUrl;
    }
    // 第一次启动的人最可能什么都不改就点继续（默认值本来就是 DeepSeek 那两个），
    // 所以这一屏**不拦**"没填模型"——真正拦人的是密钥那一条：没有它她连不上任何模型。
    //
    // 注意它走的是 requirement 而不是 problem：这是"还没填"，不是"写失败"——人按关闭 /
    // 以后再说时不该被它挡住（见 _finish）。写失败由下面的 catch 报成 problem。
    if (key.isEmpty && !widget.signals.apiKeyConfigured) {
      requirement = keysRequiredNote;
    }
    if (fields.isEmpty && !_keyDirty) return null;

    try {
      if (fields.isNotEmpty) {
        await widget.state.api
            .post('/api/commands/config-update', {'fields': fields}, confirm: 'config-update');
      }
      if (key.isNotEmpty) {
        await widget.state.api
            .post('/api/commands/set-key', {'name': 'heavy', 'value': key}, confirm: 'set-key');
      }
    } catch (err) {
      return 'API 配置没写进去：$err';
    }
    wrote = true;
    return null;
  }

  /// 第三步 → `POST /api/commands/config-update`（短语 config-update），只提交开关本身
  Future<String?> _settleChannel() async {
    final fields = <String, dynamic>{};
    if (qqOn && !widget.signals.qqEnabled) fields['channels.qqOfficial.enabled'] = true;
    if (onebotOn && !widget.signals.onebotEnabled) fields['channels.onebot.enabled'] = true;
    if (fields.isEmpty) return null;
    try {
      await widget.state.api
          .post('/api/commands/config-update', {'fields': fields}, confirm: 'config-update');
    } catch (err) {
      return '通道开关没写进去：$err';
    }
    wrote = true;
    return null;
  }

  /// 第四步 → `POST /api/commands/persona-edit`（危险表里是 null：不带确认短语）
  ///
  /// 写之前把「名字：」那一行补上（见 her_name.dart 的 upsertHerNameLine）：名字是界面上的称呼
  /// 与唤醒词的来源，**换一份正文不该把它弄丢**。旁注里跟人说清了这件事，所以不是暗箱操作。
  Future<String?> _settlePersona() async {
    final draft = personaCtl.text.trim();
    if (!_personaDirty) return null;
    if (draft.isEmpty) return '人格不能写成空的（要清空请去人格配置页），未保存';
    final content = upsertHerNameLine(draft, _knownName);
    try {
      await widget.state.api.post('/api/commands/persona-edit', {
        'file': kIdentityFile,
        'content': content,
      });
    } catch (err) {
      return '人格没写进去：$err';
    }
    wrote = true;
    // 名字行可能刚补上或刚被改掉：界面上的称呼跟着重读一遍（读不到就保持现状，见 refreshHerName）
    await widget.state.refreshHerName();
    return null;
  }
}

/// 第二步缺密钥时卡上那句话（单独拎出来是为了能被测试直接引用，不靠抄一遍文案）
const keysRequiredNote = '还没填 API Key：她连不上任何模型。填进去，或者点「以后再说」稍后再配。';

const kOnboardingNextLabel = '继续';
const kOnboardingBackLabel = '上一步';
const kOnboardingSkipLabel = '跳过这一步';
const kOnboardingDoneLabel = '完成';
const kOnboardingCloseLabel = '关闭引导';

// ──────────────────────────────── 取值小工具 ────────────────────────────────

/// 按点路径取配置值（`a.b.c`）；任一层缺失都给 null
Object? _at(Object? doc, String path) {
  Object? current = doc;
  for (final segment in path.split('.')) {
    if (current is! Map) return null;
    current = current[segment];
  }
  return current;
}

/// 点路径取字符串：非字符串一律当空串（界面要的是"能显示的字"）
String _text(Object? doc, String path) {
  final value = _at(doc, path);
  return value is String ? value.trim() : '';
}
