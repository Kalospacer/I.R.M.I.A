/// 界面文案表（i18n）。
///
/// ## 为什么是自建表，不是 `intl` + codegen
///
/// 这个界面的规模：全部硬编码中文字符串字面量 **1760 条**（`gui/lib/**` 里含 CJK 的
/// 字符串字面量，去掉注释行后统计），分布在 32 个文件；最重的三处是 settings_page 435、
/// extensions_page 234、channels_page 160。**一个使用者**，Windows 桌面端，没有复数、
/// 没有性别、没有 RTL、没有日期格式分叉。
///
/// codegen 方案（`flutter gen-l10n` / ARB）买到的是：编译期检查键名、复数规则、按 locale
/// 拆文件、与 `intl` 的日期数字格式联动。代价是：一条命令链（`l10n.yaml` + `flutter
/// gen-l10n` + 生成物进 VCS 或进 build）＋ 每次加一句话都要重新生成。
///
/// 本轮选择：**一个 abstract class + 两份实现**。理由按重要性排：
///   1. **键名照样编译期检查**——`EnStrings` 不实现某个 getter，`flutter analyze` 直接报错。
///      这是 codegen 唯一真正给到我们的东西，而抽象类本来就给；
///   2. **没有生成步骤**：改一句文案 = 改一个文件，`flutter test` 立刻能跑；
///   3. 复数/RTL/日期格式本轮都用不上；真要用时（比如英文的 "1 message" / "3 messages"）
///      加一个 `String nMessages(int n)` 就是，不需要换框架。
///
/// 唯一加依赖的地方是 `flutter_localizations`：它提供的 `MaterialLocalizations` 中文文案
/// 我们自己造不出来（文本框的剪切/复制/粘贴菜单、日期与滚动条的无障碍标签都在那个包里）。
/// 见 `pubspec.yaml` 的注释与 `app.dart` 的 `localizationsDelegates`。
///
/// ## 三件**不许**进这张表的东西
///
/// 1. **她的人设文案**（`persona/IDENTITY.md`、`onboarding.dart` 的人格种子、
///    `persona_page.dart` 的默认人格正文）——那是她要成为谁，是内容，换语言也不该换；
/// 2. **她的发言与记忆正文**（聊天页的气泡、`memory_page.dart` 的记忆条目、
///    工具结果、事件日志的 `detail`）——那是她说过的话，界面无权翻译；
/// 3. **她说话的口吻**（`docs/copy-guide.md` 的语气词、`her_name.dart` 的回退名）——
///    "她怎么称呼人"是她的风格，不是 UI 的一层皮。名字是**数据**（`IDENTITY.md` 里那一行）。
///
/// ## 怎么加一句话
///
/// ```dart
/// // 1. 在 AppStrings 里加一个 getter（带参数就写成方法）
/// String get save;            // 2. ZhStrings 与 EnStrings 各实现一次，漏了 analyze 会报
/// ```
///
/// 页面里取用：`final s = IrmiaStrings.of(context);` 然后 `Text(s.save)`。
/// **不要在页面里写中文**——迁移没做完的页面在文件头挂了 `TODO(i18n)`，见
/// `docs/i18n-migration.md` 的清单。
library;

import 'dart:ui' show Locale;

/// 一种语言的可选值（持久化到 `ui-state.json` 的就是 [code]）。
enum AppLanguage {
  /// 跟随系统（`system`）
  system('system'),

  /// 中文（`zh`）
  zh('zh'),

  /// English（`en`）
  en('en');

  const AppLanguage(this.code);

  /// 落盘的取值。**改它就是改契约**：老配置文件里读不到就当 [system]。
  final String code;

  /// 从盘上读回：认不出的值一律回 [system]（读坏不该把界面卡住）
  static AppLanguage fromCode(String? code) {
    for (final value in AppLanguage.values) {
      if (value.code == code) return value;
    }
    return AppLanguage.system;
  }

  /// 具体语言码（`system` 已经由 [resolve] 解析过，这里只给 zh/en）
  String get languageCode => this == AppLanguage.en ? 'en' : 'zh';

  /// 语言选择器上的名字。
  ///
  /// **每一条都用自己的语言写**（中文那项写"中文"、英文那项写"English"）——
  /// 切到英文之后还看得见"中文"，才能切回来。这是唯一一处不做翻译的文案。
  String get endonym => switch (this) {
        AppLanguage.system => 'system',
        AppLanguage.zh => '中文',
        AppLanguage.en => 'English',
      };

  /// 把「跟随系统」解析成具体语言。
  ///
  /// [systemLocale] 由**入口**（`main.dart`）给一次，widget 树里再也不用读平台 locale——
  /// 这样 widget 测试的默认语言是确定的（中文），不会因为跑测试的机器是英文系统而全红。
  ///
  /// 认不出系统的语言时**落到中文**：这是界面的作者语言，也是"跟随系统"在没有更好
  /// 依据时的最小惊讶选择（不会因为一次系统设置变化就把整个界面变成看不懂的字）。
  AppLanguage resolve(Locale? systemLocale) {
    if (this != AppLanguage.system) return this;
    final code = (systemLocale?.languageCode ?? '').toLowerCase();
    if (code == 'en') return AppLanguage.en;
    return AppLanguage.zh;
  }
}

/// 全部界面文案。**两份实现必须一一对应**（漏一个 `flutter analyze` 就报）。
///
/// 命名口径：`<区域><东西>`，比如 `chatEmptyTitle`、`settingsLanguage`。
/// 参数用命名位置参数（`String expandAll(int chars)`），不要拼接——
/// 英文语序与中文不同，页面里拼字符串就等于把语序写死成中文。
abstract class AppStrings {
  const AppStrings();

  /// 这份文案属于哪种具体语言（`system` 不会出现在实现里）
  AppLanguage get language;

  /// 对应的 `Locale`（交给 `MaterialApp.locale`）
  Locale get locale => Locale(language.languageCode);

  /// **覆盖层的版次**（0 = 这一份是默认文案，没有任何覆盖）。
  ///
  /// 只有 `OverriddenStrings`（见 `i18n/strings_override.dart`）会给出非 0 值。
  /// 它存在的唯一理由：语言没变、但用户点了「重新载入文案」——那时
  /// `IrmiaStrings.updateShouldNotify` 必须让读过文案的 widget 重建，否则按下按钮
  /// 屏幕上什么都不会变（见 `i18n/strings_scope.dart`）。
  int get revision => 0;

  // ── 通用（三态、按钮）────────────────────────────────────────────────
  /// 重试
  String get retry;

  /// 取消
  String get cancel;

  /// 确认
  String get confirm;

  /// 保存
  String get save;

  /// 加载中（区块三态的默认那句）
  String get loading;

  /// 出错了（区块三态没有具体原因时的兜底）
  String get error;

  /// 没有内容（空态兜底）
  String get empty;

  /// 折叠：收起
  String get collapse;

  /// 展开全部（N 字）
  String expandAll(int chars);

  /// "加载失败"的通用前缀（后面接原因）
  String loadFailed(String reason);

  /// 设置页正在读配置
  String get settingsLoadingConfig;

  /// 配置读取失败：<原因>
  String configReadFailed(String reason);

  // ── 壳 / 侧栏 ──────────────────────────────────────────────────────
  /// 页面名：聊天
  String get navChat;

  /// 页面名：设置
  String get navSettings;

  /// 页面名：运行情况
  String get navOverview;

  /// 页面名：通道
  String get navChannels;

  /// 页面名：扩展
  String get navExtensions;

  /// 页面名：人格
  String get navPersona;

  /// 页面名：日程
  String get navSchedule;

  /// 页面名：记忆
  String get navMemory;

  /// 页面名：日志
  String get navLogs;

  /// 侧栏"更多"折叠组
  String get navMore;

  // ── 运行情况 / 重启 / 托盘（2026-10-17 加）────────────────────────
  //
  // 这一组是"重启与退出"那两件事的**全部界面话**。它们之所以在文案表里而不在页面里：
  // 首页那颗「重启前后端」与托盘那个菜单项**走同一条路**（见 lib/restart_action.dart），
  // 两边说的话必须是同一句——各写一份的话术迟早会说成两件事。

  /// 运行情况页那颗「配置引导」按钮（打开首次引导卡，可随时关掉）
  String get overviewConfigGuide;

  /// 重启：链条自己确认成功。[evidence] 是 [restartEvidence] 那半句凭据
  String restartConfirmed(String evidence);

  /// 重启：回执里那两截凭据（真实新 pid、端口那一档）；都没有时如实说"没给凭据"
  String restartEvidence(int backendPid, bool portReady);

  /// 重启：已发出、结局未确认（**不是失败**，见 restart_action.dart 文件头）
  String get restartSentWithGui;

  /// 重启：已发出、只重启后端（界面不在本次动作范围内）
  String get restartSentBackendOnly;

  /// 重启：链条自己说失败。[reason] 是服务端那句原因
  String restartFailed(String reason);

  /// 重启：请求本身没发出去（409 已在重启中 / 路径不存在 / 网络）
  String restartRefused(String reason);

  /// 重启：没读到任何一种结论时的一句兜底
  String get restartNoConclusion;

  /// 等后端回来：回来了
  String get restartBackReady;

  /// 等后端回来：等满窗口还没回来（[seconds] = 实际等了多少秒）
  String restartBackTimeout(int seconds);

  /// 等后端回来：它一次都没断开过（这次请求可能没生效）
  String get restartNeverWentDown;

  /// 托盘：显示界面
  String get trayShow;

  /// 托盘：收进托盘
  String get trayHide;

  /// 托盘：重启前后端（与首页那颗按钮同一个动作）
  String get trayRestart;

  /// 托盘：**只退出界面**（后端继续在后台跑）
  String get trayQuitUi;

  /// 托盘：**退出全部**（界面 + 后端一起）
  String get trayQuitAll;

  /// 退出全部：确认框标题
  String get quitAllConfirmTitle;

  /// 退出全部：确认框正文。[busy] = 她正在跑一轮（这一轮会被打断）
  String quitAllConfirmBody(bool busy);

  /// 退出全部：确认框那颗按钮
  String get quitAllConfirmLabel;

  /// 退出全部：正在停后端
  String get quitAllWorking;

  /// 退出全部：停后端失败（[reason] 是现场那句话）
  String quitAllFailed(String reason);

  /// 退出全部：都退了（写进日志的那一句）
  String get quitAllDone;

  /// 手动打开引导卡后：人改过东西，已保存
  String get onboardingManualSaved;

  /// 手动打开引导卡后：什么都没改
  String get onboardingManualNoChanges;

  // ── 首次引导（六步卡）─────────────────────────────────────────────
  //
  // 六步的标题与说明都在这一组：标题同时是步骤条上的标签（一处措辞，两处显示）。
  //
  // 第 2、3 步的推荐语**拆成两段**（前缀 + 链接文字，必要时再加一段后缀）：点开外链那一段
  // 要单独上色成蓝链，而两种语言的语序不同——把"带链接的一句话"整句塞进一条文案，页面就
  // 只能去猜链接从哪个字开始。所以链接文字自己是一条，页面只负责把它们排进同一行（Wrap）。

  /// 第 1 步的标题
  String get onboardingStepNameTitle;

  /// 第 1 步的说明（名字框**上方**那一行；第 3 轮压成一行）
  String get onboardingStepNameNote;

  /// 第 2 步的标题
  String get onboardingStepApiTitle;

  /// 第 2 步的说明
  String get onboardingStepApiNote;

  /// 第 3 步的标题
  String get onboardingStepChannelTitle;

  /// 第 3 步的说明（凭据就在下面填）
  String get onboardingStepChannelNote;

  /// 第 4 步的标题
  String get onboardingStepPersonaTitle;

  /// 第 4 步的说明
  String get onboardingStepPersonaNote;

  /// 第 5 步的标题
  String get onboardingStepTrustTitle;

  /// 第 5 步的说明
  String get onboardingStepTrustNote;

  /// 第 2 步推荐语的前半句（后面紧跟 [onboardingApiRecommendModel] 那颗蓝链）
  String get onboardingApiRecommendLead;

  /// 第 2 步推荐语里的第一个蓝链：DeepSeek 的模型
  String get onboardingApiRecommendModel;

  /// 第 2 步第二个蓝链：注册账号并获取 API Key
  String get onboardingApiRegisterKey;

  /// 第 2 步两句推荐语**之间**那个连接词（第 3 轮把两行合成一行，靠它连成一句）
  String get onboardingApiRecommendJoin;

  /// 第 3 步推荐语的前半句（后面紧跟 [onboardingChannelRecommendQq] 那颗蓝链）
  String get onboardingChannelRecommendLead;

  /// 第 3 步推荐语里的蓝链：QQ 官方 Bot
  String get onboardingChannelRecommendQq;

  /// 第 3 步推荐语的收尾（蓝链后面那几个字）
  String get onboardingChannelRecommendTail;

  /// 第 3 步 QQ 官方 Bot 那一项的说明（凭据就在下面填）
  String get onboardingQqTileDetail;

  /// 第 3 步两把凭据的小标题
  String get onboardingQqCredentialsTitle;

  /// AppID 输入框上方的标签
  String get onboardingQqAppIdLabel;

  /// AppID 输入框的占位提示
  String get onboardingQqAppIdHint;

  /// AppSecret 输入框上方的标签
  String get onboardingQqAppSecretLabel;

  /// AppSecret 输入框的占位提示
  String get onboardingQqAppSecretHint;

  /// 密钥格已配置时的提示。[mask] 是服务端给的掩码（空 = 服务端没给，别显示一对空括号）
  String onboardingSecretConfigured(String? mask);

  /// 凭据那两格下面的说明（填完会自动勾上 QQ 官方 Bot）
  String get onboardingQqCredentialsNote;

  /// 第 1 步名字框**下面**那一行（写哪儿 / 快照能回滚 / 界面上的称呼就是它）
  String get onboardingStepNameHint;

  /// 第 1 步唤醒词框**下面**那一行（分隔符 / 同平台 @ 那条路 / 清空 = 只认 @）
  String get onboardingKeywordsHint;

  /// 第 4 步正文框下面那段说明（2026-10-18 精简过；第 3 轮再压成一行）
  String get onboardingPersonaHint;

  /// 第 5 步那句边界说明（**与盘上那份一致**时）：一屏不会写盘，之后在设置页能改
  String get onboardingTrustNoteSame;

  /// 第 5 步那句边界说明（**与盘上那份不同**时）：写完要重启才接管
  String get onboardingTrustNoteChanged;

  // ── 第 6 步：外部依赖（用户第 3 轮 ⑤）───────────────────────────
  //
  // 一屏说清三件事：不装会怎样（点名四件）、现在各件什么状态、装不装（一个勾选框）。
  // 装的过程与结局也在这几条里：进行中 / 成功 / 失败原因 / 汇总 / 重试 / 上次的结果。

  /// 第 6 步的标题（步骤条上也用它）
  String get onboardingStepDepsTitle;

  /// 第 6 步的说明：不装的话哪几件工具用不了（点名四件）
  String get onboardingStepDepsNote;

  /// 勾选框：下载并安装这些外部依赖
  String get onboardingDepsInstallLabel;

  /// 四件都已就位时的说明（此时不摆勾选框，直接点「完成」）
  String get onboardingDepsAllReady;

  /// 一件依赖的现状：就位
  String get onboardingDepsStatusReady;

  /// 一件依赖的现状：未就位
  String get onboardingDepsStatusMissing;

  /// 一件依赖正在装
  String get onboardingDepsItemRunning;

  /// 一件依赖装好了
  String get onboardingDepsItemOk;

  /// 一件依赖没装成。[reason] 是服务端给的阶段 + 原因
  String onboardingDepsItemFailed(String reason);

  /// 一轮装完的汇总：成功 N / 失败 M
  String onboardingDepsSummary(int ok, int failed);

  /// 失败之后那颗「重试」
  String get onboardingDepsRetry;

  /// 复查：上一次装完的结果（同一页再打开时摆出来）
  String onboardingDepsLastRun(int ok, int failed);

  /// 读不到 `/api/deps` 时的那句话（[reason] 是现场那句话）
  String onboardingDepsReadFailed(String reason);

  /// 服务端没装配依赖管理器（`available: false`）时的那句话
  String get onboardingDepsUnavailable;

  /// 装完那个顶层窗口：标题
  String get onboardingRestartTitle;

  /// 装完那个顶层窗口：一句原因（装完要重启才生效）
  String get onboardingRestartBody;

  /// 装完那个顶层窗口：「立即重启」
  String get onboardingRestartNow;

  /// 装完那个顶层窗口：「稍后」
  String get onboardingRestartLater;

  /// 外链没打开时把地址说出来
  String onboardingOpenLinkFailed(String url);

  /// 第 3 步：通道开关没写进去。[reason] 是现场那句话
  String onboardingChannelSaveFailed(String reason);

  /// 第 3 步：AppID / AppSecret 没写进去。[reason] 是现场那句话
  String onboardingSecretsSaveFailed(String reason);

  // ── 聊天页 ────────────────────────────────────────────────────────
  /// 页头标题
  String get chatTitle;

  /// 页头副标题
  String get chatSubtitle;

  /// 输入框提示
  String get composerHint;

  /// 跳到最新
  String get jumpToLatest;

  /// 有新内容时跳到最新
  String get jumpToLatestNew;

  /// 更早的记录读失败了
  String get earlierFailed;

  /// 没有更早的记录
  String get noEarlier;

  /// 会话记录读取失败（标题）
  String get historyErrorTitle;

  /// 会话记录读取失败（正文）
  String get historyErrorMessage;

  /// 会话尚未开始（空态标题）
  String get chatEmptyTitle;

  /// 还没有会话记录。（空态正文）
  String get chatEmptyMessage;

  /// 输入消息（空态 CTA）
  String get chatEmptyAction;

  /// 空态提示
  String get chatEmptyHint;

  /// 标签：框架通报
  String get tagFrameworkNotice;

  /// 标签：框架提醒
  String get tagFrameworkReminder;

  /// 标签：注入预警
  String get tagInjection;

  /// 标签：上下文分界
  String get tagContextBoundary;

  /// 注入卡标题
  String get injectionCardTitle;

  /// 未命名会话（发送者兜底）
  String get unnamedSender;

  /// `已接收：<发送者>（<id>）`
  String receivedFrom(String sender, String id);

  /// 占位符"—"
  String get dash;

  /// <来源>里有人提到了你
  String mentionsYou(String where);

  /// 那边在聊：<内容>
  String talkingAbout(String what);

  /// 单聊消息
  String get directMessage;

  /// 群聊提及
  String get groupMention;

  /// 群聊消息
  String get groupMessage;

  /// 单聊 / 群聊（事件行里的会话类型）
  String get chatTypeDirect;

  /// 群聊
  String get chatTypeGroup;

  /// QQ 官方 Bot
  String get qqOfficialBot;

  /// 外部通道（认不出通道名时的兜底）
  String get externalChannel;

  /// QQ 消息
  String get qqMessage;

  /// OneBot 消息
  String get oneBotMessage;

  /// 外部消息（最空的那句兜底）
  String get externalMessage;

  /// 模型判定
  String get byModel;

  /// 规则命中
  String get byRule;

  /// 来自 <谁>
  String fromWho(String who);

  /// 手动唤醒
  String get manualWake;

  /// 意图唤醒
  String get intentWake;

  /// 定时任务触发
  String get schedulerFire;

  /// 原定 <时间>
  String scheduledAt(String at);

  /// 后台任务进展
  String get backgroundProgress;

  /// 做梦（事件行的动作名）
  String get eventDream;

  /// MCP 声明变更
  String get eventMcpDeclChanged;

  /// 上下文在此处清空
  String get contextClearedHere;

  /// 上下文在此处压缩
  String get contextCompactedHere;

  /// 清空分界的说明
  String get contextClearedHereDetail;

  /// 压缩分界的说明
  String get contextCompactedHereDetail;

  /// 人工答复已记录
  String get humanReplyRecorded;

  /// 已标记成功
  String get markedOk;

  /// 已标记失败
  String get markedFailed;

  /// 工具状态：运行中
  String get toolRunning;

  /// 工具状态：正在执行…
  String get toolExecuting;

  /// 工具状态：完成
  String get toolDone;

  /// 工具状态：出错
  String get toolError;

  /// 工具状态：超时（结果未知）
  String get toolTimeout;

  /// 工具状态：被策略拒绝
  String get toolDenied;

  /// 工具状态：结局未知
  String get toolUnknown;

  /// 工具状态：未派发
  String get toolNotDispatched;

  /// 工具状态：超出单步上限
  String get toolOverStepCap;

  /// 思考那一行的四个格子：`思考中` / `第 N 步` / `已想 M 字` / `用时 X`。
  ///
  /// 不做成一句模板：中文用全角空格分隔、英文用半角双空格，语序也不同
  /// （英文是 "Thinking  step 3  6.2k chars  0:07"）。拼装那一处见 chat_page 的
  /// `thinkingLine()`，它只负责补位对齐（那是个读数，不是文案）。
  String get thinkingLabel;

  /// 第 N 步
  String thinkingStep(String step);

  /// 已想 M 字
  String thinkingChars(String chars);

  /// 用时 X
  String thinkingElapsed(String elapsed);

  /// 四个格子之间的分隔符
  String get thinkingGap;

  /// 字数给人看的短写（中文按"万"分档、英文按"k"分档）
  String compactChars(int chars);

  /// toast：上下文已清空
  String get toastContextCleared;

  /// toast：清空失败：<原因>
  String toastClearFailed(String reason);

  /// toast：叫她去做梦了
  String get toastDream;

  /// toast：触发失败：<原因>
  String toastTriggerFailed(String reason);

  /// toast：重复发送被忽略
  String get toastDuplicateSend;

  /// toast：发送失败：<原因>
  String toastSendFailed(String reason);

  // ── 设置页 ────────────────────────────────────────────────────────
  /// 页头标题
  String get settingsTitle;

  /// 页头副标题
  String get settingsSubtitle;

  /// 分区：界面
  String get settingsSectionUi;

  /// 界面卡的说明
  String get settingsUiNote;

  /// 即时生效
  String get instantApply;

  /// 明暗模式
  String get settingsThemeMode;

  /// 亮
  String get themeLight;

  /// 暗
  String get themeDark;

  /// 当前主题
  String get settingsCurrentTheme;

  /// 明暗模式的旁注
  String get settingsThemeNote;

  /// 关窗时收进托盘
  String get settingsCloseToTray;

  /// 关窗行为的旁注
  String get settingsCloseToTrayNote;

  /// 语言
  String get settingsLanguage;

  /// 跟随系统
  String get languageFollowSystem;

  /// 语言的旁注
  String get settingsLanguageNote;

  // ── 设置页：文案覆盖（i18n 覆盖层自己的界面话，2026-10-21 加）──────────
  //
  // 这一组是**覆盖层自己的提示文案**：它们走同一条覆盖链——用户可以用覆盖文件
  // 把这组话本身也改掉（见 `i18n/strings_override.dart` 的解析顺序）。
  // 三态（未使用 / 已加载 / 解析失败）与三条回执（导出成功、导出失败、打不开路径）
  // 各有其位；状态行的拼装固定在一处（`stringsOverrideStatusLine`），页面只负责摆颜色。

  /// 设置页「界面」卡：字段名「文案覆盖」
  String get settingsStringsOverride;

  /// 文案覆盖的旁注（改哪个文件、哪些句子改不了）
  String get settingsStringsOverrideNote;

  /// 「覆盖文件」这一行的标签
  String get stringsOverridePathLabel;

  /// 按钮：打开文案文件（所在目录）
  String get stringsOverrideOpen;

  /// 按钮：重新载入文案（不重启界面）
  String get stringsOverrideReload;

  /// 按钮：把当前语言的全部文案导出成模板
  String get stringsOverrideExport;

  /// 状态：没有覆盖，用的是默认文案
  String get stringsOverrideNone;

  /// 状态：已加载 N 条覆盖（zh a / en b）
  String stringsOverrideLoaded(int zh, int en);

  /// 状态：解析失败：<原因>
  String stringsOverrideFailed(String reason);

  /// 失败原因的一支：覆盖文件读不出来（detail 是系统给的那句话）
  String stringsOverrideUnreadable(String detail);

  /// 失败原因的一支：JSON 格式不对（detail 是 `FormatException` 的说明）
  String stringsOverrideBadJson(String detail);

  /// 失败原因的一支：JSON 顶层不是对象（既不是分语言段、也不是扁平键值）
  String get stringsOverrideBadRoot;

  /// 状态旁注：有 N 条键没被采用（不认识的键，或值不是字符串）
  String stringsOverrideIgnored(int count);

  /// 回执：模板已写到 <路径>
  String stringsOverrideExported(String path);

  /// 回执：模板写不出去：<原因>
  String stringsOverrideExportFailed(String reason);

  /// 回执：这个路径打不开：<路径>
  String stringsOverrideOpenFailed(String path);

  /// 分区一/二…的锚点小标题
  String get settingsAnchorCaption;

  /// 设置页左侧分区：模型
  String get settingsNavModel;

  /// 设置页左侧分区：界面
  String get settingsNavUi;

  /// 设置页左侧分区：发言
  String get settingsNavSpeak;

  /// 设置页左侧分区：外部依赖
  String get settingsNavDeps;

  /// 设置页左侧分区：协议端
  String get settingsNavProtocol;

  /// 设置页左侧分区：外部回调
  String get settingsNavWebhook;

  /// 设置页左侧分区：记忆
  String get settingsNavMemory;

  /// 设置页左侧分区：信任范围
  String get settingsNavTrust;

  /// 设置页左侧分区：系统
  String get settingsNavSystem;

  /// 设置页左侧分区：账号与安全
  String get settingsNavAccount;

  /// 设置页左侧分区：关于
  String get settingsNavAbout;
  // ── 运行情况页 ─────────────────────────────────────────────────────
  /// 当前状态、用量与待确认项
  String get overviewSubtitle;

  /// 建议（分区小标题）
  String get overviewSectionAdvice;

  /// 最近事件（分区小标题）
  String get overviewSectionRecent;

  /// 人格资产未初始化：IDENTITY.md 仍为模板，先补全身份与语气。
  String get overviewPersonaSeedAdvice;

  /// 现在没有待确认的调用
  String get overviewNoPendingCalls;

  /// 撤销这个定时器？
  String get overviewTimerCancelTitle;

  /// 撤销（定时器的按钮与确认框）
  String get overviewTimerCancel;

  /// 丢弃这条死信？
  String get overviewDeadDiscardTitle;

  /// 确认丢弃
  String get overviewDeadDiscardConfirm;

  /// 重投（死信）
  String get overviewDeadRequeue;

  /// 丢弃（死信）
  String get overviewDeadDiscard;

  /// 无法获取运行数据
  String get overviewLoadFailedTitle;

  /// 标记成功
  String get overviewMarkSucceeded;

  /// 标记失败
  String get overviewMarkFailed;

  /// 今日用量（磁贴标签）
  String get overviewTodayUsage;

  /// 缓存命中率
  String get overviewCacheHitRate;

  /// 待确认（磁贴标签）
  String get overviewPending;

  /// 连续失败
  String get overviewFailStreak;

  /// 建议卡上没有动作名时的兜底按钮
  String get overviewActFallback;

  /// 没读到死信明细，刷新一次再看看。
  String get overviewDeadLettersUnread;

  /// 未知会话（名字解析不出来时的兜底）
  String get overviewUnknownSession;

  /// 单聊（会话类型词）
  String get overviewChatTypeDirect;

  /// 群聊@（会话类型词）
  String get overviewChatTypeGroupAt;

  /// 群聊（会话类型词）
  String get overviewChatTypeGroup;

  /// 频道（会话类型词）
  String get overviewChatTypeGuild;

  /// 类型未知（会话类型词）
  String get overviewChatTypeUnknown;

  /// 外部会话（卡片标题）
  String get overviewExternalSessions;

  /// 经由消息适配器添加的会话。平台推给我们的消息存入信箱，由 Agent 自行查看。
  String get overviewExternalSessionsNote;

  /// 正在读外部会话…
  String get overviewExternalSessionsLoading;

  /// 状态与用量不受影响；读到数据后这张卡会自己出现。
  String get overviewExternalSessionsErrorHint;

  /// 没有积累的消息（信箱里是空的；群里没 @ 她的消息，要官方 Bot 先推给我们才进得来）。
  String get overviewNoAccumulatedMessages;

  /// 严重（等级词）
  String get overviewLevelCritical;

  /// 警告（等级词）
  String get overviewLevelWarn;

  /// 提示（等级词）
  String get overviewLevelInfo;

  /// 未知等级
  String get overviewLevelUnknown;

  /// 框架提示（卡片标题与兜底徽章）
  String get overviewFrameworkNote;

  /// 正在读框架提示…
  String get overviewFrameworkNotesLoading;

  /// 运行不受影响；注入预警与告警仍照常记录在事件日志里。
  String get overviewFrameworkNotesErrorHint;

  /// 没有需要你知道的事。
  String get overviewNoFrameworkNotes;

  /// 定时器（卡片标题）
  String get overviewTimers;

  /// 她自己布防的唤醒（timer 工具的 action=set）。到点会把她叫起来，撤销只对还没触发的那些有效。
  String get overviewTimersNote;

  /// 眼下没有排着的定时器。
  String get overviewNoTimers;

  /// 可能是它已经触发或已经被撤掉了；刷新一次看最新清单。
  String get overviewTimersErrorHint;

  /// 时刻未知（定时器读不出时间时）
  String get overviewTimerUnknownTime;

  /// 周期（定时器重复标记）
  String get overviewTimerRecurring;

  /// 还没有事件记录。
  String get overviewRecentEmpty;

  /// 立即唤醒（空态的按钮）
  String get overviewRecentEmptyAction;

  /// 唤醒或外部消息写入后，这里列出最近发生的事。
  String get overviewRecentEmptyHint;

  /// 规则判定（注入预警的判据来源）
  String get overviewJudgedByRule;

  /// 模型判定（注入预警的判据来源）
  String get overviewJudgedByModel;

  /// 返回的数据不是会话清单
  String get overviewSessionsNotList;

  /// 返回的数据不是提示清单
  String get overviewNotesNotList;

  /// 建议卡的一行：`标题：细节`
  String overviewAdviceLine(String title, String body);

  /// 一条死信的行首：`seq 42 · 认领 3 次 · 09-30 03:12`（[stamp] 为 null 时只到"次"）
  String overviewDeadLetterLine(int seq, int claimCount, String? stamp);

  /// `待确认 N 项`
  String overviewPendingCount(int count);

  /// `今日用量 <真数>`（磁贴的 tooltip）
  String overviewTodayUsageTooltip(String exact);

  /// 撤销定时器的确认框正文
  String overviewTimerCancelBody(String timerId);

  /// `已撤销定时器 <id>：到点不会再醒`
  String overviewTimerCancelled(String timerId);

  /// `撤销 <id> 失败：<原因>`
  String overviewTimerCancelFailed(String timerId, String reason);

  /// `撤销失败：<原因>`
  String overviewTimerCancelToastFailed(String reason);

  /// `标记失败：<原因>`
  String overviewMarkFailedToast(String reason);

  /// `已重投 seq <n>：它回到队列，下一拍重新认领`
  String overviewDeadRequeued(int seq);

  /// 丢弃死信的确认框正文
  String overviewDeadDiscardBody(int inputSeq);

  /// `已丢弃 seq <n>：它不会再被执行，日志里仍留着那条输入`
  String overviewDeadDiscarded(int seq);

  /// `<动作> seq <n> 失败：<原因>`（动作名由页面给：重投 / 丢弃）
  String overviewDeadActionFailed(String verb, int seq, String reason);

  /// `<动作>失败：<原因>`
  String overviewDeadActionToastFailed(String verb, String reason);

  /// 已恢复 · 历史（[label] 为空时只有后半句拼进来）
  String overviewHistoricalBadge(String label);

  /// 来源：框架自身（有指纹时缀在后面）
  String overviewSourceFramework(String? fingerprint);

  /// 来源：<会话或人>
  String overviewSourceChat(String who);

  /// 引用外部原话：`「…」`
  String overviewQuote(String text);

  /// `N 个群聊`
  String overviewGroupsCount(int count);

  /// `N 个单聊`
  String overviewSinglesCount(int count);

  /// `N 个其它`
  String overviewOthersCount(int count);

  /// `合计 N 条未读`
  String overviewUnreadTotal(int count);

  /// `来过 N 条`
  String overviewMessagesSeen(int count);

  /// `未读 N`
  String overviewUnreadBadge(int count);

  /// `N 个在等`
  String overviewTimersWaiting(int count);

  /// `周期 <cron>`
  String overviewTimerCron(String cron);

  /// `唤醒内容：<摘要>`
  String overviewTimerPayload(String payload);

  /// `外部会话读取失败：<原因>`
  String overviewExternalSessionsError(String reason);

  /// `框架提示读取失败：<原因>`
  String overviewFrameworkNotesError(String reason);
  /// 主循环（heavy）
  String get settingsLaneHeavyLabel;
  /// 轻量（light）
  String get settingsLaneLightLabel;
  /// turn 主循环使用的模型
  String get settingsLaneHeavyNote;
  /// 必要性判断、压缩摘要与守卫分类使用的模型
  String get settingsLaneLightNote;
  /// 框架托管
  String get settingsDepSourceManaged;
  /// 系统 PATH
  String get settingsDepSourceSystemPath;
  /// 版本未知
  String get settingsDepVersionUnknown;
  /// 路径未知
  String get settingsDepPathUnknown;
  /// 监听地址不能为空：空值等于监听所有网卡，未保存
  String get settingsSysHostEmptyError;
  /// $label不能为空，未保存
  String settingsSysEmptyError(String label);
  /// $label要填整数，未保存
  String settingsSysIntRequired(String label);
  /// $label要在 1~65535 之间，未保存
  String settingsSysPortRange(String label);
  /// $label最小是 1，未保存
  String settingsSysMinOne(String label);
  /// $label要填小数（0.8 表示 80%），未保存
  String settingsSysRatioRequired(String label);
  /// $label是比例，要落在 0~1 之间（不含 0），未保存
  String settingsSysRatioRange(String label);
  /// $label最小是 $lo，未保存
  String settingsSysMin(String label, int lo);
  /// $label最大是 $hi，未保存
  String settingsSysMax(String label, int hi);
  /// 监听地址
  String get settingsSysHostLabel;
  /// 本机用就填 127.0.0.1；端口 1~65535。留空等于监听所有网卡，会被拦下。
  String get settingsSysHostNote;
  /// 端口
  String get settingsSysPortLabel;
  /// 时区
  String get settingsSysTimezoneLabel;
  /// IANA 名称，例如 Asia/Shanghai。预算的「今日」按它切分。
  String get settingsSysTimezoneNote;
  /// 预算 · 步内工具调用上限
  String get settingsSysStepToolsLabel;
  /// 单个 step 里最多调几次工具。
  String get settingsSysStepToolsNote;
  /// 预算 · 单 turn 步数上限
  String get settingsSysTurnStepsLabel;
  /// 一个 turn 最多走多少步。
  String get settingsSysTurnStepsNote;
  /// 预算 · 任务 token 上限
  String get settingsSysTaskTokensLabel;
  /// 单个任务累计上限；填原值，20M 这类简写不接受。口径是非缓存 token（真花钱的那部分），不是账单上的用量。
  String get settingsSysTaskTokensNote;
  /// 预算 · 每日 token 上限
  String get settingsSysDailyTokensLabel;
  /// 每日累计上限，按上面的时区切分。口径同上一行：只数没命中缓存的那部分。
  String get settingsSysDailyTokensNote;
  /// 预算 · 软阈值
  String get settingsSysSoftRatioLabel;
  /// 0~1 的小数：0.8 就是 80%。到这一线先提示收尾，越过才硬停。
  String get settingsSysSoftRatioNote;
  /// 预算 · 连续失败上限
  String get settingsSysFailStreakLabel;
  /// 连续失败这么多次就告警并进入暂停。
  String get settingsSysFailStreakNote;
  /// 心跳间隔 · 平均（分钟）
  String get settingsSysHeartbeatLabel;
  /// 她平均多久自己醒一次——越大越省 token，越小越常醒。两端仍由上下限兜住：不因这个数改变，安静不足下限不会醒、到了上限必然会醒。
  String get settingsSysHeartbeatNote;
  /// 上下文 · 压缩线（token 估算）
  String get settingsSysCompactionLabel;
  /// 可见历史攒到这么多 token（估算）就折成一篇交接笔记，压缩只遮蔽、不删除。单位是估算器读数，不是供方计数（估算比供方偏低约 1.65~1.66 倍）。填原值：200000 这类写法不接受；调小 = 压得更勤，而每次压缩自己也要花一次调用…
  String get settingsSysCompactionNote;
  /// 她只能在配置里的工作目录（trust.workspaceRoot）中活动；越界的读写与命令会被拒绝。
  String get settingsTrustConsequenceWorkspaceUnknown;
  /// 她只能在 $root 里活动；越界的读写与命令会被拒绝。
  String settingsTrustConsequenceWorkspace(String root);
  /// 她能读写整台电脑上的文件、也能在任意目录跑命令。
  String get settingsTrustConsequenceFull;
  /// 只限工作目录
  String get settingsTrustLabelWorkspace;
  /// 完全信任
  String get settingsTrustLabelFull;
  /// 凭据状态读取失败（响应不是对象）
  String get settingsWebhookStateNotObject;
  /// 协议端状态读取失败（响应不是对象）
  String get settingsProtocolStateNotObject;
  /// 依赖报告读取失败
  String get settingsDepsReadFailed;
  /// 密钥状态读取失败
  String get settingsKeysReadFailed;
  /// 运行数据读取失败
  String get settingsProjectionReadFailed;
  /// 模型名不能为空，未保存
  String get settingsModelNameRequired;
  /// Base URL 不能为空，未保存
  String get settingsBaseUrlRequired;
  /// 没有需要保存的改动
  String get settingsNoChanges;
  /// 模型设置
  String get settingsWrittenModelSettings;
  /// 密钥
  String get settingsWrittenKey;
  /// ，进程重启后生效
  String get settingsRestartSuffix;
  /// 保存失败：$err
  String settingsSaveFailed(String err);
  /// 清除后需重新填写；来自环境变量的值不受影响。
  String get settingsClearKeyBody;
  /// 清除
  String get settingsClear;
  /// 已清除本地密钥
  String get settingsKeyCleared;
  /// 清除失败：$err
  String settingsClearFailed(String err);
  /// 模型密钥与系统信息需要生效配置才能显示。请确认主进程已启动。
  String get settingsConfigErrorHint;
  /// 配置不可用。
  String get settingsConfigUnavailable;
  /// 本地服务 /api/config 未返回配置内容。
  String get settingsConfigUnavailableHint;
  /// 密钥状态读取失败（$keysError）。密钥徽章不可用，模型名与 Base URL 仍可保存。
  String settingsKeysReadFailedHint(String keysError);
  /// 读不到 config.json，这一页显示的是当前生效的那份（保存仍会写进文件）。
  String get settingsConfigFallbackNote;
  /// 上面有改动还没生效：模型名与端点是启动参数，要重启进程才接管——在那之前跑的还是启动时那份。保存本身是成功的，框里显示的就是盘上那份。
  String get settingsModelRestartNote;
  /// 密钥只写不读：本页显示的始终是掩码，完整值仅在建立连接时读取一次。保存写入 config.json 与 data/.keys.json，进程重启后接管（环境变量优先于文件）。
  String get settingsKeysNote;
  /// 已配置；粘贴新密钥可覆盖
  String get settingsKeyConfiguredHint;
  /// sk-…
  String get settingsKeySampleHint;
  /// 模型名
  String get settingsModelName;
  /// API 根地址，不含 /responses。
  String get settingsBaseUrlNote;
  /// 环境变量 $envName 优先；它没有值时使用此处的值（写入 data/.keys.json，只写不读）。
  String settingsKeyEnvNote(String envName);
  /// 清除密钥
  String get settingsClearKey;
  /// 读取中…
  String get settingsReading;
  /// 状态读取失败
  String get settingsStateReadFailed;
  /// 未配置
  String get settingsNotConfigured;
  /// 她说话时的节奏：一条条往外蹦、每条之间隔多久。只影响投递手感，不影响说话内容。
  String get settingsSpeakNote;
  /// 打字节奏
  String get settingsSpeakTyping;
  /// 开着：按“这段话要打多久”逐条发出，像人在打字（对方也随时能插话打断）。关掉：一次发完，内容尽快到手。
  String get settingsSpeakTypingNote;
  /// 打字速度
  String get settingsSpeakSpeed;
  /// 字/分钟
  String get settingsSpeakSpeedUnit;
  /// 默认 90（中文手机输入的常见速度）。调大说得更快、等待更短；范围 30~600。
  String get settingsSpeakSpeedNote;
  /// 当前生效
  String get settingsCurrentlyActive;
  /// $saved 字/分钟 · 逐条发
  String settingsSpeakTypingOn(String saved);
  /// $saved 字/分钟 · 一次发完
  String settingsSpeakTypingOff(String saved);
  /// 已开启打字节奏（重启后接管）
  String get settingsSpeakTypingEnabled;
  /// 已关闭打字节奏（重启后接管）
  String get settingsSpeakTypingDisabled;
  /// 打字速度要在 30~600 之间
  String get settingsSpeakSpeedRange;
  /// 已保存（重启后接管）
  String get settingsSavedRestartNote;
  /// 已保存，立刻生效（不用重启）
  String get settingsSavedLive;
  /// 已保存，重启后生效
  String get settingsSavedRestart;
  /// 全部就绪
  String get settingsDepsAllReady;
  /// 建议安装的外部依赖，可由框架一键安装。
  String get settingsDepsNote;
  /// 依赖报告读取失败（$depsError）。装不了也看不见状态时，先在命令行确认主进程已启动。
  String settingsDepsReadFailedHint(String depsError);
  /// 正在探测本机的 pwsh / ripgrep / es.exe / python …
  String get settingsDepsProbing;
  /// 安装位置：<数据目录>/tools/<名字>/。装完立即生效——探测结论会在安装后复检并刷新，下一次工具调用用的就是新引擎。
  String get settingsDepsInstallLocation;
  /// 已就绪·托管
  String get settingsDepReadyManaged;
  /// 已就绪·系统
  String get settingsDepReadySystem;
  /// 版本不符
  String get settingsDepMismatch;
  /// 未安装
  String get settingsDepMissing;
  /// 无需操作
  String get settingsDepNoAction;
  /// 安装中…
  String get settingsDepInstalling;
  /// 安装
  String get settingsInstall;
  /// 下载页
  String get settingsDownloadPage;
  /// 打开下载页
  String get settingsOpenDownloadPage;
  /// 下载并安装
  String get settingsDownloadAndInstall;
  /// 安装请求失败：$err
  String settingsInstallRequestFailed(String err);
  /// 下载失败
  String get settingsStepDownloadFailed;
  /// 解压失败
  String get settingsStepExtractFailed;
  /// 装完复检没通过
  String get settingsStepVerifyFailed;
  /// 安装失败
  String get settingsStepInstallFailed;
  /// 已用默认程序打开 $url
  String settingsOpenedUrl(String url);
  /// 未知
  String get settingsUnknown;
  /// 需重启
  String get settingsRestartRequired;
  /// 协议端（可选）
  String get settingsProtocolTitle;
  /// 可选：由框架拉起的 OneBot 协议端，背后是一个真实 QQ 号。它与官方 Bot 各是一条独立的入站通道，装不装都不影响另一条。
  String get settingsProtocolNote;
  /// 协议端状态读取失败：$protocolError
  String settingsProtocolError(String protocolError);
  /// 这张卡读不到不影响其它设置。先确认主进程已启动，再点重试；在读到状态之前，这里不提供开关、目录与一键安装——那等于让你在看不到当前值的情况下写它。
  String get settingsProtocolErrorHint;
  /// 正在读取协议端状态…
  String get settingsProtocolLoading;
  /// 还没配置内置协议端。
  String get settingsProtocolEmpty;
  /// 不开也照常用：官方 Bot 那条通道不受影响。要用这条路，点下面的「一键安装」把装与配一次做完。
  String get settingsProtocolEmptyHint;
  /// 启用内置协议端
  String get settingsProtocolEnabled;
  /// 框架启动时自动连接；关闭后可在双端手动填写和配置。
  String get settingsProtocolEnabledNote;
  /// 安装目录
  String get settingsInstallDir;
  /// <协议端安装目录>
  String get settingsInstallDirHint;
  /// 保存目录
  String get settingsSaveDir;
  /// 协议端安装目录（绝对路径）。Lite 包解压后入口 index.mjs 就在这一层，没有 dist/ 子目录；「一键安装」会自动填好。
  String get settingsInstallDirNote;
  /// 一键安装
  String get settingsOneClickInstall;
  /// 从 SnowLuma 官方 Release 下载 Lite 包；自动下载失败时，自行下载并填写安装目录。此包不随框架分发，不得用于商业使用。
  String get settingsOneClickInstallNote;
  /// 使用前提：本机已登录 QQ 客户端（Bot 账号）。
  String get settingsOneClickPrerequisite;
  /// 正在从官方 Releases 下载并解压。要下 4.6 MB，视网速可能要一两分钟——先别急，也别再点一次。分步记录（下到哪一步、下多大）会在这一步结束时一次性列出来：这条端点是同步请求，不是流，中间插不进进度行。
  String get settingsInstallRunningNote;
  /// 手动出路：从 $protocolDownloadUrl 下载发行包，解压后把那个目录填到下面的「安装目录」，再点「保存目录」、打开开关——效果与一键安装一样，只是这几步由你做。
  String settingsInstallManualRoute(String protocolDownloadUrl);
  /// 过程记录：（这次没有——失败发生在动手之前）
  String get settingsInstallLogEmpty;
  /// 过程记录：
  String get settingsInstallLog;
  /// 已经装好了。下一步：先重启服务，再扫码。
  String get settingsInstalledNextTitle;
  /// ① 重启服务：运行中的协议端实例是按启动时的配置建的，重启之后它才会按刚写好的配置被拉起（框架不替你重启——重启自己失败就什么都不剩了）。\n② 再扫码：重启后这张卡上会出现「打开面板」，点开在那边先读并同意用户协议与隐私政策（那是法律性质…
  String get settingsInstalledNextBody;
  /// （还没填安装目录）
  String get settingsInstallDirEmpty;
  /// 已找到可执行入口
  String get settingsEntryFound;
  /// 目录里没有可执行入口
  String get settingsEntryMissing;
  /// 入口要重启后才核对
  String get settingsEntryPendingRestart;
  /// 对接点：$wsUrl
  String settingsEndpointPoint(String wsUrl);
  /// 启动
  String get settingsStart;
  /// 停止
  String get settingsStop;
  /// 打开面板
  String get settingsOpenPanel;
  /// 本次进程启动时还没读到这段配置：框架现在不持有它的实例，「启动/停止」要等重启进程之后才有效。
  String get settingsProtocolNotAttachedNote;
  /// ① 进程
  String get settingsChainProcess;
  /// 未观测
  String get settingsChainUnobserved;
  /// 本进程没有实例，这一档没人在看
  String get settingsChainNoInstance;
  /// 没在跑
  String get settingsChainNotRunning;
  /// 没有监听到它的面板端口
  String get settingsChainNoPort;
  /// 本次进程拉起
  String get settingsChainSpawned;
  /// 本次进程之前就在跑
  String get settingsChainDiscovered;
  /// 只探到端口
  String get settingsChainPortOnly;
  /// 在跑
  String get settingsChainRunning;
  /// 监听 $url
  String settingsChainListening(String url);
  /// ② OneBot 配置
  String get settingsChainOneBotConfig;
  /// 带 token
  String get settingsChainWithToken;
  /// 无 token（协议端未开校验）
  String get settingsChainNoToken;
  /// 在
  String get settingsChainPresent;
  /// 端点 $ws
  String settingsChainEndpoint(String ws);
  /// 读不出
  String get settingsChainUnreadable;
  /// 缺失
  String get settingsChainMissing;
  /// 未登录 QQ：这一份是登录之后才生成的
  String get settingsChainMissingDetail;
  /// ③ 适配器
  String get settingsChainAdapter;
  /// 已连上
  String get settingsChainConnected;
  /// 已收 $delivered 条
  String settingsChainDelivered(String delivered);
  /// 重连中
  String get settingsChainReconnecting;
  /// 第 $attempts 次退避
  String settingsChainBackoff(String attempts);
  /// 没端点可连
  String get settingsChainNoEndpoint;
  /// 协议端的 OneBot 配置还没出现，配置里也没有手填地址
  String get settingsChainNoEndpointDetail;
  /// 未启用
  String get settingsChainDisabled;
  /// 未装配
  String get settingsChainNotAssembled;
  /// 本进程没有 OneBot 适配器
  String get settingsChainNotAssembledDetail;
  /// 这一档没有数据
  String get settingsChainNoData;
  /// 初始凭据（本次启动从它的输出里捕到，用户 $user / 口令 $masked）
  String settingsCredentialCaptured(String user, String masked);
  /// 初始凭据（从框架自己的启动留痕里捞回来的：用户 $user / 口令 $masked；若它之后又重启过，这条就作废了）
  String settingsCredentialFromLog(String user, String masked);
  /// 初始凭据找不回来：它只在启动时往自己的输出里打一次（关掉程序就没了）。要拿到一条可用的，就让框架重启它一次（那一次的输出会被捕获并显示在这里）。
  String get settingsCredentialLost;
  /// 协议与隐私政策还没同意——面板解锁之前，接入 QQ 的入口是锁着的。
  String get settingsConsentPending;
  /// 初始口令还没改：两个门里第一个就是改密，面板会一直要求你先改它。
  String get settingsPasswordUnchanged;
  /// 扫码登录在 $webuiUrl 里做（框架不代管 QQ 登录态）。
  String settingsQrLoginAt(String webuiUrl);
  /// 凭据已复制（用户 + 口令）
  String get settingsCredentialCopied;
  /// 复制凭据
  String get settingsCopyCredential;
  /// 也可以自己来：从 $protocolDownloadUrl 下载发行包解压，把那个目录填在上面。这条路在一键安装失败、或者你想自己控制版本时用；框架也从同一个地址代下载，不随框架分发它（许可是"源码可见非商业"，自用没问题）。
  String settingsManualDownloadGuide(String protocolDownloadUrl);
  /// 改动已写入 config.json，但要重启进程才接管：运行中的协议端实例是按启动时那份配置建的。重启之前，这里显示的状态仍是本次启动的那一个。
  String get settingsProtocolRestartNote;
  /// 安装目录不能为空
  String get settingsInstallDirRequired;
  /// 已请求启动
  String get settingsStartRequested;
  /// 已请求停止
  String get settingsStopRequested;
  /// 安装请求失败：$err（请求没走到安装那一步，先确认主进程在跑）
  String settingsInstallRequestFailedHint(String err);
  /// 一键安装失败：原因见卡片
  String get settingsOneClickFailed;
  /// 安装失败，服务端没有给出原因（回执里没有 detail）
  String get settingsInstallNoReason;
  /// 已装好
  String get settingsInstalledOk;
  /// 已装好并用它配好了；重启一下就能用
  String get settingsInstalledConfigured;
  /// 已装好，但自动配置没写成：见卡片里的说明
  String get settingsInstalledNotConfigured;
  /// （重启进程后接管）
  String get settingsRestartSuffixParen;
  /// 已生成
  String get settingsGenerated;
  /// 还没有生成
  String get settingsNotGenerated;
  /// 外部系统往这台实例投递用的专用凭据（POST /webhook/*）。
  String get settingsWebhookNote;
  /// 凭据状态读取失败（$webhookError）。状态看不见时先别按"重新生成"：轮换不可逆（旧的那份当场失效），而此刻你并不知道有没有人在用它。
  String settingsWebhookErrorHint(String webhookError);
  /// 正在读取 webhook 凭据状态…
  String get settingsWebhookLoading;
  /// 当前凭据
  String get settingsWebhookCurrent;
  /// 凭据 $secretId · 生成于 $createdAt
  String settingsWebhookCurrentValue(String secretId, String createdAt);
  /// 这条通道现在一律 401（没有凭据就没人投得进来）。按下面的按钮生成一份。
  String get settingsWebhookNotConfiguredNote;
  /// 上次轮换
  String get settingsWebhookRotated;
  /// 从未
  String get settingsWebhookNever;
  /// 发起方：$by
  String settingsWebhookBy(String by);
  /// 重新生成
  String get settingsRegenerate;
  /// 生成 webhook 凭据
  String get settingsGenerateWebhook;
  /// /webhook/* 不认界面凭据（也不认迁移期那份 data/.ui-token）：这条通道只认上面那份专用凭据。它是给外部系统的——投得进来，读不到 /api/* 上的任何东西。
  String get settingsWebhookCredentialNote;
  /// 重新生成 webhook 凭据
  String get settingsRegenerateTitle;
  /// 上一份会当场失效：已经在用它的外部脚本会立刻开始收 401——记得把新凭据一起换过去。新凭据只显示一次。
  String get settingsRegenerateBody;
  /// 服务端没有回凭据原文，请再按一次；若反复如此，去看主进程日志
  String get settingsNoTokenReturned;
  /// 上一份已当场失效（还在用它的外部脚本会开始收 401）。
  String get settingsWebhookRotatedNote;
  /// 生成失败：$err
  String settingsGenerateFailed(String err);
  /// 长期记忆（MEMORIES/ 与 diary/）由谁维护：框架替你管，还是她自己读、自己写、自己整理。
  String get settingsMemoryNote;
  /// 尚未生效
  String get settingsNotInEffect;
  /// 让框架自动管记忆（关掉 = 她只知道自己有这些文件，读、写、整理全归她）
  String get settingsMemoryEnableLabel;
  /// 开着：框架生成并维护 MEMORIES/INDEX.md，每轮把索引注入固定块，并每日整理一次。
  String get settingsMemoryEnableNote;
  /// 框架自动管记忆（每轮注入索引、每日整理）
  String get settingsMemoryOn;
  /// 她自己管（框架不生成、不注入、不整理）
  String get settingsMemoryOff;
  /// 不受这个开关影响的两条路：MEMORIES/aliases.md 参与「会话认人 / 关注名单」属于通道侧；STATE.md（她当前状态）是独立的一层。
  String get settingsMemoryUnaffectedNote;
  /// 这一项是进程启动时读的：保存写进 config.json，重启后接管。关掉不会删任何文件。
  String get settingsMemoryRestartNote;
  /// 关掉之后框架不生成、不注入、不整理，但她照旧能自己读写那些文件。为什么留这个开关：给只想让 agent 自己管记忆的人一条干净的路。每日整理的时间点由 wake.memoryMaintainCron 定（默认每日一次）：过期的流水账并进 f…
  String get settingsMemoryDetail;
  /// 代价：她可能忘记整理，facts.md 会一直长下去，索引也不再更新——这些都归她自己。
  String get settingsMemoryCost;
  /// 已改为框架自动管记忆（重启后接管）
  String get settingsMemoryOnSaved;
  /// 已改为她自己管记忆（重启后接管）
  String get settingsMemoryOffSaved;
  /// 她的活动边界：整台电脑，或只有一个工作目录。越界就是拒绝，不是提醒。
  String get settingsTrustNote;
  /// 她能碰到多远
  String get settingsTrustReachLabel;
  /// 两档各自管什么写在选项里，改哪一档就按哪一档的后果算。
  String get settingsTrustReachNote;
  /// 只限工作目录（路径未读到）
  String get settingsTrustWorkspaceUnknownPath;
  /// 只限工作目录 · $root
  String settingsTrustWorkspaceValue(String root);
  /// 完全信任（整台电脑）
  String get settingsTrustFullValue;
  /// 上面选的那一档还没生效：盘上已经写下了，但正跑着的这个进程用的仍是启动时读到的那份——重启后接管。在那之前，她照旧按当前生效的那一档活动。
  String get settingsTrustPendingNote;
  /// 工作目录由服务端算出来（默认 <配置目录>/workspace），界面上不手填：同一条边界写两个值，就一定会出现"配置说 A、实际拦在 B"。
  String get settingsTrustRootNote;
  /// 它是边界，不是提醒：越界的读写与命令一律被拒绝。
  String get settingsTrustBoundaryNote;
  /// 它管 fs 工具族（safe_read / safe_write / safe_edit / rg_search 等）与 pwsh：前者经同一条路径判定，后者的 workdir 与命令行里的路径一起受管。它与 destructive 开关、…
  String get settingsTrustRulesDetail;
  /// 改成完全信任
  String get settingsTrustFullTitle;
  /// 这是一条边界，撤掉它她是真的能做到上面这些事。确定吗？
  String get settingsTrustFullConfirmTail;
  /// 已改为只限工作目录；越界的读写与命令会被拒绝（重启进程后接管）
  String get settingsTrustWorkspaceSaved;
  /// 已改为完全信任（重启进程后接管）
  String get settingsTrustFullSaved;
  /// 监听地址、时区、六条预算与心跳都是这个进程的启动参数：在这里改，保存写进 config.json，重启后生效。压缩线那一行例外——它写完立刻生效（服务端在同一个临界区里也改了内存那份）。
  String get settingsSystemNote;
  /// 数据目录
  String get settingsDataDir;
  /// 启动时定下的路径：事件日志、人格资产与密钥都在它下面，换它等于让下一个进程从空目录开始。
  String get settingsDataDirNote;
  /// 数据目录在这里改不了（它决定她的全部身家落在哪，且进程启动时就定下了）；其余字段保存后重启进程生效——压缩线那一行除外，它保存完就当拍接管。
  String get settingsSystemFootnote;
  /// 立刻生效
  String get settingsLiveNow;
  /// 编辑
  String get settingsEdit;
  /// 进来这个界面用的凭据：改密码与登出。
  String get settingsAccountNote;
  /// 旧的共享 token
  String get settingsAccountLegacyBadge;
  /// 会话凭据
  String get settingsAccountSessionBadge;
  /// 当前实例
  String get settingsAccountInstance;
  /// 凭据按实例分文件存（%APPDATA%\\Irmia\\sessions）：同一台机器上开第二个实例不会把这一份顶掉。
  String get settingsAccountInstanceNote;
  /// 这一份用的是旧的共享 token（这台实例还没设过密码），服务端不认它开出的"会话"：改密码与登出都做不成。先设置一个密码，之后按会话登录/登出。
  String get settingsAccountLegacyNote;
  /// 改密码
  String get settingsChangePassword;
  /// 登出
  String get settingsLogout;
  /// 先去设置密码
  String get settingsSetPasswordFirst;
  /// 密码已改；这台界面已经换上新凭据
  String get settingsPasswordChanged;
  /// 退出这个界面并回到门上；本机这份会话凭据会被清掉——下次要用密码进来。
  String get settingsLogoutBody;
  /// 界面版本与运行期投影数据。
  String get settingsAboutNote;
  /// Flutter 原生界面
  String get settingsAboutBadge;
  /// 版本
  String get settingsVersionLabel;
  /// 守护天数
  String get settingsGuardedDays;
  /// 事件水位
  String get settingsWatermark;
  /// 运行数据读取失败（$projError），守护天数与事件水位不可用。
  String settingsProjectionReadFailedHint(String projError);
  /// 守护天数与事件水位取自运行期投影（GET /api/projection），为实测值。
  String get settingsProjectionFootnote;
  /// $days 天
  String settingsDaysCount(String days);
  /// $days 天（自 $stamp）
  String settingsDaysSince(String days, String stamp);
  /// destructive 工具策略
  String get settingsDestructivePolicy;
  /// 修改
  String get settingsModify;
  /// 全关（一件都不给她看）
  String get settingsPolicyNoneOption;
  /// 全开（清单里全给）
  String get settingsPolicyAllOption;
  /// 按名单（只给勾中的那几件）
  String get settingsPolicyListOption;
  /// 按名单开放
  String get settingsPolicyListTitle;
  /// 没拿到工具清单（注册表可能还没起来）——先去「扩展 · 工具」看一眼再回来。
  String get settingsPolicyNoTools;
  /// 修改 destructive 工具策略
  String get settingsDestructiveTitle;
  /// 这会让她能看到并调用会改动本机的工具（写文件、跑命令等）。确定吗？
  String get settingsDestructiveRelaxedBody;
  /// 改回受限档：她将看不到 destructive 工具（更安全）。确定吗？
  String get settingsDestructiveRestrictedBody;
  /// 全开
  String get settingsPolicyAll;
  /// 按名单（空）
  String get settingsPolicyListEmpty;
  /// 全关
  String get settingsPolicyNone;
  // ── 设置页：手写的那几条（拼接 / 插值表达式 / 语序）──────────────
  /// 列表连接词（`written.join('与')`）：中文用「与」，英文用 " and "
  String get settingsListAnd;

  /// `已保存 <写入了什么><重启后缀>`
  String settingsSaved(String written, String restart);

  /// `清除密钥 · <哪条 lane>`
  String settingsClearKeyTitle(String laneLabel);

  /// `已配置 <掩码>`
  String settingsKeyConfiguredMask(String mask);

  /// pip 不可用那一行（[reason] 为 null 时不带括号）
  String settingsDepPipUnavailable(String? reason);

  /// 一键安装依赖前的确认框正文
  String settingsInstallConfirmBody(String managedDir);

  /// `<依赖名> 已就绪（<版本>）`
  String settingsDepReadyToast(String label, String version);

  /// `<阶段>：<原因>`
  String settingsStepErrorToast(String step, String error);

  /// `这一项没有下载页；装法：<提示>`
  String settingsNoDownloadPage(String hint);

  /// `打不开浏览器，地址是 <url>（<提示>）`
  String settingsOpenUrlFailed(String url, String? hint);

  /// `已装好 <版本>`
  String settingsInstalledVersion(String? version);

  /// 「装好了但自动配置没写成」那张说明
  String settingsWriteErrorNote(String writeError);

  /// `<时刻> 起`（协议端进程那一档的证据）
  String settingsChainSince(String when);

  /// `那份文件在（<路径>）但端点解析失败——要人去修它`
  String settingsChainUnreadableDetail(String path);

  /// 内置协议端开关的回执（开着 / 关掉 + 重启后缀）
  String settingsProtocolToggled(bool on, bool restart);

  /// `已保存安装目录：<路径><重启后缀>`
  String settingsInstallDirSaved(String saved, bool restart);

  /// `<启动|停止>请求失败：<原因>`
  String settingsProtocolActionFailed(bool start, String err);

  /// webhook 凭据文件那一行
  String settingsWebhookFileNote(String file);

  /// `改成完全信任之后：<后果>`
  String settingsTrustFullBody(String consequence);

  /// `按名单（N 项）`
  String settingsPolicyListCount(int count);

  /// 未知原因（服务端没给 error 时的兜底）
  String get settingsUnknownReason;

  /// 见官方文档（没有 manualHint 时的兜底）
  String get settingsSeeOfficialDocs;

  /// curl 例子里的凭据占位符
  String get settingsWebhookCurlTokenPlaceholder;

  /// curl 例子里的示例正文
  String get settingsWebhookCurlSampleText;

  /// `建议安装 N 项`
  String settingsDepsSuggested(int count);

  /// `pip <版本>（她可以自己 pip install 扩能力）`
  String settingsDepPipReady(String version);

  /// `<它是干什么的>。<没有它会怎样>`
  String settingsDepPurposeImpact(String purpose, String impact);

  /// `安装 <依赖名>`
  String settingsInstallTitle(String label);

  /// `保存（N 件）`
  String settingsPolicySave(int count);
  /// `已装好 <版本>，并用它配好了；重启一下就能用。` / `…，但自动配置那一步没成。`（失败时是「安装失败」）
  String settingsInstallHead(bool ok, String? version, bool configured);

}

/// 中文（**作者语言**，也是所有既有测试断言的基准）。
///
/// ⚠ 改这里等于改界面：每一条都要与迁移前的字面量**逐字相同**，否则那一页的
/// widget 测试会红（它们断的是屏幕上的中文）。
class ZhStrings extends AppStrings {
  const ZhStrings();

  @override
  AppLanguage get language => AppLanguage.zh;

  @override
  String get retry => '重试';
  @override
  String get cancel => '取消';
  @override
  String get confirm => '确认';
  @override
  String get save => '保存';
  @override
  String get loading => '正在加载…';
  @override
  String get error => '出错了';
  @override
  String get empty => '没有内容';
  @override
  String get collapse => '收起';
  @override
  String expandAll(int chars) => '展开全部（$chars 字）';
  @override
  String loadFailed(String reason) => '加载失败：$reason';
  @override
  String get settingsLoadingConfig => '正在读取配置…';
  @override
  String configReadFailed(String reason) => '配置读取失败：$reason';

  @override
  String get navChat => '聊天';
  @override
  String get navSettings => '设置';
  @override
  String get navOverview => '运行情况';
  @override
  String get navChannels => '通道';
  @override
  String get navExtensions => '扩展';
  @override
  String get navPersona => '人格';
  @override
  String get navSchedule => '日程';
  @override
  String get navMemory => '记忆';
  @override
  String get navLogs => '日志';
  @override
  String get navMore => '更多';

  // ── 运行情况 / 重启 / 托盘 ──
  @override
  String get overviewConfigGuide => '配置引导';
  @override
  String restartConfirmed(String evidence) => '重启已确认：$evidence';
  @override
  String restartEvidence(int backendPid, bool portReady) {
    final parts = <String>[
      if (backendPid > 0) '真实新 pid $backendPid',
      if (portReady) '端口已就绪',
    ];
    return parts.isEmpty ? '服务端没给凭据（pid 与端口都没读到）' : parts.join(' · ');
  }

  @override
  String get restartSentWithGui =>
      '重启已发出：界面与后端都会重启——界面会先关掉，请等它自己回来（本机约 1~2 分钟）';
  @override
  String get restartSentBackendOnly =>
      '重启已发出：后端断开后约 20~90 秒回来（界面不在本次动作范围内，它只是重连）';
  @override
  String restartFailed(String reason) => '重启失败：$reason';
  @override
  String restartRefused(String reason) => '重启没能发出：$reason';
  @override
  String get restartNoConclusion => '重启已发出，但服务端没有给出结论';
  @override
  String get restartBackReady => '已就绪：后端回来了';
  @override
  String restartBackTimeout(int seconds) =>
      '后端还没回来（等了 $seconds 秒）：看一眼 data/restart-trace.log';
  @override
  String get restartNeverWentDown => '后端没有断开过：这次请求可能没生效';

  @override
  String get trayShow => '显示界面';
  @override
  String get trayHide => '收进托盘';
  @override
  String get trayRestart => '重启前后端';
  @override
  String get trayQuitUi => '退出界面（她继续在后台运行）';
  @override
  String get trayQuitAll => '退出全部（界面 + 后端）';
  @override
  String get quitAllConfirmTitle => '退出全部？';
  @override
  String quitAllConfirmBody(bool busy) =>
      '会把后端一起结束（连同它拉起的协议端），然后关掉这个界面。\n'
      '${busy ? '她现在正跑着一轮：这一轮会被打断，下次启动按恢复流程结算。\n' : ''}'
      'Windows 上没有能从外部送达的优雅停机，所以这是硬杀：'
      '协议端的登录态可能要你在 WebUI 里重登一次。\n'
      '只想关界面（她继续在后台跑）请用托盘里的「退出界面」。';
  @override
  String get quitAllConfirmLabel => '退出全部';
  @override
  String get quitAllWorking => '正在结束后端…';
  @override
  String quitAllFailed(String reason) => '后端没停下来：$reason（界面没关，免得你以为已经全退了）';
  @override
  String get quitAllDone => '已退出全部：界面与后端都结束了';

  @override
  String get onboardingManualSaved => '引导走完了，改过的那几步已经写进去';
  @override
  String get onboardingManualNoChanges => '这次只是打开看了看：什么都没改，也没写任何东西';

  // ── 首次引导（六步卡） ──
  //
  // 第 1、4、5 步的那几段说明在**第 3 轮**（2026-10-20）全部压成**一行**：
  // 一行里说清最关键的因果，但写哪儿、什么时候生效、"别删什么"一句都不许丢。
  // 字数的上界由 `test/onboarding_copy_one_line_test.dart` 钉着，`\n` 也由它拦。
  @override
  String get onboardingStepNameTitle => '她叫什么';
  @override
  String get onboardingStepNameNote =>
      '名字是她的身份，下面那份词表决定群里喊哪些词算在叫她（不打 @ 也算）。';
  @override
  String get onboardingStepNameHint =>
      '写进 persona/IDENTITY.md 的「名字：」那一行（旧版本有快照，人格配置页能回滚），界面上的称呼就是它。';
  @override
  String get onboardingKeywordsHint =>
      '逗号或顿号隔开，正文里出现就算在叫她（同平台的 @）；填了名字会自动跟一份，清空 = 只认 @。';
  @override
  String get onboardingStepApiTitle => 'API 配置';
  @override
  String get onboardingStepApiNote => '她用的是哪家模型。写进 config.json 与 data/.keys.json，进程重启后接管。';
  @override
  String get onboardingStepChannelTitle => '消息适配器';
  @override
  String get onboardingStepChannelNote => '她从哪个通道收消息。QQ 官方 Bot 的 AppID 与 AppSecret 就填在下面。';
  @override
  String get onboardingStepPersonaTitle => '人格';
  @override
  String get onboardingStepPersonaNote => '她是谁。这一段写进 persona/IDENTITY.md，是她的常驻人格。';
  @override
  String get onboardingStepTrustTitle => '信任范围';
  @override
  String get onboardingStepTrustNote => '她能碰到多远：整台电脑，还是只有一个工作目录。二选一，默认完全信任。';
  @override
  String get onboardingApiRecommendLead => '我们推荐您使用 ';
  @override
  String get onboardingApiRecommendModel => 'DeepSeek 的模型';
  @override
  String get onboardingApiRecommendJoin => '，';
  @override
  String get onboardingApiRegisterKey => '点击注册账号并获取 API Key';
  @override
  String get onboardingChannelRecommendLead => '我们推荐您使用 ';
  @override
  String get onboardingChannelRecommendQq => 'QQ 官方 Bot';
  @override
  String get onboardingChannelRecommendTail => ' 作为消息适配器';
  @override
  String get onboardingQqTileDetail => '官方开放平台那条通道；AppID 与 AppSecret 就填在下面（只写不读）。';
  @override
  String get onboardingQqCredentialsTitle => 'QQ 官方 Bot 凭据（存在本机 data/.keys.json，不进 config.json）';
  @override
  String get onboardingQqAppIdLabel => 'AppID';
  @override
  String get onboardingQqAppIdHint => '开放平台管理端的机器人 ID。';
  @override
  String get onboardingQqAppSecretLabel => 'AppSecret';
  @override
  String get onboardingQqAppSecretHint => '换取 access_token 的密钥。';
  @override
  String onboardingSecretConfigured(String? mask) =>
      mask == null || mask.isEmpty ? '已配置；粘贴新值可覆盖' : '已配置（$mask）；粘贴新值可覆盖';
  @override
  String get onboardingQqCredentialsNote => '填完两个凭据会自动勾上 QQ 官方 Bot；也可以先跳过，之后在「消息适配器」页里补。';
  @override
  String get onboardingPersonaHint =>
      '写上去 = 替换整份文件（服务端留快照，人格配置页能回滚）；开头「名字：」那行别删，留空或没改动就不写。';
  @override
  String get onboardingTrustNoteSame =>
      '这是边界不是提醒：越界的读写与命令会被拒（fs 与 pwsh 都管），与盘上一致、这屏不写盘；之后在设置页「信任范围」里能改。';
  @override
  String get onboardingTrustNoteChanged =>
      '这是边界不是提醒：越界的读写与命令会被拒（fs 与 pwsh 都管），点「完成」写进 config.json、重启后接管；之后在设置页「信任范围」里能改。';
  @override
  String get onboardingStepDepsTitle => '外部依赖';
  @override
  String get onboardingStepDepsNote =>
      '不装的话有些工具用不了：pwsh 的工具、rg 的 grep、es 的 find、python 那条 lane。';
  @override
  String get onboardingDepsInstallLabel => '下载并安装这些外部依赖';
  @override
  String get onboardingDepsAllReady => '四件依赖都已就位，直接点「完成」即可。';
  @override
  String get onboardingDepsStatusReady => '就位';
  @override
  String get onboardingDepsStatusMissing => '未就位';
  @override
  String get onboardingDepsItemRunning => '进行中…';
  @override
  String get onboardingDepsItemOk => '成功';
  @override
  String onboardingDepsItemFailed(String reason) => '失败：$reason';
  @override
  String onboardingDepsSummary(int ok, int failed) => '成功 $ok / 失败 $failed';
  @override
  String get onboardingDepsRetry => '重试';
  @override
  String onboardingDepsLastRun(int ok, int failed) => '上次装完：成功 $ok / 失败 $failed';
  @override
  String onboardingDepsReadFailed(String reason) => '读不到依赖状态：$reason';
  @override
  String get onboardingDepsUnavailable => '这台服务端没装配依赖管理器，装不了，直接点「完成」即可。';
  @override
  String get onboardingRestartTitle => '需要重启';
  @override
  String get onboardingRestartBody => '依赖装完了，要重启界面才会生效。';
  @override
  String get onboardingRestartNow => '立即重启';
  @override
  String get onboardingRestartLater => '稍后';
  @override
  String onboardingOpenLinkFailed(String url) => '打不开浏览器，地址是 $url';
  @override
  String onboardingChannelSaveFailed(String reason) => '通道开关没写进去：$reason';
  @override
  String onboardingSecretsSaveFailed(String reason) => 'AppID / AppSecret 没写进去：$reason';

  @override
  String get chatTitle => '聊天';
  @override
  String get chatSubtitle => '会话、消息来源与人工唤醒';
  @override
  String get composerHint => '输入消息…（/reset 清空上下文、/dream 叫她整理记忆）';
  @override
  String get jumpToLatest => '跳到最新';
  @override
  String get jumpToLatestNew => '有新内容 · 跳到最新';
  @override
  String get earlierFailed => '更早的记录读取失败，向上滚动重试';
  @override
  String get noEarlier => '没有更早的记录了';
  @override
  String get historyErrorTitle => '会话记录读取失败';
  @override
  String get historyErrorMessage => '没能从主进程取到会话记录。';
  @override
  String get chatEmptyTitle => '会话尚未开始';
  @override
  String get chatEmptyMessage => '还没有会话记录。';
  @override
  String get chatEmptyAction => '输入消息';
  @override
  String get chatEmptyHint => '在下方输入框发送内容后，会话与来源显示在此。';
  @override
  String get tagFrameworkNotice => '框架通报';
  @override
  String get tagFrameworkReminder => '框架提醒';
  @override
  String get tagInjection => '注入预警';
  @override
  String get tagContextBoundary => '上下文分界';
  @override
  String get injectionCardTitle => '外部消息里有想指挥她的迹象';
  @override
  String get unnamedSender => '未命名会话';
  @override
  String receivedFrom(String sender, String id) => '已接收：$sender（$id）';
  @override
  String get dash => '—';
  @override
  String mentionsYou(String where) => '$where 里有人提到了你';
  @override
  String talkingAbout(String what) => '那边在聊：$what';
  @override
  String get directMessage => '单聊消息';
  @override
  String get groupMention => '群聊提及';
  @override
  String get groupMessage => '群聊消息';
  @override
  String get chatTypeDirect => '单聊';
  @override
  String get chatTypeGroup => '群聊';
  @override
  String get qqOfficialBot => 'QQ 官方 Bot';
  @override
  String get externalChannel => '外部通道';
  @override
  String get qqMessage => 'QQ 消息';
  @override
  String get oneBotMessage => 'OneBot 消息';
  @override
  String get externalMessage => '外部消息';
  @override
  String get byModel => '模型判定';
  @override
  String get byRule => '规则命中';
  @override
  String fromWho(String who) => '来自 $who';
  @override
  String get manualWake => '手动唤醒';
  @override
  String get intentWake => '意图唤醒';
  @override
  String get schedulerFire => '定时任务触发';
  @override
  String scheduledAt(String at) => '原定 $at';
  @override
  String get backgroundProgress => '后台任务进展';
  @override
  String get eventDream => '做梦';
  @override
  String get eventMcpDeclChanged => 'MCP 声明变更';
  @override
  String get contextClearedHere => '上下文在此处清空';
  @override
  String get contextCompactedHere => '上下文在此处压缩';
  @override
  String get contextClearedHereDetail => '到此为止的往来不再计入她的上下文';
  @override
  String get contextCompactedHereDetail => '到此为止的往来被交接笔记替代，不再逐条计入';
  @override
  String get humanReplyRecorded => '人工答复已记录';
  @override
  String get markedOk => '已标记成功';
  @override
  String get markedFailed => '已标记失败';
  @override
  String get toolRunning => '运行中';
  @override
  String get toolExecuting => '正在执行…';
  @override
  String get toolDone => '完成';
  @override
  String get toolError => '出错';
  @override
  String get toolTimeout => '超时（结果未知）';
  @override
  String get toolDenied => '被策略拒绝';
  @override
  String get toolUnknown => '结局未知';
  @override
  String get toolNotDispatched => '未派发';
  @override
  String get toolOverStepCap => '超出单步上限';
  @override
  String get thinkingLabel => '思考中';
  @override
  String thinkingStep(String step) => '第 $step 步';
  @override
  String thinkingChars(String chars) => '已想 $chars 字';
  @override
  String thinkingElapsed(String elapsed) => '用时 $elapsed';
  @override
  String get thinkingGap => '　';
  @override
  String compactChars(int chars) {
    if (chars < 10000) return '$chars';
    final wan = chars / 10000;
    // `100.0 万字` 这种写法很别扭：到 100 万就只留整数位（原 formatThinkingChars 的口径）
    if (wan >= 100) return '${wan.round()} 万字';
    return '${wan.toStringAsFixed(1)} 万字';
  }
  @override
  String get toastContextCleared => '上下文已清空，后面的对话从零开始';
  @override
  String toastClearFailed(String reason) => '清空失败：$reason';
  @override
  String get toastDream => '叫她去做梦了——整理完会写进记忆，日志页能看到';
  @override
  String toastTriggerFailed(String reason) => '触发失败：$reason';
  @override
  String get toastDuplicateSend => '这句和刚发过的完全一样，被当成同一条忽略了——过几秒再发一次就行';
  @override
  String toastSendFailed(String reason) => '发送失败：$reason';

  @override
  String get settingsTitle => '设置';
  @override
  String get settingsSubtitle => '运行情况、通道、人格与本地参数';
  @override
  String get settingsSectionUi => '界面';
  @override
  String get settingsUiNote => '主题偏好与关窗行为；仅本地生效，不写入配置。';
  @override
  String get instantApply => '即时生效';
  @override
  String get settingsThemeMode => '明暗模式';
  @override
  String get themeLight => '亮';
  @override
  String get themeDark => '暗';
  @override
  String get settingsCurrentTheme => '当前主题';
  @override
  String get settingsThemeNote => '仅本地偏好，即时生效；不写入配置、不影响渲染指纹。';
  @override
  String get settingsCloseToTray => '关窗时收进托盘（不退出界面）';
  @override
  String get settingsCloseToTrayNote =>
      '托盘图标若被系统收进"隐藏的图标"面板，关窗后会找不到界面；关掉此项则点 × 直接退出（她照常运行）。';
  @override
  String get settingsLanguage => '语言';
  @override
  String get languageFollowSystem => '跟随系统';
  @override
  String get settingsLanguageNote => '界面文字的语言，即时生效；不写入配置、不影响她的说话方式。';

  @override
  String get settingsStringsOverride => '文案覆盖';
  @override
  String get settingsStringsOverrideNote =>
      '改上面那个文件就能改界面上的字：没写的仍用默认文案；带参数的句子（如「加载失败：…」）暂时不参与覆盖。'
      '点「重新载入文案」立刻生效，不用重启界面。';
  @override
  String get stringsOverridePathLabel => '覆盖文件';
  @override
  String get stringsOverrideOpen => '打开文案文件';
  @override
  String get stringsOverrideReload => '重新载入文案';
  @override
  String get stringsOverrideExport => '导出当前文案为模板';
  @override
  String get stringsOverrideNone => '未使用覆盖（默认文案）';
  @override
  String stringsOverrideLoaded(int zh, int en) => '已加载 ${zh + en} 条覆盖（zh $zh / en $en）';
  @override
  String stringsOverrideFailed(String reason) => '解析失败：$reason';
  @override
  String stringsOverrideUnreadable(String detail) => '读不出来（$detail）';
  @override
  String stringsOverrideBadJson(String detail) => 'JSON 格式不对（$detail）';
  @override
  String get stringsOverrideBadRoot =>
      '顶层不是 JSON 对象（应为 {"zh": {…}, "en": {…}} 或 {"键": "文案"}）';
  @override
  String stringsOverrideIgnored(int count) => '有 $count 条键没被采用（不认识的键或值不是字符串，详情见启动日志）';
  @override
  String stringsOverrideExported(String path) => '模板已写到：$path';
  @override
  String stringsOverrideExportFailed(String reason) => '模板写不出去：$reason';
  @override
  String stringsOverrideOpenFailed(String path) => '打不开：$path';

  @override
  String get settingsAnchorCaption => '分区';
  @override
  String get settingsNavModel => '模型';
  @override
  String get settingsNavUi => '界面';
  @override
  String get settingsNavSpeak => '发言';
  @override
  String get settingsNavDeps => '外部依赖';
  @override
  String get settingsNavProtocol => '协议端';
  @override
  String get settingsNavWebhook => '外部回调';

  @override
  String get settingsNavMemory => '记忆';
  @override
  String get settingsNavTrust => '信任范围';

  @override
  String get settingsNavSystem => '系统';
  @override
  String get settingsNavAccount => '账号与安全';

  @override
  String get settingsNavAbout => '关于';
  // ── 运行情况页 ──
  @override
  String get overviewSubtitle => '当前状态、用量与待确认项';
  @override
  String get overviewSectionAdvice => '建议';
  @override
  String get overviewSectionRecent => '最近事件';
  @override
  String get overviewPersonaSeedAdvice => '人格资产未初始化：IDENTITY.md 仍为模板，先补全身份与语气。';
  @override
  String get overviewNoPendingCalls => '现在没有待确认的调用';
  @override
  String get overviewTimerCancelTitle => '撤销这个定时器？';
  @override
  String get overviewTimerCancel => '撤销';
  @override
  String get overviewDeadDiscardTitle => '丢弃这条死信？';
  @override
  String get overviewDeadDiscardConfirm => '确认丢弃';
  @override
  String get overviewDeadRequeue => '重投';
  @override
  String get overviewDeadDiscard => '丢弃';
  @override
  String get overviewLoadFailedTitle => '无法获取运行数据';
  @override
  String get overviewMarkSucceeded => '标记成功';
  @override
  String get overviewMarkFailed => '标记失败';
  @override
  String get overviewTodayUsage => '今日用量';
  @override
  String get overviewCacheHitRate => '缓存命中率';
  @override
  String get overviewPending => '待确认';
  @override
  String get overviewFailStreak => '连续失败';
  @override
  String get overviewActFallback => '去处理';
  @override
  String get overviewDeadLettersUnread => '没读到死信明细，刷新一次再看看。';
  @override
  String get overviewUnknownSession => '未知会话';
  @override
  String get overviewChatTypeDirect => '单聊';
  @override
  String get overviewChatTypeGroupAt => '群聊@';
  @override
  String get overviewChatTypeGroup => '群聊';
  @override
  String get overviewChatTypeGuild => '频道';
  @override
  String get overviewChatTypeUnknown => '类型未知';
  @override
  String get overviewExternalSessions => '外部会话';
  @override
  String get overviewExternalSessionsNote => '经由消息适配器添加的会话。平台推给我们的消息存入信箱，由 Agent 自行查看。';
  @override
  String get overviewExternalSessionsLoading => '正在读外部会话…';
  @override
  String get overviewExternalSessionsErrorHint => '状态与用量不受影响；读到数据后这张卡会自己出现。';
  @override
  String get overviewNoAccumulatedMessages => '没有积累的消息（信箱里是空的；群里没 @ 她的消息，要官方 Bot 先推给我们才进得来）。';
  @override
  String get overviewLevelCritical => '严重';
  @override
  String get overviewLevelWarn => '警告';
  @override
  String get overviewLevelInfo => '提示';
  @override
  String get overviewLevelUnknown => '未知等级';
  @override
  String get overviewFrameworkNote => '框架提示';
  @override
  String get overviewFrameworkNotesLoading => '正在读框架提示…';
  @override
  String get overviewFrameworkNotesErrorHint => '运行不受影响；注入预警与告警仍照常记录在事件日志里。';
  @override
  String get overviewNoFrameworkNotes => '没有需要你知道的事。';
  @override
  String get overviewTimers => '定时器';
  @override
  String get overviewTimersNote => '她自己布防的唤醒（timer 工具的 action=set）。到点会把她叫起来，撤销只对还没触发的那些有效。';
  @override
  String get overviewNoTimers => '眼下没有排着的定时器。';
  @override
  String get overviewTimersErrorHint => '可能是它已经触发或已经被撤掉了；刷新一次看最新清单。';
  @override
  String get overviewTimerUnknownTime => '时刻未知';
  @override
  String get overviewTimerRecurring => '周期';
  @override
  String get overviewRecentEmpty => '还没有事件记录。';
  @override
  String get overviewRecentEmptyAction => '立即唤醒';
  @override
  String get overviewRecentEmptyHint => '唤醒或外部消息写入后，这里列出最近发生的事。';
  @override
  String get overviewJudgedByRule => '规则判定';
  @override
  String get overviewJudgedByModel => '模型判定';
  @override
  String get overviewSessionsNotList => '返回的数据不是会话清单';
  @override
  String get overviewNotesNotList => '返回的数据不是提示清单';
  @override
  String overviewAdviceLine(String title, String body) => '$title：$body';
  @override
  String overviewDeadLetterLine(int seq, int claimCount, String? stamp) =>
      'seq $seq · 认领 $claimCount 次${stamp == null ? '' : ' · $stamp'}';
  @override
  String overviewPendingCount(int count) => '待确认 $count 项';
  @override
  String overviewTodayUsageTooltip(String exact) => '今日用量 $exact';
  @override
  String overviewTimerCancelBody(String timerId) =>
      '定时器 $timerId 会被取消：它到点不会再把她叫起来。\n'
      '这次撤销写进日志（timer/cancelled），撤错了只能让她重新排一个。';
  @override
  String overviewTimerCancelled(String timerId) => '已撤销定时器 $timerId：到点不会再醒';
  @override
  String overviewTimerCancelFailed(String timerId, String reason) => '撤销 $timerId 失败：$reason';
  @override
  String overviewTimerCancelToastFailed(String reason) => '撤销失败：$reason';
  @override
  String overviewMarkFailedToast(String reason) => '标记失败：$reason';
  @override
  String overviewDeadRequeued(int seq) => '已重投 seq $seq：它回到队列，下一拍重新认领';
  @override
  String overviewDeadDiscardBody(int inputSeq) =>
      'seq $inputSeq 不会被重投，也不会被执行——它就此退出待处理。\n'
      '这次决定会写进日志：那条输入本身仍留在事件日志里，日后可以查。';
  @override
  String overviewDeadDiscarded(int seq) => '已丢弃 seq $seq：它不会再被执行，日志里仍留着那条输入';
  @override
  String overviewDeadActionFailed(String verb, int seq, String reason) => '$verb seq $seq 失败：$reason';
  @override
  String overviewDeadActionToastFailed(String verb, String reason) => '$verb失败：$reason';
  @override
  String overviewHistoricalBadge(String label) =>
      label.isEmpty ? '已恢复 · 历史' : '$label · 已恢复 · 历史';
  @override
  String overviewSourceFramework(String? fingerprint) =>
      fingerprint == null ? '来源：框架自身' : '来源：框架自身 · $fingerprint';
  @override
  String overviewSourceChat(String who) => '来源：$who';
  @override
  String overviewQuote(String text) => '「$text」';
  @override
  String overviewGroupsCount(int count) => '$count 个群聊';
  @override
  String overviewSinglesCount(int count) => '$count 个单聊';
  @override
  String overviewOthersCount(int count) => '$count 个其它';
  @override
  String overviewUnreadTotal(int count) => '合计 $count 条未读';
  @override
  String overviewMessagesSeen(int count) => '来过 $count 条';
  @override
  String overviewUnreadBadge(int count) => '未读 $count';
  @override
  String overviewTimersWaiting(int count) => '$count 个在等';
  @override
  String overviewTimerCron(String cron) => '周期 $cron';
  @override
  String overviewTimerPayload(String payload) => '唤醒内容：$payload';
  @override
  String overviewExternalSessionsError(String reason) => '外部会话读取失败：$reason';
  @override
  String overviewFrameworkNotesError(String reason) => '框架提示读取失败：$reason';
  @override
  String get settingsLaneHeavyLabel => '主循环（heavy）';
  @override
  String get settingsLaneLightLabel => '轻量（light）';
  @override
  String get settingsLaneHeavyNote => 'turn 主循环使用的模型';
  @override
  String get settingsLaneLightNote => '必要性判断、压缩摘要与守卫分类使用的模型';
  @override
  String get settingsDepSourceManaged => '框架托管';
  @override
  String get settingsDepSourceSystemPath => '系统 PATH';
  @override
  String get settingsDepVersionUnknown => '版本未知';
  @override
  String get settingsDepPathUnknown => '路径未知';
  @override
  String get settingsSysHostEmptyError => '监听地址不能为空：空值等于监听所有网卡，未保存';
  @override
  String settingsSysEmptyError(String label) => '$label不能为空，未保存';
  @override
  String settingsSysIntRequired(String label) => '$label要填整数，未保存';
  @override
  String settingsSysPortRange(String label) => '$label要在 1~65535 之间，未保存';
  @override
  String settingsSysMinOne(String label) => '$label最小是 1，未保存';
  @override
  String settingsSysRatioRequired(String label) => '$label要填小数（0.8 表示 80%），未保存';
  @override
  String settingsSysRatioRange(String label) => '$label是比例，要落在 0~1 之间（不含 0），未保存';
  @override
  String settingsSysMin(String label, int lo) => '$label最小是 $lo，未保存';
  @override
  String settingsSysMax(String label, int hi) => '$label最大是 $hi，未保存';
  @override
  String get settingsSysHostLabel => '监听地址';
  @override
  String get settingsSysHostNote => '本机用就填 127.0.0.1；端口 1~65535。留空等于监听所有网卡，会被拦下。';
  @override
  String get settingsSysPortLabel => '端口';
  @override
  String get settingsSysTimezoneLabel => '时区';
  @override
  String get settingsSysTimezoneNote => 'IANA 名称，例如 Asia/Shanghai。预算的「今日」按它切分。';
  @override
  String get settingsSysStepToolsLabel => '预算 · 步内工具调用上限';
  @override
  String get settingsSysStepToolsNote => '单个 step 里最多调几次工具。';
  @override
  String get settingsSysTurnStepsLabel => '预算 · 单 turn 步数上限';
  @override
  String get settingsSysTurnStepsNote => '一个 turn 最多走多少步。';
  @override
  String get settingsSysTaskTokensLabel => '预算 · 任务 token 上限';
  @override
  String get settingsSysTaskTokensNote => '单个任务累计上限；填原值，20M 这类简写不接受。口径是非缓存 token（真花钱的那部分），不是账单上的用量。';
  @override
  String get settingsSysDailyTokensLabel => '预算 · 每日 token 上限';
  @override
  String get settingsSysDailyTokensNote => '每日累计上限，按上面的时区切分。口径同上一行：只数没命中缓存的那部分。';
  @override
  String get settingsSysSoftRatioLabel => '预算 · 软阈值';
  @override
  String get settingsSysSoftRatioNote => '0~1 的小数：0.8 就是 80%。到这一线先提示收尾，越过才硬停。';
  @override
  String get settingsSysFailStreakLabel => '预算 · 连续失败上限';
  @override
  String get settingsSysFailStreakNote => '连续失败这么多次就告警并进入暂停。';
  @override
  String get settingsSysHeartbeatLabel => '心跳间隔 · 平均（分钟）';
  @override
  String get settingsSysHeartbeatNote => '她平均多久自己醒一次——越大越省 token，越小越常醒。两端仍由上下限兜住：不因这个数改变，安静不足下限不会醒、到了上限必然会醒。';
  @override
  String get settingsSysCompactionLabel => '上下文 · 压缩线（token 估算）';
  @override
  String get settingsSysCompactionNote =>
      '可见历史攒到这么多 token（估算）就折成一篇交接笔记，压缩只遮蔽、不删除。'
      '单位是估算器读数，不是供方计数（估算比供方偏低约 1.65~1.66 倍）。'
      '填原值：200000 这类写法不接受；调小 = 压得更勤，而每次压缩自己也要花一次调用。'
      '改完立刻生效，不用重启。';
  @override
  String get settingsTrustConsequenceWorkspaceUnknown => '她只能在配置里的工作目录（trust.workspaceRoot）中活动；越界的读写与命令会被拒绝。';
  @override
  String settingsTrustConsequenceWorkspace(String root) => '她只能在 $root 里活动；越界的读写与命令会被拒绝。';
  @override
  String get settingsTrustConsequenceFull => '她能读写整台电脑上的文件、也能在任意目录跑命令。';
  @override
  String get settingsTrustLabelWorkspace => '只限工作目录';
  @override
  String get settingsTrustLabelFull => '完全信任';
  @override
  String get settingsWebhookStateNotObject => '凭据状态读取失败（响应不是对象）';
  @override
  String get settingsProtocolStateNotObject => '协议端状态读取失败（响应不是对象）';
  @override
  String get settingsDepsReadFailed => '依赖报告读取失败';
  @override
  String get settingsKeysReadFailed => '密钥状态读取失败';
  @override
  String get settingsProjectionReadFailed => '运行数据读取失败';
  @override
  String get settingsModelNameRequired => '模型名不能为空，未保存';
  @override
  String get settingsBaseUrlRequired => 'Base URL 不能为空，未保存';
  @override
  String get settingsNoChanges => '没有需要保存的改动';
  @override
  String get settingsWrittenModelSettings => '模型设置';
  @override
  String get settingsWrittenKey => '密钥';
  @override
  String get settingsRestartSuffix => '，进程重启后生效';
  @override
  String settingsSaveFailed(String err) => '保存失败：$err';
  @override
  String get settingsClearKeyBody => '清除后需重新填写；来自环境变量的值不受影响。';
  @override
  String get settingsClear => '清除';
  @override
  String get settingsKeyCleared => '已清除本地密钥';
  @override
  String settingsClearFailed(String err) => '清除失败：$err';
  @override
  String get settingsConfigErrorHint => '模型密钥与系统信息需要生效配置才能显示。请确认主进程已启动。';
  @override
  String get settingsConfigUnavailable => '配置不可用。';
  @override
  String get settingsConfigUnavailableHint => '本地服务 /api/config 未返回配置内容。';
  @override
  String settingsKeysReadFailedHint(String keysError) => '密钥状态读取失败（$keysError）。密钥徽章不可用，模型名与 Base URL 仍可保存。';
  @override
  String get settingsConfigFallbackNote => '读不到 config.json，这一页显示的是当前生效的那份（保存仍会写进文件）。';
  @override
  String get settingsModelRestartNote => '上面有改动还没生效：模型名与端点是启动参数，要重启进程才接管——在那之前跑的还是启动时那份。保存本身是成功的，框里显示的就是盘上那份。';
  @override
  String get settingsKeysNote => '密钥只写不读：本页显示的始终是掩码，完整值仅在建立连接时读取一次。保存写入 config.json 与 data/.keys.json，进程重启后接管（环境变量优先于文件）。';
  @override
  String get settingsKeyConfiguredHint => '已配置；粘贴新密钥可覆盖';
  @override
  String get settingsKeySampleHint => 'sk-…';
  @override
  String get settingsModelName => '模型名';
  @override
  String get settingsBaseUrlNote => 'API 根地址，不含 /responses。';
  @override
  String settingsKeyEnvNote(String envName) => '环境变量 $envName 优先；它没有值时使用此处的值（写入 data/.keys.json，只写不读）。';
  @override
  String get settingsClearKey => '清除密钥';
  @override
  String get settingsReading => '读取中…';
  @override
  String get settingsStateReadFailed => '状态读取失败';
  @override
  String get settingsNotConfigured => '未配置';
  @override
  String get settingsSpeakNote => '她说话时的节奏：一条条往外蹦、每条之间隔多久。只影响投递手感，不影响说话内容。';
  @override
  String get settingsSpeakTyping => '打字节奏';
  @override
  String get settingsSpeakTypingNote => '开着：按“这段话要打多久”逐条发出，像人在打字（对方也随时能插话打断）。关掉：一次发完，内容尽快到手。';
  @override
  String get settingsSpeakSpeed => '打字速度';
  @override
  String get settingsSpeakSpeedUnit => '字/分钟';
  @override
  String get settingsSpeakSpeedNote => '默认 90（中文手机输入的常见速度）。调大说得更快、等待更短；范围 30~600。';
  @override
  String get settingsCurrentlyActive => '当前生效';
  @override
  String settingsSpeakTypingOn(String saved) => '$saved 字/分钟 · 逐条发';
  @override
  String settingsSpeakTypingOff(String saved) => '$saved 字/分钟 · 一次发完';
  @override
  String get settingsSpeakTypingEnabled => '已开启打字节奏（重启后接管）';
  @override
  String get settingsSpeakTypingDisabled => '已关闭打字节奏（重启后接管）';
  @override
  String get settingsSpeakSpeedRange => '打字速度要在 30~600 之间';
  @override
  String get settingsSavedRestartNote => '已保存（重启后接管）';
  @override
  String get settingsSavedLive => '已保存，立刻生效（不用重启）';
  @override
  String get settingsSavedRestart => '已保存，重启后生效';
  @override
  String get settingsDepsAllReady => '全部就绪';
  @override
  String get settingsDepsNote => '建议安装的外部依赖，可由框架一键安装。';
  @override
  String settingsDepsReadFailedHint(String depsError) => '依赖报告读取失败（$depsError）。装不了也看不见状态时，先在命令行确认主进程已启动。';
  @override
  String get settingsDepsProbing => '正在探测本机的 pwsh / ripgrep / es.exe / python …';
  @override
  String get settingsDepsInstallLocation => '安装位置：<数据目录>/tools/<名字>/。装完立即生效——探测结论会在安装后复检并刷新，下一次工具调用用的就是新引擎。';
  @override
  String get settingsDepReadyManaged => '已就绪·托管';
  @override
  String get settingsDepReadySystem => '已就绪·系统';
  @override
  String get settingsDepMismatch => '版本不符';
  @override
  String get settingsDepMissing => '未安装';
  @override
  String get settingsDepNoAction => '无需操作';
  @override
  String get settingsDepInstalling => '安装中…';
  @override
  String get settingsInstall => '安装';
  @override
  String get settingsDownloadPage => '下载页';
  @override
  String get settingsOpenDownloadPage => '打开下载页';
  @override
  String get settingsDownloadAndInstall => '下载并安装';
  @override
  String settingsInstallRequestFailed(String err) => '安装请求失败：$err';
  @override
  String get settingsStepDownloadFailed => '下载失败';
  @override
  String get settingsStepExtractFailed => '解压失败';
  @override
  String get settingsStepVerifyFailed => '装完复检没通过';
  @override
  String get settingsStepInstallFailed => '安装失败';
  @override
  String settingsOpenedUrl(String url) => '已用默认程序打开 $url';
  @override
  String get settingsUnknown => '未知';
  @override
  String get settingsRestartRequired => '需重启';
  @override
  String get settingsProtocolTitle => '协议端（可选）';
  @override
  String get settingsProtocolNote => '可选：由框架拉起的 OneBot 协议端，背后是一个真实 QQ 号。它与官方 Bot 各是一条独立的入站通道，装不装都不影响另一条。';
  @override
  String settingsProtocolError(String protocolError) => '协议端状态读取失败：$protocolError';
  @override
  String get settingsProtocolErrorHint => '这张卡读不到不影响其它设置。先确认主进程已启动，再点重试；在读到状态之前，这里不提供开关、目录与一键安装——那等于让你在看不到当前值的情况下写它。';
  @override
  String get settingsProtocolLoading => '正在读取协议端状态…';
  @override
  String get settingsProtocolEmpty => '还没配置内置协议端。';
  @override
  String get settingsProtocolEmptyHint => '不开也照常用：官方 Bot 那条通道不受影响。要用这条路，点下面的「一键安装」把装与配一次做完。';
  @override
  String get settingsProtocolEnabled => '启用内置协议端';
  @override
  String get settingsProtocolEnabledNote => '框架启动时自动连接；关闭后可在双端手动填写和配置。';
  @override
  String get settingsInstallDir => '安装目录';
  @override
  String get settingsInstallDirHint => '<协议端安装目录>';
  @override
  String get settingsSaveDir => '保存目录';
  @override
  String get settingsInstallDirNote => '协议端安装目录（绝对路径）。Lite 包解压后入口 index.mjs 就在这一层，没有 dist/ 子目录；「一键安装」会自动填好。';
  @override
  String get settingsOneClickInstall => '一键安装';
  @override
  String get settingsOneClickInstallNote => '从 SnowLuma 官方 Release 下载 Lite 包；自动下载失败时，自行下载并填写安装目录。此包不随框架分发，不得用于商业使用。';
  @override
  String get settingsOneClickPrerequisite => '使用前提：本机已登录 QQ 客户端（Bot 账号）。';
  @override
  String get settingsInstallRunningNote =>
      '正在从官方 Releases 下载并解压。要下 4.6 MB，视网速可能要一两分钟——先别急，也别再点一次。'
      '分步记录（下到哪一步、下多大）会在这一步结束时一次性列出来：'
      '这条端点是同步请求，不是流，中间插不进进度行。';
  @override
  String settingsInstallManualRoute(String protocolDownloadUrl) => '手动出路：从 $protocolDownloadUrl 下载发行包，解压后把那个目录填到下面的「安装目录」，再点「保存目录」、打开开关——效果与一键安装一样，只是这几步由你做。';
  @override
  String get settingsInstallLogEmpty => '过程记录：（这次没有——失败发生在动手之前）';
  @override
  String get settingsInstallLog => '过程记录：';
  @override
  String get settingsInstalledNextTitle => '已经装好了。下一步：先重启服务，再扫码。';
  @override
  String get settingsInstalledNextBody =>
      '① 重启服务：运行中的协议端实例是按启动时的配置建的，重启之后它才会按刚写好的配置被拉起'
      '（框架不替你重启——重启自己失败就什么都不剩了）。\n'
      '② 再扫码：重启后这张卡上会出现「打开面板」，点开在那边先读并同意用户协议与隐私政策'
      '（那是法律性质的同意，要你自己按），再接入 QQ 并扫码；'
      '首次登录要用它启动时打印的初始凭据——那句话现在就显示在按钮下面（口令打码），'
      '旁边有「复制凭据」。扫码接的是你本机的 QQ 客户端，框架不代管登录态。';
  @override
  String get settingsInstallDirEmpty => '（还没填安装目录）';
  @override
  String get settingsEntryFound => '已找到可执行入口';
  @override
  String get settingsEntryMissing => '目录里没有可执行入口';
  @override
  String get settingsEntryPendingRestart => '入口要重启后才核对';
  @override
  String settingsEndpointPoint(String wsUrl) => '对接点：$wsUrl';
  @override
  String get settingsStart => '启动';
  @override
  String get settingsStop => '停止';
  @override
  String get settingsOpenPanel => '打开面板';
  @override
  String get settingsProtocolNotAttachedNote => '本次进程启动时还没读到这段配置：框架现在不持有它的实例，「启动/停止」要等重启进程之后才有效。';
  @override
  String get settingsChainProcess => '① 进程';
  @override
  String get settingsChainUnobserved => '未观测';
  @override
  String get settingsChainNoInstance => '本进程没有实例，这一档没人在看';
  @override
  String get settingsChainNotRunning => '没在跑';
  @override
  String get settingsChainNoPort => '没有监听到它的面板端口';
  @override
  String get settingsChainSpawned => '本次进程拉起';
  @override
  String get settingsChainDiscovered => '本次进程之前就在跑';
  @override
  String get settingsChainPortOnly => '只探到端口';
  @override
  String get settingsChainRunning => '在跑';
  @override
  String settingsChainListening(String url) => '监听 $url';
  @override
  String get settingsChainOneBotConfig => '② OneBot 配置';
  @override
  String get settingsChainWithToken => '带 token';
  @override
  String get settingsChainNoToken => '无 token（协议端未开校验）';
  @override
  String get settingsChainPresent => '在';
  @override
  String settingsChainEndpoint(String ws) => '端点 $ws';
  @override
  String get settingsChainUnreadable => '读不出';
  @override
  String get settingsChainMissing => '缺失';
  @override
  String get settingsChainMissingDetail => '未登录 QQ：这一份是登录之后才生成的';
  @override
  String get settingsChainAdapter => '③ 适配器';
  @override
  String get settingsChainConnected => '已连上';
  @override
  String settingsChainDelivered(String delivered) => '已收 $delivered 条';
  @override
  String get settingsChainReconnecting => '重连中';
  @override
  String settingsChainBackoff(String attempts) => '第 $attempts 次退避';
  @override
  String get settingsChainNoEndpoint => '没端点可连';
  @override
  String get settingsChainNoEndpointDetail => '协议端的 OneBot 配置还没出现，配置里也没有手填地址';
  @override
  String get settingsChainDisabled => '未启用';
  @override
  String get settingsChainNotAssembled => '未装配';
  @override
  String get settingsChainNotAssembledDetail => '本进程没有 OneBot 适配器';
  @override
  String get settingsChainNoData => '这一档没有数据';
  @override
  String settingsCredentialCaptured(String user, String masked) => '初始凭据（本次启动从它的输出里捕到，用户 $user / 口令 $masked）';
  @override
  String settingsCredentialFromLog(String user, String masked) => '初始凭据（从框架自己的启动留痕里捞回来的：用户 $user / 口令 $masked；若它之后又重启过，这条就作废了）';
  @override
  String get settingsCredentialLost => '初始凭据找不回来：它只在启动时往自己的输出里打一次（关掉程序就没了）。要拿到一条可用的，就让框架重启它一次（那一次的输出会被捕获并显示在这里）。';
  @override
  String get settingsConsentPending => '协议与隐私政策还没同意——面板解锁之前，接入 QQ 的入口是锁着的。';
  @override
  String get settingsPasswordUnchanged => '初始口令还没改：两个门里第一个就是改密，面板会一直要求你先改它。';
  @override
  String settingsQrLoginAt(String webuiUrl) => '扫码登录在 $webuiUrl 里做（框架不代管 QQ 登录态）。';
  @override
  String get settingsCredentialCopied => '凭据已复制（用户 + 口令）';
  @override
  String get settingsCopyCredential => '复制凭据';
  @override
  String settingsManualDownloadGuide(String protocolDownloadUrl) =>
      '也可以自己来：从 $protocolDownloadUrl 下载发行包解压，把那个目录填在上面。'
      '这条路在一键安装失败、或者你想自己控制版本时用；框架也从同一个地址代下载，不随框架分发它'
      '（许可是"源码可见非商业"，自用没问题）。';
  @override
  String get settingsProtocolRestartNote => '改动已写入 config.json，但要重启进程才接管：运行中的协议端实例是按启动时那份配置建的。重启之前，这里显示的状态仍是本次启动的那一个。';
  @override
  String get settingsInstallDirRequired => '安装目录不能为空';
  @override
  String get settingsStartRequested => '已请求启动';
  @override
  String get settingsStopRequested => '已请求停止';
  @override
  String settingsInstallRequestFailedHint(String err) => '安装请求失败：$err（请求没走到安装那一步，先确认主进程在跑）';
  @override
  String get settingsOneClickFailed => '一键安装失败：原因见卡片';
  @override
  String get settingsInstallNoReason => '安装失败，服务端没有给出原因（回执里没有 detail）';
  @override
  String get settingsInstalledOk => '已装好';
  @override
  String get settingsInstalledConfigured => '已装好并用它配好了；重启一下就能用';
  @override
  String get settingsInstalledNotConfigured => '已装好，但自动配置没写成：见卡片里的说明';
  @override
  String get settingsRestartSuffixParen => '（重启进程后接管）';
  @override
  String get settingsGenerated => '已生成';
  @override
  String get settingsNotGenerated => '还没有生成';
  @override
  String get settingsWebhookNote => '外部系统往这台实例投递用的专用凭据（POST /webhook/*）。';
  @override
  String settingsWebhookErrorHint(String webhookError) => '凭据状态读取失败（$webhookError）。状态看不见时先别按"重新生成"：轮换不可逆（旧的那份当场失效），而此刻你并不知道有没有人在用它。';
  @override
  String get settingsWebhookLoading => '正在读取 webhook 凭据状态…';
  @override
  String get settingsWebhookCurrent => '当前凭据';
  @override
  String settingsWebhookCurrentValue(String secretId, String createdAt) => '凭据 $secretId · 生成于 $createdAt';
  @override
  String get settingsWebhookNotConfiguredNote => '这条通道现在一律 401（没有凭据就没人投得进来）。按下面的按钮生成一份。';
  @override
  String get settingsWebhookRotated => '上次轮换';
  @override
  String get settingsWebhookNever => '从未';
  @override
  String settingsWebhookBy(String by) => '发起方：$by';
  @override
  String get settingsRegenerate => '重新生成';
  @override
  String get settingsGenerateWebhook => '生成 webhook 凭据';
  @override
  String get settingsWebhookCredentialNote => '/webhook/* 不认界面凭据（也不认迁移期那份 data/.ui-token）：这条通道只认上面那份专用凭据。它是给外部系统的——投得进来，读不到 /api/* 上的任何东西。';
  @override
  String get settingsRegenerateTitle => '重新生成 webhook 凭据';
  @override
  String get settingsRegenerateBody => '上一份会当场失效：已经在用它的外部脚本会立刻开始收 401——记得把新凭据一起换过去。新凭据只显示一次。';
  @override
  String get settingsNoTokenReturned => '服务端没有回凭据原文，请再按一次；若反复如此，去看主进程日志';
  @override
  String get settingsWebhookRotatedNote => '上一份已当场失效（还在用它的外部脚本会开始收 401）。';
  @override
  String settingsGenerateFailed(String err) => '生成失败：$err';
  @override
  String get settingsMemoryNote => '长期记忆（MEMORIES/ 与 diary/）由谁维护：框架替你管，还是她自己读、自己写、自己整理。';
  @override
  String get settingsNotInEffect => '尚未生效';
  @override
  String get settingsMemoryEnableLabel => '让框架自动管记忆（关掉 = 她只知道自己有这些文件，读、写、整理全归她）';
  @override
  String get settingsMemoryEnableNote => '开着：框架生成并维护 MEMORIES/INDEX.md，每轮把索引注入固定块，并每日整理一次。';
  @override
  String get settingsMemoryOn => '框架自动管记忆（每轮注入索引、每日整理）';
  @override
  String get settingsMemoryOff => '她自己管（框架不生成、不注入、不整理）';
  @override
  String get settingsMemoryUnaffectedNote => '不受这个开关影响的两条路：MEMORIES/aliases.md 参与「会话认人 / 关注名单」属于通道侧；STATE.md（她当前状态）是独立的一层。';
  @override
  String get settingsMemoryRestartNote => '这一项是进程启动时读的：保存写进 config.json，重启后接管。关掉不会删任何文件。';
  @override
  String get settingsMemoryDetail =>
      '关掉之后框架不生成、不注入、不整理，但她照旧能自己读写那些文件。'
      '为什么留这个开关：给只想让 agent 自己管记忆的人一条干净的路。'
      '每日整理的时间点由 wake.memoryMaintainCron 定（默认每日一次）：'
      '过期的流水账并进 facts.md，另写一篇 diary/。'
      'facts.md 的 !pinned 分区与条目 TTL 也归框架维护。';
  @override
  String get settingsMemoryCost => '代价：她可能忘记整理，facts.md 会一直长下去，索引也不再更新——这些都归她自己。';
  @override
  String get settingsMemoryOnSaved => '已改为框架自动管记忆（重启后接管）';
  @override
  String get settingsMemoryOffSaved => '已改为她自己管记忆（重启后接管）';
  @override
  String get settingsTrustNote => '她的活动边界：整台电脑，或只有一个工作目录。越界就是拒绝，不是提醒。';
  @override
  String get settingsTrustReachLabel => '她能碰到多远';
  @override
  String get settingsTrustReachNote => '两档各自管什么写在选项里，改哪一档就按哪一档的后果算。';
  @override
  String get settingsTrustWorkspaceUnknownPath => '只限工作目录（路径未读到）';
  @override
  String settingsTrustWorkspaceValue(String root) => '只限工作目录 · $root';
  @override
  String get settingsTrustFullValue => '完全信任（整台电脑）';
  @override
  String get settingsTrustPendingNote => '上面选的那一档还没生效：盘上已经写下了，但正跑着的这个进程用的仍是启动时读到的那份——重启后接管。在那之前，她照旧按当前生效的那一档活动。';
  @override
  String get settingsTrustRootNote => '工作目录由服务端算出来（默认 <配置目录>/workspace），界面上不手填：同一条边界写两个值，就一定会出现"配置说 A、实际拦在 B"。';
  @override
  String get settingsTrustBoundaryNote => '它是边界，不是提醒：越界的读写与命令一律被拒绝。';
  @override
  String get settingsTrustRulesDetail =>
      '它管 fs 工具族（safe_read / safe_write / safe_edit / rg_search 等）与 pwsh：'
      '前者经同一条路径判定，后者的 workdir 与命令行里的路径一起受管。'
      '它与 destructive 开关、pwsh 命令黑名单是各自独立的三道门——这一条管的是范围，'
      '不代替那两道。\n'
      '为什么默认完全信任：她是一台无人值守的常驻 agent，"能自己去找、去修、去装"本来'
      '就是她存在的方式；默认把她关进一个空目录，等于出厂就让她大多数本事用不出来。';
  @override
  String get settingsTrustFullTitle => '改成完全信任';
  @override
  String get settingsTrustFullConfirmTail => '这是一条边界，撤掉它她是真的能做到上面这些事。确定吗？';
  @override
  String get settingsTrustWorkspaceSaved => '已改为只限工作目录；越界的读写与命令会被拒绝（重启进程后接管）';
  @override
  String get settingsTrustFullSaved => '已改为完全信任（重启进程后接管）';
  @override
  String get settingsSystemNote => '监听地址、时区、六条预算与心跳都是这个进程的启动参数：在这里改，保存写进 config.json，重启后生效。压缩线那一行例外——它写完立刻生效（服务端在同一个临界区里也改了内存那份）。';
  @override
  String get settingsDataDir => '数据目录';
  @override
  String get settingsDataDirNote => '启动时定下的路径：事件日志、人格资产与密钥都在它下面，换它等于让下一个进程从空目录开始。';
  @override
  String get settingsSystemFootnote => '数据目录在这里改不了（它决定她的全部身家落在哪，且进程启动时就定下了）；其余字段保存后重启进程生效——压缩线那一行除外，它保存完就当拍接管。';
  @override
  String get settingsLiveNow => '立刻生效';
  @override
  String get settingsEdit => '编辑';
  @override
  String get settingsAccountNote => '进来这个界面用的凭据：改密码与登出。';
  @override
  String get settingsAccountLegacyBadge => '旧的共享 token';
  @override
  String get settingsAccountSessionBadge => '会话凭据';
  @override
  String get settingsAccountInstance => '当前实例';
  @override
  String get settingsAccountInstanceNote => '凭据按实例分文件存（%APPDATA%\\Irmia\\sessions）：同一台机器上开第二个实例不会把这一份顶掉。';
  @override
  String get settingsAccountLegacyNote => '这一份用的是旧的共享 token（这台实例还没设过密码），服务端不认它开出的"会话"：改密码与登出都做不成。先设置一个密码，之后按会话登录/登出。';
  @override
  String get settingsChangePassword => '改密码';
  @override
  String get settingsLogout => '登出';
  @override
  String get settingsSetPasswordFirst => '先去设置密码';
  @override
  String get settingsPasswordChanged => '密码已改；这台界面已经换上新凭据';
  @override
  String get settingsLogoutBody => '退出这个界面并回到门上；本机这份会话凭据会被清掉——下次要用密码进来。';
  @override
  String get settingsAboutNote => '界面版本与运行期投影数据。';
  @override
  String get settingsAboutBadge => 'Flutter 原生界面';
  @override
  String get settingsVersionLabel => '版本';
  @override
  String get settingsGuardedDays => '守护天数';
  @override
  String get settingsWatermark => '事件水位';
  @override
  String settingsProjectionReadFailedHint(String projError) => '运行数据读取失败（$projError），守护天数与事件水位不可用。';
  @override
  String get settingsProjectionFootnote => '守护天数与事件水位取自运行期投影（GET /api/projection），为实测值。';
  @override
  String settingsDaysCount(String days) => '$days 天';
  @override
  String settingsDaysSince(String days, String stamp) => '$days 天（自 $stamp）';
  @override
  String get settingsDestructivePolicy => 'destructive 工具策略';
  @override
  String get settingsModify => '修改';
  @override
  String get settingsPolicyNoneOption => '全关（一件都不给她看）';
  @override
  String get settingsPolicyAllOption => '全开（清单里全给）';
  @override
  String get settingsPolicyListOption => '按名单（只给勾中的那几件）';
  @override
  String get settingsPolicyListTitle => '按名单开放';
  @override
  String get settingsPolicyNoTools => '没拿到工具清单（注册表可能还没起来）——先去「扩展 · 工具」看一眼再回来。';
  @override
  String get settingsDestructiveTitle => '修改 destructive 工具策略';
  @override
  String get settingsDestructiveRelaxedBody => '这会让她能看到并调用会改动本机的工具（写文件、跑命令等）。确定吗？';
  @override
  String get settingsDestructiveRestrictedBody => '改回受限档：她将看不到 destructive 工具（更安全）。确定吗？';
  @override
  String get settingsPolicyAll => '全开';
  @override
  String get settingsPolicyListEmpty => '按名单（空）';
  @override
  String get settingsPolicyNone => '全关';
  // ── 设置页：手写的那几条 ──
  @override
  String get settingsListAnd => '与';
  @override
  String settingsSaved(String written, String restart) => '已保存$written$restart';
  @override
  String settingsClearKeyTitle(String laneLabel) => '清除密钥 · $laneLabel';
  @override
  String settingsKeyConfiguredMask(String mask) => '已配置 $mask';
  @override
  String settingsDepPipUnavailable(String? reason) =>
      'pip：不可用${reason == null ? '' : '（$reason）'}';
  @override
  String settingsInstallConfirmBody(String managedDir) =>
      '会从官方地址下载压缩包并解压到 $managedDir，然后立即复检。'
      '装好后 agent 就能用它（rg_search / es_search 会随之注册；'
      'Python 还会顺带引导 pip，让她能自己 pip install 扩能力）。';
  @override
  String settingsDepReadyToast(String label, String version) => '$label 已就绪（$version）';
  @override
  String settingsStepErrorToast(String step, String error) => '$step：$error';
  @override
  String settingsNoDownloadPage(String hint) => '这一项没有下载页；装法：$hint';
  @override
  String settingsOpenUrlFailed(String url, String? hint) =>
      '打不开浏览器，地址是 $url${hint == null ? '' : '（$hint）'}';
  @override
  String settingsInstalledVersion(String? version) => '已装好${version == null ? '' : ' $version'}';
  @override
  String settingsWriteErrorNote(String writeError) =>
      '自动配置没写成：$writeError。装好的目录已经替你填在下面的「安装目录」里，'
      '点一下「保存目录」、再把「启用内置协议端」打开就行（同样是重启后接管）。';
  @override
  String settingsChainSince(String when) => '$when 起';
  @override
  String settingsChainUnreadableDetail(String path) => '那份文件在（$path）但端点解析失败——要人去修它';
  @override
  String settingsProtocolToggled(bool on, bool restart) =>
      '${on ? '已开启' : '已关闭'}内置协议端${restart ? '（重启进程后接管）' : ''}';
  @override
  String settingsInstallDirSaved(String saved, bool restart) =>
      '已保存安装目录：$saved${restart ? '（重启进程后接管）' : ''}';
  @override
  String settingsProtocolActionFailed(bool start, String err) =>
      '${start ? '启动' : '停止'}请求失败：$err';
  @override
  String settingsWebhookFileNote(String file) =>
      '凭据文件：$file（盘上只有它的 sha256：原文只在你按下按钮那一次出现在屏幕上，'
      '之后再没人读得回来）。';
  @override
  String settingsTrustFullBody(String consequence) => '改成完全信任之后：$consequence';
  @override
  String settingsPolicyListCount(int count) => '按名单（$count 项）';
  @override
  String get settingsUnknownReason => '未知原因';
  @override
  String get settingsSeeOfficialDocs => '见官方文档';
  @override
  String get settingsWebhookCurlTokenPlaceholder => '<专用凭据>';
  @override
  String get settingsWebhookCurlSampleText => '磁盘快满了';
  @override
  String settingsDepsSuggested(int count) => '建议安装 $count 项';
  @override
  String settingsDepPipReady(String version) => 'pip $version（她可以自己 pip install 扩能力）';
  @override
  String settingsDepPurposeImpact(String purpose, String impact) => '$purpose。$impact';
  @override
  String settingsInstallTitle(String label) => '安装 $label';
  @override
  String settingsPolicySave(int count) => '保存（$count 件）';
  @override
  String settingsInstallHead(bool ok, String? version, bool configured) => ok
      ? '已装好${version == null ? '' : ' $version'}${configured ? '，并用它配好了；重启一下就能用。' : '，但自动配置那一步没成。'}'
      : '安装失败';

}

/// English。
///
/// 口径：**短、动词开头、不过度礼貌**——和中文那份同一个语气。按钮用 Title Case
/// （Material 桌面端的惯例），说明文字用句子。专有名词不译：`Irmia`、`OneBot`、
/// `MCP`、`QQ`、`token`。
class EnStrings extends AppStrings {
  const EnStrings();

  @override
  AppLanguage get language => AppLanguage.en;

  @override
  String get retry => 'Retry';
  @override
  String get cancel => 'Cancel';
  @override
  String get confirm => 'Confirm';
  @override
  String get save => 'Save';
  @override
  String get loading => 'Loading…';
  @override
  String get error => 'Something went wrong';
  @override
  String get empty => 'Nothing here';
  @override
  String get collapse => 'Collapse';
  @override
  String expandAll(int chars) => 'Show all ($chars chars)';
  @override
  String loadFailed(String reason) => 'Failed to load: $reason';
  @override
  String get settingsLoadingConfig => 'Loading config…';
  @override
  String configReadFailed(String reason) => 'Failed to read config: $reason';

  @override
  String get navChat => 'Chat';
  @override
  String get navSettings => 'Settings';
  @override
  String get navOverview => 'Overview';
  @override
  String get navChannels => 'Channels';
  @override
  String get navExtensions => 'Extensions';
  @override
  String get navPersona => 'Persona';
  @override
  String get navSchedule => 'Schedule';
  @override
  String get navMemory => 'Memory';
  @override
  String get navLogs => 'Logs';
  @override
  String get navMore => 'More';

  // ── Overview / restart / tray ──
  @override
  String get overviewConfigGuide => 'Setup guide';
  @override
  String restartConfirmed(String evidence) => 'Restart confirmed: $evidence';
  @override
  String restartEvidence(int backendPid, bool portReady) {
    final parts = <String>[
      if (backendPid > 0) 'new pid $backendPid',
      if (portReady) 'port ready',
    ];
    return parts.isEmpty ? 'the server gave no evidence (no pid, no port)' : parts.join(' · ');
  }

  @override
  String get restartSentWithGui =>
      'Restart dispatched: both the UI and the backend will restart — the window closes first, '
      'wait for it to come back (about 1–2 minutes on this machine)';
  @override
  String get restartSentBackendOnly =>
      'Restart dispatched: the backend comes back in about 20–90 seconds '
      '(the UI is not part of this action; it only reconnects)';
  @override
  String restartFailed(String reason) => 'Restart failed: $reason';
  @override
  String restartRefused(String reason) => 'Restart was not dispatched: $reason';
  @override
  String get restartNoConclusion => 'Restart dispatched, but the server returned no verdict';
  @override
  String get restartBackReady => 'Ready: the backend is back';
  @override
  String restartBackTimeout(int seconds) =>
      'The backend has not come back (waited $seconds s): check data/restart-trace.log';
  @override
  String get restartNeverWentDown =>
      'The backend never went offline: this request probably had no effect';

  @override
  String get trayShow => 'Show window';
  @override
  String get trayHide => 'Hide to tray';
  @override
  String get trayRestart => 'Restart backend + UI';
  @override
  String get trayQuitUi => 'Quit UI (she keeps running)';
  @override
  String get trayQuitAll => 'Quit everything (UI + backend)';
  @override
  String get quitAllConfirmTitle => 'Quit everything?';
  @override
  String quitAllConfirmBody(bool busy) =>
      'This ends the backend as well (including the protocol side it started), '
      'then closes this window.\n'
      '${busy ? 'She is in the middle of a turn: that turn will be interrupted and settled '
          'by the recovery flow on the next start.\n' : ''}'
      'Windows has no externally reachable graceful shutdown, so this is a hard kill: '
      'you may have to log the protocol side in again in its WebUI.\n'
      'To close only the UI (she keeps running in the background), use "Quit UI" in the tray.';
  @override
  String get quitAllConfirmLabel => 'Quit everything';
  @override
  String get quitAllWorking => 'Stopping the backend…';
  @override
  String quitAllFailed(String reason) =>
      'The backend did not stop: $reason (the UI was left open so you are not misled)';
  @override
  String get quitAllDone => 'Quit everything: the UI and the backend are both gone';

  @override
  String get onboardingManualSaved => 'Guide finished; the steps you changed were saved';
  @override
  String get onboardingManualNoChanges =>
      'Just had a look: nothing was changed and nothing was written';

  // ── First-run guide (six-step card) ──
  @override
  String get onboardingStepNameTitle => 'Her name';
  @override
  String get onboardingStepNameNote =>
      "The name is her identity; the word list below decides which words count as calling her in a group "
      '(no @ needed).';
  @override
  String get onboardingStepNameHint =>
      'Written into the "名字：" line of persona/IDENTITY.md (the old version is snapshotted, roll it back on '
      'the Persona page); the display name is read from there.';
  @override
  String get onboardingKeywordsHint =>
      'Separate with commas; any of these words in a message counts as calling her (same path as the @); '
      'typing a name fills one in, clearing it means @ only.';
  @override
  String get onboardingStepApiTitle => 'API';
  @override
  String get onboardingStepApiNote =>
      'Which model she uses. Written to config.json and data/.keys.json; takes effect after a restart.';
  @override
  String get onboardingStepChannelTitle => 'Message adapter';
  @override
  String get onboardingStepChannelNote =>
      'Where she receives messages. The QQ Official Bot AppID and AppSecret are filled in below.';
  @override
  String get onboardingStepPersonaTitle => 'Persona';
  @override
  String get onboardingStepPersonaNote =>
      'Who she is. This text is written to persona/IDENTITY.md and stays her permanent persona.';
  @override
  String get onboardingStepTrustTitle => 'Trust scope';
  @override
  String get onboardingStepTrustNote =>
      'How far she can reach: the whole machine, or a single working directory. '
      'Pick one; full trust is the default.';
  @override
  String get onboardingApiRecommendLead => 'We recommend using ';
  @override
  String get onboardingApiRecommendModel => "DeepSeek's models";
  @override
  String get onboardingApiRecommendJoin => ', ';
  @override
  String get onboardingApiRegisterKey => 'Sign up and get an API key';
  @override
  String get onboardingChannelRecommendLead => 'We recommend the ';
  @override
  String get onboardingChannelRecommendQq => 'QQ Official Bot';
  @override
  String get onboardingChannelRecommendTail => ' as the message adapter';
  @override
  String get onboardingQqTileDetail =>
      'The official open-platform channel; fill in the AppID and AppSecret below (write-only).';
  @override
  String get onboardingQqCredentialsTitle =>
      'QQ Official Bot credentials (stored in data/.keys.json, never in config.json)';
  @override
  String get onboardingQqAppIdLabel => 'AppID';
  @override
  String get onboardingQqAppIdHint => 'The bot ID from the open-platform console.';
  @override
  String get onboardingQqAppSecretLabel => 'AppSecret';
  @override
  String get onboardingQqAppSecretHint => 'The secret used to fetch an access_token.';
  @override
  String onboardingSecretConfigured(String? mask) => mask == null || mask.isEmpty
      ? 'Configured; paste a new value to overwrite'
      : 'Configured ($mask); paste a new value to overwrite';
  @override
  String get onboardingQqCredentialsNote =>
      'Filling in both enables the QQ Official Bot automatically; you can also skip this and add them '
      'later on the Channels page.';
  // 英文那份里那个 `名字：` 是 IDENTITY.md 里**真的那一行**（数据，不是界面词），不能翻。
  @override
  String get onboardingPersonaHint =>
      'Whatever you write replaces the whole file (the server keeps a snapshot; roll back on the Persona page); '
      'keep the leading "名字：" line, and an empty or unchanged draft writes nothing.';
  @override
  String get onboardingTrustNoteSame =>
      'This is a boundary, not a reminder: out-of-scope reads, writes and commands are refused (fs and pwsh '
      'both honour it). Identical to what is on disk, so this screen writes nothing; change it later on the '
      'Settings page under Trust scope.';
  @override
  String get onboardingTrustNoteChanged =>
      'This is a boundary, not a reminder: out-of-scope reads, writes and commands are refused (fs and pwsh '
      'both honour it). Pressing Done writes config.json; it takes over after a restart. Change it later on '
      'the Settings page under Trust scope.';
  @override
  String get onboardingStepDepsTitle => 'External dependencies';
  @override
  String get onboardingStepDepsNote =>
      'Without them some tools do not work: the pwsh tools, rg for grep, es for find, and the python lane.';
  @override
  String get onboardingDepsInstallLabel => 'Download and install these external dependencies';
  @override
  String get onboardingDepsAllReady => 'All four are already in place; just press Done.';
  @override
  String get onboardingDepsStatusReady => 'ready';
  @override
  String get onboardingDepsStatusMissing => 'missing';
  @override
  String get onboardingDepsItemRunning => 'installing…';
  @override
  String get onboardingDepsItemOk => 'done';
  @override
  String onboardingDepsItemFailed(String reason) => 'failed: $reason';
  @override
  String onboardingDepsSummary(int ok, int failed) => 'Done $ok / failed $failed';
  @override
  String get onboardingDepsRetry => 'Retry';
  @override
  String onboardingDepsLastRun(int ok, int failed) => 'Last run: done $ok / failed $failed';
  @override
  String onboardingDepsReadFailed(String reason) => 'Could not read the dependency status: $reason';
  @override
  String get onboardingDepsUnavailable =>
      'This backend has no dependency manager wired in, so nothing can be installed; just press Done.';
  @override
  String get onboardingRestartTitle => 'Restart needed';
  @override
  String get onboardingRestartBody => 'The dependencies are installed; restart the UI for them to take effect.';
  @override
  String get onboardingRestartNow => 'Restart now';
  @override
  String get onboardingRestartLater => 'Later';
  @override
  String onboardingOpenLinkFailed(String url) => 'Could not open a browser; the address is $url';
  @override
  String onboardingChannelSaveFailed(String reason) => 'The channel switch was not saved: $reason';
  @override
  String onboardingSecretsSaveFailed(String reason) =>
      'The AppID / AppSecret were not saved: $reason';

  @override
  String get chatTitle => 'Chat';
  @override
  String get chatSubtitle => 'Conversations, message sources, manual wake-up';
  @override
  String get composerHint => 'Type a message… (/reset clears context, /dream asks her to tidy up memory)';
  @override
  String get jumpToLatest => 'Jump to latest';
  @override
  String get jumpToLatestNew => 'New messages · Jump to latest';
  @override
  String get earlierFailed => 'Earlier records failed to load. Scroll up to retry.';
  @override
  String get noEarlier => 'No earlier records';
  @override
  String get historyErrorTitle => 'Failed to load conversation';
  @override
  String get historyErrorMessage => 'Could not read the conversation from the main process.';
  @override
  String get chatEmptyTitle => 'No conversation yet';
  @override
  String get chatEmptyMessage => 'There are no messages yet.';
  @override
  String get chatEmptyAction => 'Type a message';
  @override
  String get chatEmptyHint => 'Send something below and the conversation shows up here.';
  @override
  String get tagFrameworkNotice => 'Framework notice';
  @override
  String get tagFrameworkReminder => 'Framework reminder';
  @override
  String get tagInjection => 'Injection warning';
  @override
  String get tagContextBoundary => 'Context boundary';
  @override
  String get injectionCardTitle => 'An outside message looks like it is trying to direct her';
  @override
  String get unnamedSender => 'Unnamed conversation';
  @override
  String receivedFrom(String sender, String id) => 'Received from $sender ($id)';
  @override
  String get dash => '—';
  @override
  String mentionsYou(String where) => 'Someone mentioned you in $where';
  @override
  String talkingAbout(String what) => 'They are talking about: $what';
  @override
  String get directMessage => 'Direct message';
  @override
  String get groupMention => 'Group mention';
  @override
  String get groupMessage => 'Group message';
  @override
  String get chatTypeDirect => 'Direct';
  @override
  String get chatTypeGroup => 'Group';
  @override
  String get qqOfficialBot => 'QQ official bot';
  @override
  String get externalChannel => 'External channel';
  @override
  String get qqMessage => 'QQ message';
  @override
  String get oneBotMessage => 'OneBot message';
  @override
  String get externalMessage => 'External message';
  @override
  String get byModel => 'Model decision';
  @override
  String get byRule => 'Rule match';
  @override
  String fromWho(String who) => 'from $who';
  @override
  String get manualWake => 'Manual wake-up';
  @override
  String get intentWake => 'Intent wake-up';
  @override
  String get schedulerFire => 'Scheduled task fired';
  @override
  String scheduledAt(String at) => 'due $at';
  @override
  String get backgroundProgress => 'Background task update';
  @override
  String get eventDream => 'Dream';
  @override
  String get eventMcpDeclChanged => 'MCP declaration changed';
  @override
  String get contextClearedHere => 'Context cleared here';
  @override
  String get contextCompactedHere => 'Context compacted here';
  @override
  String get contextClearedHereDetail => 'Nothing before this line counts toward her context';
  @override
  String get contextCompactedHereDetail =>
      'Everything before this line is replaced by a handover note and no longer counted turn by turn';
  @override
  String get humanReplyRecorded => 'Human reply recorded';
  @override
  String get markedOk => 'Marked as succeeded';
  @override
  String get markedFailed => 'Marked as failed';
  @override
  String get toolRunning => 'Running';
  @override
  String get toolExecuting => 'Running…';
  @override
  String get toolDone => 'Done';
  @override
  String get toolError => 'Error';
  @override
  String get toolTimeout => 'Timed out (result unknown)';
  @override
  String get toolDenied => 'Denied by policy';
  @override
  String get toolUnknown => 'Outcome unknown';
  @override
  String get toolNotDispatched => 'Not dispatched';
  @override
  String get toolOverStepCap => 'Exceeded per-step cap';
  @override
  String get thinkingLabel => 'Thinking';
  @override
  String thinkingStep(String step) => 'step $step';
  @override
  String thinkingChars(String chars) => '$chars chars';
  @override
  String thinkingElapsed(String elapsed) => elapsed;
  @override
  String get thinkingGap => '  ';
  @override
  String compactChars(int chars) {
    if (chars < 1000) return '$chars';
    final k = chars / 1000;
    if (k >= 100) return '${k.round()}k';
    return '${k.toStringAsFixed(1)}k';
  }
  @override
  String get toastContextCleared => 'Context cleared. The conversation starts from zero.';
  @override
  String toastClearFailed(String reason) => 'Clear failed: $reason';
  @override
  String get toastDream => 'Asked her to dream — the result is written to memory, visible in Logs';
  @override
  String toastTriggerFailed(String reason) => 'Trigger failed: $reason';
  @override
  String get toastDuplicateSend =>
      'Identical to the message just sent, so it was ignored — try again in a few seconds';
  @override
  String toastSendFailed(String reason) => 'Send failed: $reason';

  @override
  String get settingsTitle => 'Settings';
  @override
  String get settingsSubtitle => 'Status, channels, persona and local parameters';
  @override
  String get settingsSectionUi => 'Interface';
  @override
  String get settingsUiNote => 'Theme and window behaviour. Local only, never written to config.';
  @override
  String get instantApply => 'Applies immediately';
  @override
  String get settingsThemeMode => 'Theme';
  @override
  String get themeLight => 'Light';
  @override
  String get themeDark => 'Dark';
  @override
  String get settingsCurrentTheme => 'Current theme';
  @override
  String get settingsThemeNote =>
      'Local preference, applied immediately. Never written to config, never affects the render fingerprint.';
  @override
  String get settingsCloseToTray => 'Minimize to tray on close (keep running)';
  @override
  String get settingsCloseToTrayNote =>
      'If the tray icon is hidden by Windows, closing the window makes the UI impossible to find. '
      'With this off, the × button just exits (she keeps running).';
  @override
  String get settingsLanguage => 'Language';
  @override
  String get languageFollowSystem => 'Follow system';
  @override
  String get settingsLanguageNote =>
      'Language of the interface, applied immediately. Never written to config and never changes how she speaks.';

  @override
  String get settingsStringsOverride => 'Text overrides';
  @override
  String get settingsStringsOverrideNote =>
      'Edit that file to change the words on screen. Unlisted keys keep the built-in text; '
      'sentences with parameters (such as "Failed to load: …") are not overridable yet. '
      'Click "Reload text" to apply — no restart needed.';
  @override
  String get stringsOverridePathLabel => 'Override file';
  @override
  String get stringsOverrideOpen => 'Open text file';
  @override
  String get stringsOverrideReload => 'Reload text';
  @override
  String get stringsOverrideExport => 'Export current text as template';
  @override
  String get stringsOverrideNone => 'No overrides (built-in text)';
  @override
  String stringsOverrideLoaded(int zh, int en) => 'Loaded ${zh + en} override(s) (zh $zh / en $en)';
  @override
  String stringsOverrideFailed(String reason) => 'Parse failed: $reason';
  @override
  String stringsOverrideUnreadable(String detail) => 'Cannot read the file ($detail)';
  @override
  String stringsOverrideBadJson(String detail) => 'Invalid JSON ($detail)';
  @override
  String get stringsOverrideBadRoot =>
      'The top level is not a JSON object (expected {"zh": {…}, "en": {…}} or {"key": "text"})';
  @override
  String stringsOverrideIgnored(int count) =>
      '$count key(s) not applied (unknown names or non-string values; see the startup log)';
  @override
  String stringsOverrideExported(String path) => 'Template written to $path';
  @override
  String stringsOverrideExportFailed(String reason) => 'Could not write the template: $reason';
  @override
  String stringsOverrideOpenFailed(String path) => 'Could not open $path';

  @override
  String get settingsAnchorCaption => 'Sections';
  @override
  String get settingsNavModel => 'Model';
  @override
  String get settingsNavUi => 'Interface';
  @override
  String get settingsNavSpeak => 'Speech';
  @override
  String get settingsNavDeps => 'Dependencies';
  @override
  String get settingsNavProtocol => 'Protocol';
  @override
  String get settingsNavWebhook => 'Webhook';
  @override
  String get settingsNavMemory => 'Memory';
  @override
  String get settingsNavTrust => 'Trust scope';
  @override
  String get settingsNavSystem => 'System';
  @override
  String get settingsNavAccount => 'Account';
  @override
  String get settingsNavAbout => 'About';
  // ── Overview page ──
  @override
  String get overviewSubtitle => 'Current status, usage, and things waiting for you';
  @override
  String get overviewSectionAdvice => 'Suggestions';
  @override
  String get overviewSectionRecent => 'Recent events';
  @override
  String get overviewPersonaSeedAdvice =>
      'Persona assets are not initialized yet: IDENTITY.md is still the template. '
      'Fill in who she is and how she speaks.';
  @override
  String get overviewNoPendingCalls => 'Nothing is waiting for a decision right now';
  @override
  String get overviewTimerCancelTitle => 'Cancel this timer?';
  @override
  String get overviewTimerCancel => 'Cancel';
  @override
  String get overviewDeadDiscardTitle => 'Discard this dead letter?';
  @override
  String get overviewDeadDiscardConfirm => 'Discard';
  @override
  String get overviewDeadRequeue => 'Requeue';
  @override
  String get overviewDeadDiscard => 'Discard';
  @override
  String get overviewLoadFailedTitle => 'Could not load status data';
  @override
  String get overviewMarkSucceeded => 'Mark succeeded';
  @override
  String get overviewMarkFailed => 'Mark failed';
  @override
  String get overviewTodayUsage => 'Today';
  @override
  String get overviewCacheHitRate => 'Cache hit rate';
  @override
  String get overviewPending => 'Pending';
  @override
  String get overviewFailStreak => 'Fail streak';
  @override
  String get overviewActFallback => 'Open';
  @override
  String get overviewDeadLettersUnread => 'Dead-letter details are unavailable; refresh and look again.';
  @override
  String get overviewUnknownSession => 'Unknown chat';
  @override
  String get overviewChatTypeDirect => 'Direct';
  @override
  String get overviewChatTypeGroupAt => 'Group @';
  @override
  String get overviewChatTypeGroup => 'Group';
  @override
  String get overviewChatTypeGuild => 'Channel';
  @override
  String get overviewChatTypeUnknown => 'Unknown type';
  @override
  String get overviewExternalSessions => 'External chats';
  @override
  String get overviewExternalSessionsNote =>
      'Chats added through a message adapter. Messages the platform pushes to us go into the inbox; '
      'the agent reads them on her own.';
  @override
  String get overviewExternalSessionsLoading => 'Reading external chats…';
  @override
  String get overviewExternalSessionsErrorHint =>
      'Status and usage are unaffected; this card appears as soon as data arrives.';
  @override
  String get overviewNoAccumulatedMessages =>
      'No accumulated messages (the inbox is empty; messages in groups that do not @ her only arrive '
      'if the official bot pushes them to us first).';
  @override
  String get overviewLevelCritical => 'Critical';
  @override
  String get overviewLevelWarn => 'Warning';
  @override
  String get overviewLevelInfo => 'Info';
  @override
  String get overviewLevelUnknown => 'Unknown level';
  @override
  String get overviewFrameworkNote => 'Framework note';
  @override
  String get overviewFrameworkNotesLoading => 'Reading framework notes…';
  @override
  String get overviewFrameworkNotesErrorHint =>
      'Runtime is unaffected; injection warnings and alerts are still recorded in the event log.';
  @override
  String get overviewNoFrameworkNotes => 'Nothing needs your attention.';
  @override
  String get overviewTimers => 'Timers';
  @override
  String get overviewTimersNote =>
      'Wakes she scheduled herself (timer tool, action=set). They wake her when due; '
      'cancelling only works for timers that have not fired yet.';
  @override
  String get overviewNoTimers => 'No timers are scheduled right now.';
  @override
  String get overviewTimersErrorHint =>
      'It may have fired or been cancelled already; refresh to see the latest list.';
  @override
  String get overviewTimerUnknownTime => 'time unknown';
  @override
  String get overviewTimerRecurring => 'Recurring';
  @override
  String get overviewRecentEmpty => 'No events recorded yet.';
  @override
  String get overviewRecentEmptyAction => 'Wake her now';
  @override
  String get overviewRecentEmptyHint =>
      'After a wake or an incoming message, the latest events are listed here.';
  @override
  String get overviewJudgedByRule => 'rule';
  @override
  String get overviewJudgedByModel => 'model';
  @override
  String get overviewSessionsNotList => 'The response was not a chat list';
  @override
  String get overviewNotesNotList => 'The response was not a note list';
  @override
  String overviewAdviceLine(String title, String body) => '$title: $body';
  @override
  String overviewDeadLetterLine(int seq, int claimCount, String? stamp) =>
      'seq $seq · ${claimCount == 1 ? '1 claim' : '$claimCount claims'}${stamp == null ? '' : ' · $stamp'}';
  @override
  String overviewPendingCount(int count) =>
      count == 1 ? '1 waiting for a decision' : '$count waiting for a decision';
  @override
  String overviewTodayUsageTooltip(String exact) => 'Today: $exact';
  @override
  String overviewTimerCancelBody(String timerId) =>
      'Timer $timerId will be cancelled: it will no longer wake her when it fires.\n'
      'This cancellation is written to the log (timer/cancelled); if you cancel the wrong one, '
      'she has to schedule it again.';
  @override
  String overviewTimerCancelled(String timerId) =>
      'Timer $timerId cancelled: it will not wake her again';
  @override
  String overviewTimerCancelFailed(String timerId, String reason) =>
      'Could not cancel $timerId: $reason';
  @override
  String overviewTimerCancelToastFailed(String reason) => 'Cancel failed: $reason';
  @override
  String overviewMarkFailedToast(String reason) => 'Could not mark it: $reason';
  @override
  String overviewDeadRequeued(int seq) =>
      'Requeued seq $seq: it is back in the queue and will be claimed again on the next tick';
  @override
  String overviewDeadDiscardBody(int inputSeq) =>
      'seq $inputSeq will not be requeued and will not be executed — it leaves the pending queue.\n'
      'This decision is written to the log; the input itself stays in the event log for later '
      'inspection.';
  @override
  String overviewDeadDiscarded(int seq) =>
      'Discarded seq $seq: it will not be executed; the input stays in the log';
  @override
  String overviewDeadActionFailed(String verb, int seq, String reason) =>
      '$verb seq $seq failed: $reason';
  @override
  String overviewDeadActionToastFailed(String verb, String reason) => '$verb failed: $reason';
  @override
  String overviewHistoricalBadge(String label) =>
      label.isEmpty ? 'recovered · historical' : '$label · recovered · historical';
  @override
  String overviewSourceFramework(String? fingerprint) => fingerprint == null
      ? 'Source: the framework itself'
      : 'Source: the framework itself · $fingerprint';
  @override
  String overviewSourceChat(String who) => 'Source: $who';
  @override
  String overviewQuote(String text) => '“$text”';
  @override
  String overviewGroupsCount(int count) => count == 1 ? '1 group' : '$count groups';
  @override
  String overviewSinglesCount(int count) => count == 1 ? '1 direct chat' : '$count direct chats';
  @override
  String overviewOthersCount(int count) => count == 1 ? '1 other' : '$count others';
  @override
  String overviewUnreadTotal(int count) => '$count unread in total';
  @override
  String overviewMessagesSeen(int count) =>
      count == 1 ? '1 message received' : '$count messages received';
  @override
  String overviewUnreadBadge(int count) => '$count unread';
  @override
  String overviewTimersWaiting(int count) => count == 1 ? '1 waiting' : '$count waiting';
  @override
  String overviewTimerCron(String cron) => 'recurring $cron';
  @override
  String overviewTimerPayload(String payload) => 'Wakes with: $payload';
  @override
  String overviewExternalSessionsError(String reason) =>
      'Could not read external chats: $reason';
  @override
  String overviewFrameworkNotesError(String reason) =>
      'Could not read framework notes: $reason';
  @override
  String get settingsLaneHeavyLabel => 'Main loop (heavy)';
  @override
  String get settingsLaneLightLabel => 'Lightweight (light)';
  @override
  String get settingsLaneHeavyNote => 'The model the turn main loop uses';
  @override
  String get settingsLaneLightNote => 'The model used for necessity checks, compaction summaries, and guard classification';
  @override
  String get settingsDepSourceManaged => 'managed by the framework';
  @override
  String get settingsDepSourceSystemPath => 'system PATH';
  @override
  String get settingsDepVersionUnknown => 'version unknown';
  @override
  String get settingsDepPathUnknown => 'path unknown';
  @override
  String get settingsSysHostEmptyError => 'Listen address cannot be empty: an empty value means listening on all interfaces; not saved';
  @override
  String settingsSysEmptyError(String label) => '$label cannot be empty; not saved';
  @override
  String settingsSysIntRequired(String label) => '$label must be an integer; not saved';
  @override
  String settingsSysPortRange(String label) => '$label must be between 1 and 65535; not saved';
  @override
  String settingsSysMinOne(String label) => '$label must be at least 1; not saved';
  @override
  String settingsSysRatioRequired(String label) => '$label must be a decimal (0.8 means 80%); not saved';
  @override
  String settingsSysRatioRange(String label) => '$label is a ratio and must be within 0–1 (0 excluded); not saved';
  @override
  String settingsSysMin(String label, int lo) => '$label must be at least $lo; not saved';
  @override
  String settingsSysMax(String label, int hi) => '$label must be at most $hi; not saved';
  @override
  String get settingsSysHostLabel => 'Listen address';
  @override
  String get settingsSysHostNote => 'For local use, enter 127.0.0.1; the port must be 1–65535. Leaving it empty means listening on all interfaces, and it will be blocked.';
  @override
  String get settingsSysPortLabel => 'Port';
  @override
  String get settingsSysTimezoneLabel => 'Time zone';
  @override
  String get settingsSysTimezoneNote => 'IANA name, for example Asia/Shanghai. The budget "today" is split by it.';
  @override
  String get settingsSysStepToolsLabel => 'Budget · tool calls per step';
  @override
  String get settingsSysStepToolsNote => 'How many tool calls a single step may make.';
  @override
  String get settingsSysTurnStepsLabel => 'Budget · steps per turn';
  @override
  String get settingsSysTurnStepsNote => 'How many steps a turn may take.';
  @override
  String get settingsSysTaskTokensLabel => 'Budget · task token cap';
  @override
  String get settingsSysTaskTokensNote => 'Cumulative cap per task; enter the raw value — shorthand such as 20M is not accepted. The metric is non-cached tokens (what you actually pay for), not the usage on your bill.';
  @override
  String get settingsSysDailyTokensLabel => 'Budget · daily token cap';
  @override
  String get settingsSysDailyTokensNote => 'Cumulative cap per day, split by the time zone above. Same metric as the line above: only the part that missed the cache counts.';
  @override
  String get settingsSysSoftRatioLabel => 'Budget · soft threshold';
  @override
  String get settingsSysSoftRatioNote => 'A decimal from 0 to 1: 0.8 means 80%. At this line she gets a wrap-up warning; only crossing it hard-stops.';
  @override
  String get settingsSysFailStreakLabel => 'Budget · consecutive failure cap';
  @override
  String get settingsSysFailStreakNote => 'After this many consecutive failures she raises an alert and pauses.';
  @override
  String get settingsSysHeartbeatLabel => 'Heartbeat interval · mean (minutes)';
  @override
  String get settingsSysHeartbeatNote => 'How often she wakes on average — larger saves tokens, smaller wakes her more often. Both ends are still bounded by the floor and ceiling: they do not change with this number, she will not wake below the quiet floor, and she must wake by the ceiling.';
  @override
  String get settingsSysCompactionLabel => 'Context · compaction line (token estimate)';
  @override
  String get settingsSysCompactionNote => 'When the visible history reaches this many tokens (estimated), it is folded into a handover note; compaction only masks, never deletes. The unit is the estimator reading, not the provider count (the estimate runs about 1.65–1.66× lower). Enter the raw value: 200000-style notation is not accepted; lower = more frequent compaction, and each compaction costs a call of its own. Takes effect immediately, no restart needed.';
  @override
  String get settingsTrustConsequenceWorkspaceUnknown => 'She can only work inside the workspace directory configured in trust.workspaceRoot; reads, writes, and commands outside it are refused.';
  @override
  String settingsTrustConsequenceWorkspace(String root) => 'She can only work inside $root; reads, writes, and commands outside it are refused.';
  @override
  String get settingsTrustConsequenceFull => 'She can read and write files anywhere on this computer and run commands in any directory.';
  @override
  String get settingsTrustLabelWorkspace => 'Workspace only';
  @override
  String get settingsTrustLabelFull => 'Full trust';
  @override
  String get settingsWebhookStateNotObject => 'Could not read the credential state (the response was not an object)';
  @override
  String get settingsProtocolStateNotObject => 'Could not read the protocol-side state (the response was not an object)';
  @override
  String get settingsDepsReadFailed => 'Could not read the dependency report';
  @override
  String get settingsKeysReadFailed => 'Could not read the key status';
  @override
  String get settingsProjectionReadFailed => 'Could not read runtime data';
  @override
  String get settingsModelNameRequired => 'Model name cannot be empty; not saved';
  @override
  String get settingsBaseUrlRequired => 'Base URL cannot be empty; not saved';
  @override
  String get settingsNoChanges => 'Nothing to save';
  @override
  String get settingsWrittenModelSettings => 'model settings';
  @override
  String get settingsWrittenKey => 'API key';
  @override
  String get settingsRestartSuffix => '; takes effect after the process restarts';
  @override
  String settingsSaveFailed(String err) => 'Save failed: $err';
  @override
  String get settingsClearKeyBody => 'After clearing you have to enter it again; values from environment variables are not affected.';
  @override
  String get settingsClear => 'Clear';
  @override
  String get settingsKeyCleared => 'Local key cleared';
  @override
  String settingsClearFailed(String err) => 'Clear failed: $err';
  @override
  String get settingsConfigErrorHint => 'Model keys and system information need the active config. Make sure the main process is running.';
  @override
  String get settingsConfigUnavailable => 'Config unavailable.';
  @override
  String get settingsConfigUnavailableHint => 'The local service /api/config returned no config content.';
  @override
  String settingsKeysReadFailedHint(String keysError) => 'Could not read the key status ($keysError). The key badge is unavailable; model names and Base URLs can still be saved.';
  @override
  String get settingsConfigFallbackNote => 'config.json could not be read, so this page shows the config that is now in effect (saving still writes to the file).';
  @override
  String get settingsModelRestartNote => 'Changes above are not in effect yet: model names and endpoints are startup parameters and only take effect after the process restarts — until then she keeps using the ones from startup. The save itself succeeded; the fields show what is on disk.';
  @override
  String get settingsKeysNote => 'Keys are write-only: this page always shows a mask, and the full value is read once when the connection is established. Saving writes config.json and data/.keys.json and takes effect after the process restarts (environment variables win over files).';
  @override
  String get settingsKeyConfiguredHint => 'Configured; paste a new key to replace it';
  @override
  String get settingsKeySampleHint => 'sk-…';
  @override
  String get settingsModelName => 'Model name';
  @override
  String get settingsBaseUrlNote => 'API root address, without /responses.';
  @override
  String settingsKeyEnvNote(String envName) => 'The environment variable $envName wins; if it has no value the value here is used (written to data/.keys.json, write-only).';
  @override
  String get settingsClearKey => 'Clear key';
  @override
  String get settingsReading => 'Reading…';
  @override
  String get settingsStateReadFailed => 'Could not read the status';
  @override
  String get settingsNotConfigured => 'Not configured';
  @override
  String get settingsSpeakNote => 'The rhythm she speaks in: one piece at a time, with a gap between pieces. It only affects how delivery feels, not what she says.';
  @override
  String get settingsSpeakTyping => 'Typing rhythm';
  @override
  String get settingsSpeakTypingNote => 'On: messages are sent piece by piece according to how long the text would take to type, like a person typing (and the other side can cut in at any moment). Off: the whole message is sent at once and arrives as fast as possible.';
  @override
  String get settingsSpeakSpeed => 'Typing speed';
  @override
  String get settingsSpeakSpeedUnit => 'chars/min';
  @override
  String get settingsSpeakSpeedNote => 'Default 90 (a common speed for Chinese mobile typing). Larger means faster speech and shorter waits; range 30–600.';
  @override
  String get settingsCurrentlyActive => 'Currently in effect';
  @override
  String settingsSpeakTypingOn(String saved) => '$saved chars/min · sent piece by piece';
  @override
  String settingsSpeakTypingOff(String saved) => '$saved chars/min · sent all at once';
  @override
  String get settingsSpeakTypingEnabled => 'Typing rhythm enabled (takes effect after restart)';
  @override
  String get settingsSpeakTypingDisabled => 'Typing rhythm disabled (takes effect after restart)';
  @override
  String get settingsSpeakSpeedRange => 'Typing speed must be between 30 and 600';
  @override
  String get settingsSavedRestartNote => 'Saved (takes effect after restart)';
  @override
  String get settingsSavedLive => 'Saved; effective immediately (no restart needed)';
  @override
  String get settingsSavedRestart => 'Saved; takes effect after restart';
  @override
  String get settingsDepsAllReady => 'All ready';
  @override
  String get settingsDepsNote => 'External dependencies we recommend; the framework can install them in one step.';
  @override
  String settingsDepsReadFailedHint(String depsError) => 'Could not read the dependency report ($depsError). If you can neither install nor see the status, first check on the command line that the main process is running.';
  @override
  String get settingsDepsProbing => 'Probing this machine for pwsh / ripgrep / es.exe / python …';
  @override
  String get settingsDepsInstallLocation => 'Install location: <data dir>/tools/<name>/. It takes effect right after installing — the probe result is re-checked and refreshed after installation, so the next tool call uses the new engine.';
  @override
  String get settingsDepReadyManaged => 'ready · managed';
  @override
  String get settingsDepReadySystem => 'ready · system';
  @override
  String get settingsDepMismatch => 'version mismatch';
  @override
  String get settingsDepMissing => 'not installed';
  @override
  String get settingsDepNoAction => 'no action needed';
  @override
  String get settingsDepInstalling => 'installing…';
  @override
  String get settingsInstall => 'Install';
  @override
  String get settingsDownloadPage => 'Download page';
  @override
  String get settingsOpenDownloadPage => 'Open download page';
  @override
  String get settingsDownloadAndInstall => 'Download and install';
  @override
  String settingsInstallRequestFailed(String err) => 'Install request failed: $err';
  @override
  String get settingsStepDownloadFailed => 'download failed';
  @override
  String get settingsStepExtractFailed => 'extract failed';
  @override
  String get settingsStepVerifyFailed => 'post-install check failed';
  @override
  String get settingsStepInstallFailed => 'install failed';
  @override
  String settingsOpenedUrl(String url) => 'Opened with the default program: $url';
  @override
  String get settingsUnknown => 'unknown';
  @override
  String get settingsRestartRequired => 'restart required';
  @override
  String get settingsProtocolTitle => 'Protocol side (optional)';
  @override
  String get settingsProtocolNote => 'Optional: an OneBot protocol side launched by the framework, backed by a real QQ account. It is an independent inbound channel from the official bot; enabling one does not affect the other.';
  @override
  String settingsProtocolError(String protocolError) => 'Could not read the protocol-side state: $protocolError';
  @override
  String get settingsProtocolErrorHint => 'This card failing does not affect the other settings. First check that the main process is running, then retry. Until the state can be read, no switch, directory, or one-click install is offered here — that would mean writing a value you cannot see.';
  @override
  String get settingsProtocolLoading => 'Reading the protocol-side state…';
  @override
  String get settingsProtocolEmpty => 'The built-in protocol side is not configured yet.';
  @override
  String get settingsProtocolEmptyHint => 'Not enabling it changes nothing: the official bot channel is unaffected. To use this route, press "one-click install" below to install and configure it in one go.';
  @override
  String get settingsProtocolEnabled => 'Enable the built-in protocol side';
  @override
  String get settingsProtocolEnabledNote => 'The framework connects automatically at startup; when off you can fill in and configure both sides manually.';
  @override
  String get settingsInstallDir => 'Install directory';
  @override
  String get settingsInstallDirHint => '<protocol-side install directory>';
  @override
  String get settingsSaveDir => 'Save directory';
  @override
  String get settingsInstallDirNote => 'Protocol-side install directory (absolute path). After unpacking the Lite package, the entry index.mjs sits at this level, with no dist/ subdirectory; "one-click install" fills it in automatically.';
  @override
  String get settingsOneClickInstall => 'One-click install';
  @override
  String get settingsOneClickInstallNote => 'Downloads the Lite package from the official SnowLuma Release; if the automatic download fails, download it yourself and fill in the install directory. This package is not distributed with the framework and must not be used commercially.';
  @override
  String get settingsOneClickPrerequisite => 'Prerequisite: a QQ client is signed in on this machine (the bot account).';
  @override
  String get settingsInstallRunningNote => 'Downloading from the official Releases and unpacking. It is 4.6 MB and may take a minute or two depending on your connection — please wait, and do not press it again. The step-by-step log (which step, how much downloaded) is listed all at once when this step finishes: this endpoint is a synchronous request, not a stream, so progress lines cannot be interleaved.';
  @override
  String settingsInstallManualRoute(String protocolDownloadUrl) => 'You can also do it yourself: download the release package from $protocolDownloadUrl, unpack it, and fill that directory in above. This route is for when one-click install fails or you want to control the version yourself; the framework also downloads from the same address and does not distribute the package with itself (the licence is "source-visible, non-commercial", fine for personal use).';
  @override
  String get settingsInstallLogEmpty => 'Install log: (none this time — the failure happened before anything ran)';
  @override
  String get settingsInstallLog => 'Install log:';
  @override
  String get settingsInstalledNextTitle => 'Installed. Next: restart the service, then scan the QR code.';
  @override
  String get settingsInstalledNextBody => '① Restart the service: the running protocol-side instance was built from the config at startup, so only after a restart will it be launched with the config just written (the framework does not restart it for you — a failed self-restart leaves nothing behind).\n② Then scan the QR code: after the restart an "open panel" button appears on this card; open it, read and accept the terms of service and privacy policy there (that consent is legal in nature and you have to press it yourself), then connect QQ and scan the code. The first login needs the initial credentials it printed at startup — that line is already shown below the button (password masked), with "copy credential" next to it. Scanning connects your local QQ client; the framework does not manage the login state.';
  @override
  String get settingsInstallDirEmpty => '(no install directory yet)';
  @override
  String get settingsEntryFound => 'executable entry found';
  @override
  String get settingsEntryMissing => 'no executable entry in the directory';
  @override
  String get settingsEntryPendingRestart => 'entry will be checked after a restart';
  @override
  String settingsEndpointPoint(String wsUrl) => 'Endpoint: $wsUrl';
  @override
  String get settingsStart => 'Start';
  @override
  String get settingsStop => 'Stop';
  @override
  String get settingsOpenPanel => 'Open panel';
  @override
  String get settingsProtocolNotAttachedNote => 'This config was not read when the current process started: the framework does not hold an instance for it now, and "start/stop" only works after the process is restarted.';
  @override
  String get settingsChainProcess => '① Process';
  @override
  String get settingsChainUnobserved => 'not observed';
  @override
  String get settingsChainNoInstance => 'This process has no instance; nobody is watching this level';
  @override
  String get settingsChainNotRunning => 'not running';
  @override
  String get settingsChainNoPort => 'its panel port is not listening';
  @override
  String get settingsChainSpawned => 'spawned by this process';
  @override
  String get settingsChainDiscovered => 'already running before this process';
  @override
  String get settingsChainPortOnly => 'port only';
  @override
  String get settingsChainRunning => 'running';
  @override
  String settingsChainListening(String url) => '';
  @override
  String get settingsChainOneBotConfig => '② OneBot config';
  @override
  String get settingsChainWithToken => 'with token';
  @override
  String get settingsChainNoToken => 'no token (authentication off)';
  @override
  String get settingsChainPresent => 'present';
  @override
  String settingsChainEndpoint(String ws) => '';
  @override
  String get settingsChainUnreadable => 'unreadable';
  @override
  String get settingsChainMissing => 'missing';
  @override
  String get settingsChainMissingDetail => 'QQ not signed in: this file is only generated after login';
  @override
  String get settingsChainAdapter => '③ Adapter';
  @override
  String get settingsChainConnected => 'connected';
  @override
  String settingsChainDelivered(String delivered) => '';
  @override
  String get settingsChainReconnecting => 'reconnecting';
  @override
  String settingsChainBackoff(String attempts) => '';
  @override
  String get settingsChainNoEndpoint => 'no endpoint to connect';
  @override
  String get settingsChainNoEndpointDetail => 'The OneBot config of the protocol side has not appeared yet, and no address was filled in manually';
  @override
  String get settingsChainDisabled => 'disabled';
  @override
  String get settingsChainNotAssembled => 'not assembled';
  @override
  String get settingsChainNotAssembledDetail => 'This process has no OneBot adapter';
  @override
  String get settingsChainNoData => 'No data for this level';
  @override
  String settingsCredentialCaptured(String user, String masked) => 'Initial credential (captured from its output during this startup; user $user / password $masked)';
  @override
  String settingsCredentialFromLog(String user, String masked) => 'Initial credential (recovered from the framework\'s own startup trace: user $user / password $masked; if it has restarted since, this one is no longer valid)';
  @override
  String get settingsCredentialLost => 'The initial credential cannot be recovered: it prints it to its own output only once at startup (it is gone when the program closes). To get a usable one, let the framework restart it once (that run\'s output will be captured and shown here).';
  @override
  String get settingsConsentPending => 'The terms and privacy policy have not been accepted yet — until the panel is unlocked, the entry to QQ is locked.';
  @override
  String get settingsPasswordUnchanged => 'The initial password has not been changed: the first of the two gates is the password change, and the panel keeps asking you to do it first.';
  @override
  String settingsQrLoginAt(String webuiUrl) => '';
  @override
  String get settingsCredentialCopied => 'Credential copied (user + password)';
  @override
  String get settingsCopyCredential => 'Copy credential';
  @override
  String settingsManualDownloadGuide(String protocolDownloadUrl) => 'You can also do it yourself: download the release package from $protocolDownloadUrl, unpack it, and fill that directory in above. This route is for when one-click install fails or you want to control the version yourself; the framework also downloads from the same address and does not distribute the package with itself (the licence is "source-visible, non-commercial", fine for personal use).';
  @override
  String get settingsProtocolRestartNote => 'The change is written to config.json, but it takes effect only after the process restarts: the running protocol-side instance was built from the config at startup. Until the restart, the state shown here is still the one from this startup.';
  @override
  String get settingsInstallDirRequired => 'Install directory cannot be empty';
  @override
  String get settingsStartRequested => 'Start requested';
  @override
  String get settingsStopRequested => 'Stop requested';
  @override
  String settingsInstallRequestFailedHint(String err) => 'Install request failed: $err (the request never reached the install step; first check that the main process is running)';
  @override
  String get settingsOneClickFailed => 'One-click install failed: see the card for the reason';
  @override
  String get settingsInstallNoReason => 'Install failed and the server gave no reason (no detail in the response)';
  @override
  String get settingsInstalledOk => 'Installed';
  @override
  String get settingsInstalledConfigured => 'Installed and configured with it; restart and it is ready';
  @override
  String get settingsInstalledNotConfigured => 'Installed, but the automatic configuration did not go through: see the note on the card';
  @override
  String get settingsRestartSuffixParen => '(takes effect after the process restarts)';
  @override
  String get settingsGenerated => 'generated';
  @override
  String get settingsNotGenerated => 'not generated yet';
  @override
  String get settingsWebhookNote => 'Dedicated credential for external systems delivering to this instance (POST /webhook/*).';
  @override
  String settingsWebhookErrorHint(String webhookError) => 'Could not read the credential state ($webhookError). While the state is unreadable, do not press "regenerate" yet: rotation is irreversible (the old one becomes invalid immediately) and you do not know whether anyone is using it right now.';
  @override
  String get settingsWebhookLoading => 'Reading the webhook credential state…';
  @override
  String get settingsWebhookCurrent => 'Current credential';
  @override
  String settingsWebhookCurrentValue(String secretId, String createdAt) => '';
  @override
  String get settingsWebhookNotConfiguredNote => 'This channel currently returns 401 for everything (nobody can deliver without a credential). Press the button below to generate one.';
  @override
  String get settingsWebhookRotated => 'Last rotated';
  @override
  String get settingsWebhookNever => 'never';
  @override
  String settingsWebhookBy(String by) => '';
  @override
  String get settingsRegenerate => 'Regenerate';
  @override
  String get settingsGenerateWebhook => 'Generate webhook credential';
  @override
  String get settingsWebhookCredentialNote => '/webhook/* does not accept UI credentials (nor the transitional data/.ui-token): this channel accepts only the dedicated credential above. It is for external systems — they can deliver, but they cannot read anything under /api/*.';
  @override
  String get settingsRegenerateTitle => 'Regenerate the webhook credential';
  @override
  String get settingsRegenerateBody => 'The previous one becomes invalid immediately: external scripts already using it will start getting 401 — remember to switch the new credential over as well. The new credential is shown only once.';
  @override
  String get settingsNoTokenReturned => 'The server did not return the credential text; please press again. If this keeps happening, check the main process log';
  @override
  String get settingsWebhookRotatedNote => 'The previous one is now invalid (external scripts still using it will start getting 401).';
  @override
  String settingsGenerateFailed(String err) => '';
  @override
  String get settingsMemoryNote => 'Who maintains the long-term memory (MEMORIES/ and diary/): the framework for you, or she reads, writes, and organizes it herself.';
  @override
  String get settingsNotInEffect => 'not in effect yet';
  @override
  String get settingsMemoryEnableLabel => 'Let the framework manage memory automatically (off = she only knows these files exist; reading, writing, and organizing are all hers)';
  @override
  String get settingsMemoryEnableNote => 'On: the framework creates and maintains MEMORIES/INDEX.md, injects the index into a fixed block every turn, and organizes once a day.';
  @override
  String get settingsMemoryOn => 'framework-managed memory (index injected every turn, organized daily)';
  @override
  String get settingsMemoryOff => 'she manages it herself (the framework does not generate, inject, or organize)';
  @override
  String get settingsMemoryUnaffectedNote => 'Two paths are not affected by this switch: MEMORIES/aliases.md takes part in "who is talking / watch list", which belongs to the channel side; STATE.md (her current state) is a separate layer.';
  @override
  String get settingsMemoryRestartNote => 'This setting is read when the process starts: saving writes config.json and takes effect after a restart. Turning it off deletes no files.';
  @override
  String get settingsMemoryDetail => 'With it off the framework does not generate, inject, or organize, but she can still read and write those files herself. Why keep this switch: to give people who want the agent to manage its own memory a clean path. The daily tidy-up time is set by wake.memoryMaintainCron (once a day by default): stale running notes are merged into facts.md and a diary/ entry is written. The !pinned section and item TTL of facts.md are also maintained by the framework.';
  @override
  String get settingsMemoryCost => 'The cost: she may forget to tidy up, facts.md keeps growing, and the index stops updating — all of that becomes hers.';
  @override
  String get settingsMemoryOnSaved => 'Changed to framework-managed memory (takes effect after restart)';
  @override
  String get settingsMemoryOffSaved => 'Changed to self-managed memory (takes effect after restart)';
  @override
  String get settingsTrustNote => 'Her working boundary: the whole computer, or a single workspace directory. Crossing it is a refusal, not a reminder.';
  @override
  String get settingsTrustReachLabel => 'How far she can reach';
  @override
  String get settingsTrustReachNote => 'What each level governs is written in the option itself; changing to a level applies that level\'s consequences.';
  @override
  String get settingsTrustWorkspaceUnknownPath => 'Workspace only (path not read)';
  @override
  String settingsTrustWorkspaceValue(String root) => '';
  @override
  String get settingsTrustFullValue => 'Full trust (the whole computer)';
  @override
  String get settingsTrustPendingNote => 'The level chosen above is not in effect yet: it is written on disk, but the running process still uses the one read at startup — it takes effect after a restart. Until then she keeps working under the level currently in effect.';
  @override
  String get settingsTrustRootNote => 'The workspace is computed by the server (default <config dir>/workspace) and is not filled in on this page: writing the same boundary in two places is how you end up with "the config says A but it actually blocks at B".';
  @override
  String get settingsTrustBoundaryNote => 'It is a boundary, not a reminder: reads, writes, and commands outside it are refused.';
  @override
  String get settingsTrustRulesDetail => 'It governs the fs tool family (safe_read / safe_write / safe_edit / rg_search etc.) and pwsh: the former is judged through the same path, and the latter\'s workdir is governed together with paths in the command line. It is one of three independent gates along with the destructive switch and the pwsh command blacklist — this one governs scope and does not replace the other two.\nWhy full trust is the default: she is an unattended resident agent, and "being able to go find, fix, and install things herself" is how she exists; shutting her into an empty directory by default would leave most of her abilities unusable out of the box.';
  @override
  String get settingsTrustFullTitle => 'Switch to full trust';
  @override
  String get settingsTrustFullConfirmTail => 'This is a boundary; removing it means she can really do all of the above. Are you sure?';
  @override
  String get settingsTrustWorkspaceSaved => 'Changed to workspace only; reads, writes, and commands outside it will be refused (takes effect after the process restarts)';
  @override
  String get settingsTrustFullSaved => 'Changed to full trust (takes effect after the process restarts)';
  @override
  String get settingsSystemNote => 'The listen address, time zone, six budgets and heartbeat are all startup parameters of this process: change them here, save to config.json, and they take effect after a restart. The compaction line is the exception — it takes effect as soon as it is written (the server also updates the in-memory copy in the same critical section).';
  @override
  String get settingsDataDir => 'Data directory';
  @override
  String get settingsDataDirNote => 'The path fixed at startup: the event log, persona assets, and keys all live under it, and changing it means the next process starts from an empty directory.';
  @override
  String get settingsSystemFootnote => 'The data directory cannot be changed here (it decides where everything she owns lives, and it is fixed at process startup); the other fields take effect after the process restarts — except the compaction line, which takes over immediately after saving.';
  @override
  String get settingsLiveNow => 'effective immediately';
  @override
  String get settingsEdit => 'Edit';
  @override
  String get settingsAccountNote => 'The credential used to get into this UI: change password and sign out.';
  @override
  String get settingsAccountLegacyBadge => 'legacy shared token';
  @override
  String get settingsAccountSessionBadge => 'session credential';
  @override
  String get settingsAccountInstance => 'Current instance';
  @override
  String get settingsAccountInstanceNote => 'Credentials are stored per instance in separate files (%APPDATA%\\Irmia\\sessions): opening a second instance on the same machine will not replace this one.';
  @override
  String get settingsAccountLegacyNote => 'This one uses the legacy shared token (this instance has never had a password), and the server does not accept the "session" it produces: neither changing the password nor signing out can work. Set a password first, then sign in and out by session.';
  @override
  String get settingsChangePassword => 'Change password';
  @override
  String get settingsLogout => 'Sign out';
  @override
  String get settingsSetPasswordFirst => 'Set a password first';
  @override
  String get settingsPasswordChanged => 'Password changed; this UI is now using the new credential';
  @override
  String get settingsLogoutBody => 'Leave this UI and go back to the gate; the session credential on this machine will be cleared — next time you will need the password.';
  @override
  String get settingsAboutNote => 'UI version and runtime projection data.';
  @override
  String get settingsAboutBadge => 'Flutter native UI';
  @override
  String get settingsVersionLabel => 'Version';
  @override
  String get settingsGuardedDays => 'Days guarded';
  @override
  String get settingsWatermark => 'Event watermark';
  @override
  String settingsProjectionReadFailedHint(String projError) => '';
  @override
  String get settingsProjectionFootnote => 'Days guarded and the event watermark come from the runtime projection (GET /api/projection) and are measured values.';
  @override
  String settingsDaysCount(String days) => '';
  @override
  String settingsDaysSince(String days, String stamp) => '';
  @override
  String get settingsDestructivePolicy => 'destructive tool policy';
  @override
  String get settingsModify => 'Change';
  @override
  String get settingsPolicyNoneOption => 'All off (she cannot see any of them)';
  @override
  String get settingsPolicyAllOption => 'All on (everything in the list is granted)';
  @override
  String get settingsPolicyListOption => 'By list (only the ones you check)';
  @override
  String get settingsPolicyListTitle => 'Allow by list';
  @override
  String get settingsPolicyNoTools => 'Could not get the tool list (the registry may not be up yet) — check "Extensions · Tools" first and come back.';
  @override
  String get settingsDestructiveTitle => 'Change the destructive tool policy';
  @override
  String get settingsDestructiveRelaxedBody => 'This lets her see and call tools that change this machine (writing files, running commands, etc.). Are you sure?';
  @override
  String get settingsDestructiveRestrictedBody => 'Back to the restricted level: she will not see the destructive tools (safer). Are you sure?';
  @override
  String get settingsPolicyAll => 'all on';
  @override
  String get settingsPolicyListEmpty => 'by list (empty)';
  @override
  String get settingsPolicyNone => 'all off';
  // ── Settings page: hand-written members ──
  @override
  String get settingsListAnd => ' and ';
  @override
  String settingsSaved(String written, String restart) => 'Saved $written$restart';
  @override
  String settingsClearKeyTitle(String laneLabel) => 'Clear key · $laneLabel';
  @override
  String settingsKeyConfiguredMask(String mask) => 'Configured $mask';
  @override
  String settingsDepPipUnavailable(String? reason) =>
      'pip: unavailable${reason == null ? '' : ' ($reason)'}';
  @override
  String settingsInstallConfirmBody(String managedDir) =>
      'Downloads an archive from the official address, unpacks it to $managedDir, and re-checks '
      'immediately. Once installed the agent can use it (rg_search / es_search get registered with '
      'it; for Python it also guides pip so she can pip install extra capabilities herself).';
  @override
  String settingsDepReadyToast(String label, String version) => '$label is ready ($version)';
  @override
  String settingsStepErrorToast(String step, String error) => '$step: $error';
  @override
  String settingsNoDownloadPage(String hint) => 'No download page for this one; install it like this: $hint';
  @override
  String settingsOpenUrlFailed(String url, String? hint) =>
      'Could not open a browser; the address is $url${hint == null ? '' : ' ($hint)'}';
  @override
  String settingsInstalledVersion(String? version) => 'Installed${version == null ? '' : ' $version'}';
  @override
  String settingsWriteErrorNote(String writeError) =>
      'The automatic configuration was not written: $writeError. The installed directory has already '
      'been filled into "install directory" below; press "save directory", turn on "enable the '
      'built-in protocol side", and you are done (also takes effect after a restart).';
  @override
  String settingsChainSince(String when) => 'since $when';
  @override
  String settingsChainUnreadableDetail(String path) =>
      'The file is there ($path) but the endpoint could not be parsed — someone has to fix it';
  @override
  String settingsProtocolToggled(bool on, bool restart) =>
      '${on ? 'Enabled' : 'Disabled'} the built-in protocol side'
      '${restart ? ' (takes effect after restart)' : ''}';
  @override
  String settingsInstallDirSaved(String saved, bool restart) =>
      'Install directory saved: $saved${restart ? ' (takes effect after restart)' : ''}';
  @override
  String settingsProtocolActionFailed(bool start, String err) =>
      '${start ? 'Start' : 'Stop'} request failed: $err';
  @override
  String settingsWebhookFileNote(String file) =>
      'Credential file: $file (only its sha256 is on disk: the plaintext appeared on screen only '
      'when you pressed the button, and nobody can read it back afterwards).';
  @override
  String settingsTrustFullBody(String consequence) => 'After switching to full trust: $consequence';
  @override
  String settingsPolicyListCount(int count) => 'By list ($count items)';
  @override
  String get settingsUnknownReason => 'unknown reason';
  @override
  String get settingsSeeOfficialDocs => 'see the official documentation';
  @override
  String get settingsWebhookCurlTokenPlaceholder => '<dedicated credential>';
  @override
  String get settingsWebhookCurlSampleText => 'Disk is almost full';
  @override
  String settingsDepsSuggested(int count) => '$count recommended installation(s)';
  @override
  String settingsDepPipReady(String version) => 'pip $version (she can pip install extra capabilities herself)';
  @override
  String settingsDepPurposeImpact(String purpose, String impact) => '$purpose. $impact';
  @override
  String settingsInstallTitle(String label) => 'Install $label';
  @override
  String settingsPolicySave(int count) => 'Save ($count items)';
  @override
  String settingsInstallHead(bool ok, String? version, bool configured) => ok
      ? 'Installed${version == null ? '' : ' $version'}${configured ? ', configured with it; restart and it is ready.' : ', but the automatic configuration did not go through.'}'
      : 'Install failed';

}

/// 按具体语言取文案表。[AppLanguage.system] 必须先经 [AppLanguage.resolve]。
AppStrings stringsFor(AppLanguage language) => switch (language) {
      AppLanguage.en => const EnStrings(),
      AppLanguage.system || AppLanguage.zh => const ZhStrings(),
    };

/// 系统 locale → 具体语言（只有**入口**调它一次，见 `main.dart`）
AppLanguage resolveSystemLanguage(Locale systemLocale) =>
    AppLanguage.system.resolve(systemLocale);
