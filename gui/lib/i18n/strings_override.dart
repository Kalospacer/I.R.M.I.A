/// 文案覆盖层：让用户**直接改界面上的字**，不碰代码、不改后端配置。
///
/// 这是 i18n 的**第三层**，不是旁路 hack：
///   1. `app_strings.dart` —— 抽象接口 [AppStrings]（键名编译期检查）+ 两份默认实现
///      （[ZhStrings] / [EnStrings]）；
///   2. `strings_scope.dart` —— 把文案表注入 widget 树的运行时那一半；
///   3. **本文件** —— 覆盖层：同一个 [AppStrings] 接口上的一个装饰器
///      [OverriddenStrings]，页面用 `IrmiaStrings.of(context)` 一行不改就吃到覆盖。
///
/// 解析顺序只有一条：**覆盖值 > `ZhStrings`/`EnStrings` 默认值**（见 [resolveStrings]）。
/// 覆盖文件里没写的键，回默认值；整份文件不存在 / 读不动 / JSON 坏，回默认值且**不崩**。
///
/// ## 文件在哪、长什么样
///
/// `%APPDATA%\Irmia\strings-override.json`（[stringsOverridePath]），两种形状都认：
///
/// ```json
/// { "zh": { "navChat": "闲聊" }, "en": { "navChat": "Gossip" } }   // 分语言段（主形状）
/// ```
/// ```json
/// { "navChat": "闲聊" }                                            // 扁平 = 只覆盖当前语言
/// ```
///
/// 值里的字符串**原样**上屏（不做 Markdown、不做 ${} 插值）。键名就是 [AppStrings] 的
/// getter 名（`navChat`、`settingsLanguage`…），完整清单可以用设置页的
/// 「导出当前文案为模板」拿到（[exportStringsTemplate] 写 `strings-override.template.json`）。
///
/// ## 三条边界（都是刻意的）
///
/// 1. **只有无参 getter 能覆盖**（= [stringsAsMap] 的键，导出模板就是这份清单）。
///    带参句子（`loadFailed(reason)` 那一族）由"前缀 + 参数"拼成，覆盖文件里没有参数
///    可填的位置；写它们的键会被当成不认识的键忽略，并在日志里点出来（不会静默失效）。
/// 2. **未知键只忽略、不崩**：拼错的键会进 [StringsOverrideSnapshot.ignored]，并落到
///    控制台/启动日志（[loadStringsOverride] 里 `debugPrint`），设置页那行状态也报条数。
/// 3. **覆盖文件不进 git、不进包、不改后端**：它是本机的一份"用户自己的文案"，
///    与 `ui-state.json` 同族（界面偏好），跟服务端 `config.json` 没有关系。
///
/// 覆盖层自己的提示文案（设置页那几条）也在 [AppStrings] 里，所以**它们也能被覆盖**：
/// 用户嫌"重新载入文案"这句话不顺眼，改 `stringsOverrideReload` 就行，走的是同一条链。
///
/// ## 重新载入**不重启**
///
/// [loadStringsOverride] 每次产出一个新的不可变快照（[StringsOverrideSnapshot]）灌进
/// [stringsOverrideState]；根的 `MaterialApp` 监听它重建，`IrmiaStrings` 靠
/// [AppStrings.revision] 让读过文案的 widget 跟着重建——整棵树不重建（状态都在），
/// 界面上的字换掉。设置页那颗「重新载入文案」调的就是 [reloadStringsOverride]。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'app_strings.dart';

/// 覆盖文件名（放在 `%APPDATA%\Irmia\` 下）
const String kStringsOverrideFileName = 'strings-override.json';

/// 导出的模板文件名（与覆盖文件同目录：照着改、改完另存成 [kStringsOverrideFileName]）
const String kStringsTemplateFileName = 'strings-override.template.json';

/// 覆盖文件路径的测试替身（与 `ui_state.dart` 的 `stateFileOverride` 同族）。
///
/// 用例把它指到临时目录，免得踩真实 `%APPDATA%` 里的那一份；`null` = 用真机路径。
String? stringsOverrideFileOverride;

/// 覆盖文件所在目录：`%APPDATA%\Irmia`（读不到 `%APPDATA%` 时落到系统临时目录）。
String stringsOverrideDir() {
  final override = stringsOverrideFileOverride;
  if (override != null && override.isNotEmpty) return File(override).parent.path;
  final appData = Platform.environment['APPDATA'] ?? Directory.systemTemp.path;
  return '$appData${Platform.pathSeparator}Irmia';
}

/// 覆盖文件的完整路径（设置页显示的那一行就是它）
String stringsOverridePath() =>
    '${stringsOverrideDir()}${Platform.pathSeparator}$kStringsOverrideFileName';

/// 导出模板的完整路径（与覆盖文件同目录）
String stringsTemplatePath() =>
    '${stringsOverrideDir()}${Platform.pathSeparator}$kStringsTemplateFileName';

/// 覆盖文件"没生效"的三种结局。
///
/// 存的是**种类**不是那句话：界面上的措辞属于 `AppStrings`（跟着语言走、也能被覆盖），
/// 快照只记"哪一类失败 + 系统给的细节"，渲染时由 [stringsOverrideStatusLine] 拼。
enum StringsOverrideError {
  /// 文件在，但读不出来（权限、被独占、不是 UTF-8 文本…）
  unreadable,

  /// 内容不是合法 JSON
  badJson,

  /// 是 JSON，但顶层既不是 `{ "zh": …, "en": … }` 也不是扁平键值
  badRoot,
}

/// 一次加载的结果（**不可变**）。换它 = 换 [stringsOverrideState] 的值 = 界面重建。
@immutable
class StringsOverrideSnapshot {
  const StringsOverrideSnapshot({
    required this.language,
    required this.revision,
    this.filePath = '',
    this.exists = false,
    this.zh = const <String, String>{},
    this.en = const <String, String>{},
    this.ignored = const <String>[],
    this.errorKind,
    this.errorDetail = '',
  });

  /// 这次加载按哪种语言解释**扁平**形状（分语言段的形状与它无关）。
  ///
  /// 扁平形状的语义是"只覆盖当前语言"（见文件头），所以它必须知道"当前"是哪种；
  /// 解析失败 / 文件不存在时它也记着，好让 [reloadStringsOverride] 不需要再问一遍。
  final AppLanguage language;

  /// 覆盖层的版次（0 = 从未加载过；每次加载 +1）。[AppStrings.revision] 取它。
  final int revision;

  /// 这次读的是哪个文件（绝对路径；文件不存在时也记着，设置页要显示它）
  final String filePath;

  /// 文件在不在（不存在 = 没启用覆盖，不是错误）
  final bool exists;

  /// 中文段的覆盖值（**已过滤**：只含认识的键）
  final Map<String, String> zh;

  /// 英文段的覆盖值（同上）
  final Map<String, String> en;

  /// 没被采用的条目（不认识的键 / 值不是字符串），一条一句**给人读的现场**
  /// （`zh.navChat: unknown key`——文件路径与键名是事实，措辞不进 UI 文案层）。
  final List<String> ignored;

  /// 失败的种类（`null` = 没失败）。失败时 [zh]/[en] 都是空的 ⇒ 回默认文案
  final StringsOverrideError? errorKind;

  /// 失败的细节（系统给的那句话，或 JSON 解析器的说明）；[errorKind] 为 null 时是空串
  final String errorDetail;

  /// 一共生效了几条
  int get total => zh.length + en.length;

  /// 有没有失败
  bool get failed => errorKind != null;

  /// 某种语言这一段（`system` 只会落到 zh 那一份上——真机上它早被解析掉了）
  Map<String, String> forLanguage(AppLanguage language) =>
      language == AppLanguage.en ? en : zh;

  /// 把这一份覆盖套到 [base] 上（空覆盖直接回 base：没配覆盖的机器与加这一层之前等价）
  AppStrings overridesFor(AppStrings base) {
    final overrides = forLanguage(base.language);
    if (overrides.isEmpty) return base;
    return OverriddenStrings(base: base, overrides: overrides, revision: revision);
  }
}

/// 当前覆盖层（**换值 = 通知**：界的根与设置页那行状态都听它）。
///
/// 默认值 = "从没加载过、什么都没覆盖"：不碰盘、不读环境变量，widget 测试因此是确定的。
final ValueNotifier<StringsOverrideSnapshot> stringsOverrideState =
    ValueNotifier<StringsOverrideSnapshot>(
  const StringsOverrideSnapshot(language: AppLanguage.zh, revision: 0),
);

/// 覆盖层的版次计数器（每次 [loadStringsOverride] +1，含失败的那些——状态行要跟着变）
int _generation = 0;

/// **解析顺序**：覆盖值 > `ZhStrings`/`EnStrings` 默认值。
///
/// 这是全仓唯一一处"把覆盖套上去"的地方：`strings_scope.dart` 的 `currentStrings`
/// 与 `app.dart` 的根 `MaterialApp` 都走它，所以页面一行不改就吃到覆盖。
AppStrings resolveStrings(AppLanguage language) =>
    stringsOverrideState.value.overridesFor(stringsFor(language));

/// 从盘上读一次覆盖（**启动时一次**，见 `main.dart`）。
///
/// [language] 只对**扁平**形状有意义（"只覆盖当前语言"的"当前"）。失败一律静默回默认：
/// 文件不存在 / 读不动 / JSON 坏 / 顶层不是对象，都只把 [StringsOverrideSnapshot.errorKind]
/// 填上，**不抛**。未知键进 [StringsOverrideSnapshot.ignored] 并打到控制台。
Future<StringsOverrideSnapshot> loadStringsOverride({
  required AppLanguage language,
}) async {
  final path = stringsOverridePath();
  final revision = ++_generation;

  StringsOverrideSnapshot publish(StringsOverrideSnapshot snapshot) {
    stringsOverrideState.value = snapshot;
    _logSnapshot(snapshot);
    return snapshot;
  }

  final file = File(path);
  if (!await file.exists()) {
    // 没有文件 = 没启用覆盖。这不是错误：界面上照旧显示默认文案。
    return publish(StringsOverrideSnapshot(
      language: language,
      revision: revision,
      filePath: path,
    ));
  }

  String raw;
  try {
    raw = await file.readAsString();
  } catch (err) {
    return publish(StringsOverrideSnapshot(
      language: language,
      revision: revision,
      filePath: path,
      exists: true,
      errorKind: StringsOverrideError.unreadable,
      errorDetail: '$err',
    ));
  }
  // 记事本另存的 UTF-8 可能带 BOM（`\uFEFF`）：jsonDecode 认不出它，先剥掉
  if (raw.startsWith('\uFEFF')) raw = raw.substring(1);

  Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } catch (err) {
    return publish(StringsOverrideSnapshot(
      language: language,
      revision: revision,
      filePath: path,
      exists: true,
      errorKind: StringsOverrideError.badJson,
      errorDetail: err is FormatException ? (err.message) : '$err',
    ));
  }
  if (decoded is! Map) {
    return publish(StringsOverrideSnapshot(
      language: language,
      revision: revision,
      filePath: path,
      exists: true,
      errorKind: StringsOverrideError.badRoot,
    ));
  }

  final zh = <String, String>{};
  final en = <String, String>{};
  final ignored = <String>[];
  // 有 zh / en 任意一段就是"分语言"形状；否则整份当扁平（只覆盖 [language] 那一种）
  final sectioned = decoded.containsKey('zh') || decoded.containsKey('en');
  if (sectioned) {
    for (final entry in decoded.entries) {
      final section = '${entry.key}';
      if (section != 'zh' && section != 'en') {
        ignored.add('$section: unknown section (only zh / en)');
        continue;
      }
      final value = entry.value;
      if (value is! Map) {
        ignored.add('$section: section is not an object');
        continue;
      }
      _collect(section, value, section == 'en' ? en : zh, ignored);
    }
  } else {
    _collect(language.languageCode, decoded, language == AppLanguage.en ? en : zh, ignored);
  }

  return publish(StringsOverrideSnapshot(
    language: language,
    revision: revision,
    filePath: path,
    exists: true,
    zh: zh,
    en: en,
    ignored: ignored,
  ));
}

/// 重新读一次覆盖（设置页那颗「重新载入文案」）。**不重启界面**：
/// 换一下 [stringsOverrideState] 的值，根的 `MaterialApp` 与设置页那行状态就跟着重建。
///
/// [language] 省略时沿用上一次加载的语言（启动时由 `main.dart` 给对）。
Future<StringsOverrideSnapshot> reloadStringsOverride({AppLanguage? language}) =>
    loadStringsOverride(language: language ?? stringsOverrideState.value.language);

/// 设置页状态行的那一句话（三态的唯一拼装点；`test/strings_override_test.dart` 钉着它）。
///
/// 线索只有三条：解析失败 / 没有覆盖 / 已加载 N 条。**"有键没被采用"不在这句里**：
/// 它是旁注，页面另起一行（[StringsOverrideSnapshot.ignored] 非空时）。
///
/// [s] 是**当前**那份文案表：失败原因在这里才变成人话（快照只记种类与细节），
/// 所以换语言之后同一份失败记录会跟着换措辞。
String stringsOverrideStatusLine(AppStrings s, StringsOverrideSnapshot snapshot) {
  final reason = switch (snapshot.errorKind) {
    null => null,
    StringsOverrideError.unreadable => s.stringsOverrideUnreadable(snapshot.errorDetail),
    StringsOverrideError.badJson => s.stringsOverrideBadJson(snapshot.errorDetail),
    StringsOverrideError.badRoot => s.stringsOverrideBadRoot,
  };
  if (reason != null) return s.stringsOverrideFailed(reason);
  if (snapshot.total == 0) return s.stringsOverrideNone;
  return s.stringsOverrideLoaded(snapshot.zh.length, snapshot.en.length);
}

/// 把**当前语言**的全部文案导成模板（设置页那颗「导出当前文案为模板」）。
///
/// 写到 [stringsTemplatePath]（与覆盖文件同目录），返回写到的路径。
/// 内容 = **此刻生效**的那一份（含已经生效的覆盖值）——照它改、存成
/// [kStringsOverrideFileName] 就是一份合法的覆盖文件。
///
/// 只导出无参 getter（键表见 [stringsAsMap]）：带参句子没有"一个值"可写（见文件头第一条边界）。
/// 写盘失败时抛 [FileSystemException] 一族的异常，由调用方把它说给人听。
Future<String> exportStringsTemplate({AppLanguage? language}) async {
  final target = language ?? stringsOverrideState.value.language;
  final values = stringsAsMap(resolveStrings(target));
  final path = stringsTemplatePath();
  final file = File(path);
  await file.parent.create(recursive: true);
  // 缩进两格 + 结尾换行：这是给人改的文件，不是机器读的压缩包
  final payload = <String, dynamic>{target.languageCode: values};
  await file.writeAsString('${const JsonEncoder.withIndent('  ').convert(payload)}\n');
  return path;
}

/// 一份文案表的**全部键值**（键 = [AppStrings] 的无参 getter 名）。
///
/// 两个用途：导出模板；以及"这个键认不认识"的判据（[stringOverrideKeys]）。
/// **[AppStrings] 加了新 getter 就必须在这里补一条**——漏了会有
/// `test/strings_override_test.dart` 那条"模板键数 = 接口键数"当场红。
Map<String, String> stringsAsMap(AppStrings s) => <String, String>{
    'retry': s.retry,
    'cancel': s.cancel,
    'confirm': s.confirm,
    'save': s.save,
    'loading': s.loading,
    'error': s.error,
    'empty': s.empty,
    'collapse': s.collapse,
    'settingsLoadingConfig': s.settingsLoadingConfig,
    'navChat': s.navChat,
    'navSettings': s.navSettings,
    'navOverview': s.navOverview,
    'navChannels': s.navChannels,
    'navExtensions': s.navExtensions,
    'navPersona': s.navPersona,
    'navSchedule': s.navSchedule,
    'navMemory': s.navMemory,
    'navLogs': s.navLogs,
    'navMore': s.navMore,
    'overviewConfigGuide': s.overviewConfigGuide,
    'restartSentWithGui': s.restartSentWithGui,
    'restartSentBackendOnly': s.restartSentBackendOnly,
    'restartNoConclusion': s.restartNoConclusion,
    'restartBackReady': s.restartBackReady,
    'restartNeverWentDown': s.restartNeverWentDown,
    'trayShow': s.trayShow,
    'trayHide': s.trayHide,
    'trayRestart': s.trayRestart,
    'trayQuitUi': s.trayQuitUi,
    'trayQuitAll': s.trayQuitAll,
    'quitAllConfirmTitle': s.quitAllConfirmTitle,
    'quitAllConfirmLabel': s.quitAllConfirmLabel,
    'quitAllWorking': s.quitAllWorking,
    'quitAllDone': s.quitAllDone,
    'onboardingManualSaved': s.onboardingManualSaved,
    'onboardingManualNoChanges': s.onboardingManualNoChanges,
    'onboardingStepNameTitle': s.onboardingStepNameTitle,
    'onboardingStepNameNote': s.onboardingStepNameNote,
    'onboardingStepApiTitle': s.onboardingStepApiTitle,
    'onboardingStepApiNote': s.onboardingStepApiNote,
    'onboardingStepChannelTitle': s.onboardingStepChannelTitle,
    'onboardingStepChannelNote': s.onboardingStepChannelNote,
    'onboardingStepPersonaTitle': s.onboardingStepPersonaTitle,
    'onboardingStepPersonaNote': s.onboardingStepPersonaNote,
    'onboardingStepTrustTitle': s.onboardingStepTrustTitle,
    'onboardingStepTrustNote': s.onboardingStepTrustNote,
    'onboardingApiRecommendLead': s.onboardingApiRecommendLead,
    'onboardingApiRecommendModel': s.onboardingApiRecommendModel,
    'onboardingApiRegisterKey': s.onboardingApiRegisterKey,
    'onboardingApiRecommendJoin': s.onboardingApiRecommendJoin,
    'onboardingChannelRecommendLead': s.onboardingChannelRecommendLead,
    'onboardingChannelRecommendQq': s.onboardingChannelRecommendQq,
    'onboardingChannelRecommendTail': s.onboardingChannelRecommendTail,
    'onboardingQqTileDetail': s.onboardingQqTileDetail,
    'onboardingQqCredentialsTitle': s.onboardingQqCredentialsTitle,
    'onboardingQqAppIdLabel': s.onboardingQqAppIdLabel,
    'onboardingQqAppIdHint': s.onboardingQqAppIdHint,
    'onboardingQqAppSecretLabel': s.onboardingQqAppSecretLabel,
    'onboardingQqAppSecretHint': s.onboardingQqAppSecretHint,
    'onboardingQqCredentialsNote': s.onboardingQqCredentialsNote,
    'onboardingStepNameHint': s.onboardingStepNameHint,
    'onboardingKeywordsHint': s.onboardingKeywordsHint,
    'onboardingPersonaHint': s.onboardingPersonaHint,
    'onboardingTrustNoteSame': s.onboardingTrustNoteSame,
    'onboardingTrustNoteChanged': s.onboardingTrustNoteChanged,
    'onboardingStepDepsTitle': s.onboardingStepDepsTitle,
    'onboardingStepDepsNote': s.onboardingStepDepsNote,
    'onboardingDepsInstallLabel': s.onboardingDepsInstallLabel,
    'onboardingDepsAllReady': s.onboardingDepsAllReady,
    'onboardingDepsStatusReady': s.onboardingDepsStatusReady,
    'onboardingDepsStatusMissing': s.onboardingDepsStatusMissing,
    'onboardingDepsItemRunning': s.onboardingDepsItemRunning,
    'onboardingDepsItemOk': s.onboardingDepsItemOk,
    'onboardingDepsRetry': s.onboardingDepsRetry,
    'onboardingDepsUnavailable': s.onboardingDepsUnavailable,
    'onboardingRestartTitle': s.onboardingRestartTitle,
    'onboardingRestartBody': s.onboardingRestartBody,
    'onboardingRestartNow': s.onboardingRestartNow,
    'onboardingRestartLater': s.onboardingRestartLater,
    'chatTitle': s.chatTitle,
    'chatSubtitle': s.chatSubtitle,
    'composerHint': s.composerHint,
    'jumpToLatest': s.jumpToLatest,
    'jumpToLatestNew': s.jumpToLatestNew,
    'earlierFailed': s.earlierFailed,
    'noEarlier': s.noEarlier,
    'historyErrorTitle': s.historyErrorTitle,
    'historyErrorMessage': s.historyErrorMessage,
    'chatEmptyTitle': s.chatEmptyTitle,
    'chatEmptyMessage': s.chatEmptyMessage,
    'chatEmptyAction': s.chatEmptyAction,
    'chatEmptyHint': s.chatEmptyHint,
    'tagFrameworkNotice': s.tagFrameworkNotice,
    'tagFrameworkReminder': s.tagFrameworkReminder,
    'tagInjection': s.tagInjection,
    'tagContextBoundary': s.tagContextBoundary,
    'injectionCardTitle': s.injectionCardTitle,
    'unnamedSender': s.unnamedSender,
    'dash': s.dash,
    'directMessage': s.directMessage,
    'groupMention': s.groupMention,
    'groupMessage': s.groupMessage,
    'chatTypeDirect': s.chatTypeDirect,
    'chatTypeGroup': s.chatTypeGroup,
    'qqOfficialBot': s.qqOfficialBot,
    'externalChannel': s.externalChannel,
    'qqMessage': s.qqMessage,
    'oneBotMessage': s.oneBotMessage,
    'externalMessage': s.externalMessage,
    'byModel': s.byModel,
    'byRule': s.byRule,
    'manualWake': s.manualWake,
    'intentWake': s.intentWake,
    'schedulerFire': s.schedulerFire,
    'backgroundProgress': s.backgroundProgress,
    'eventDream': s.eventDream,
    'eventMcpDeclChanged': s.eventMcpDeclChanged,
    'contextClearedHere': s.contextClearedHere,
    'contextCompactedHere': s.contextCompactedHere,
    'contextClearedHereDetail': s.contextClearedHereDetail,
    'contextCompactedHereDetail': s.contextCompactedHereDetail,
    'humanReplyRecorded': s.humanReplyRecorded,
    'markedOk': s.markedOk,
    'markedFailed': s.markedFailed,
    'toolRunning': s.toolRunning,
    'toolExecuting': s.toolExecuting,
    'toolDone': s.toolDone,
    'toolError': s.toolError,
    'toolTimeout': s.toolTimeout,
    'toolDenied': s.toolDenied,
    'toolUnknown': s.toolUnknown,
    'toolNotDispatched': s.toolNotDispatched,
    'toolOverStepCap': s.toolOverStepCap,
    'thinkingLabel': s.thinkingLabel,
    'thinkingGap': s.thinkingGap,
    'toastContextCleared': s.toastContextCleared,
    'toastDream': s.toastDream,
    'toastDuplicateSend': s.toastDuplicateSend,
    'settingsTitle': s.settingsTitle,
    'settingsSubtitle': s.settingsSubtitle,
    'settingsSectionUi': s.settingsSectionUi,
    'settingsUiNote': s.settingsUiNote,
    'instantApply': s.instantApply,
    'settingsThemeMode': s.settingsThemeMode,
    'themeLight': s.themeLight,
    'themeDark': s.themeDark,
    'settingsCurrentTheme': s.settingsCurrentTheme,
    'settingsThemeNote': s.settingsThemeNote,
    'settingsCloseToTray': s.settingsCloseToTray,
    'settingsCloseToTrayNote': s.settingsCloseToTrayNote,
    'settingsLanguage': s.settingsLanguage,
    'languageFollowSystem': s.languageFollowSystem,
    'settingsLanguageNote': s.settingsLanguageNote,
    'settingsStringsOverride': s.settingsStringsOverride,
    'settingsStringsOverrideNote': s.settingsStringsOverrideNote,
    'stringsOverridePathLabel': s.stringsOverridePathLabel,
    'stringsOverrideOpen': s.stringsOverrideOpen,
    'stringsOverrideReload': s.stringsOverrideReload,
    'stringsOverrideExport': s.stringsOverrideExport,
    'stringsOverrideNone': s.stringsOverrideNone,
    'stringsOverrideBadRoot': s.stringsOverrideBadRoot,
    'settingsAnchorCaption': s.settingsAnchorCaption,
    'settingsNavModel': s.settingsNavModel,
    'settingsNavUi': s.settingsNavUi,
    'settingsNavSpeak': s.settingsNavSpeak,
    'settingsNavDeps': s.settingsNavDeps,
    'settingsNavProtocol': s.settingsNavProtocol,
    'settingsNavWebhook': s.settingsNavWebhook,
    'settingsNavMemory': s.settingsNavMemory,
    'settingsNavTrust': s.settingsNavTrust,
    'settingsNavSystem': s.settingsNavSystem,
    'settingsNavAccount': s.settingsNavAccount,
    'settingsNavAbout': s.settingsNavAbout,
    'overviewSubtitle': s.overviewSubtitle,
    'overviewSectionAdvice': s.overviewSectionAdvice,
    'overviewSectionRecent': s.overviewSectionRecent,
    'overviewPersonaSeedAdvice': s.overviewPersonaSeedAdvice,
    'overviewNoPendingCalls': s.overviewNoPendingCalls,
    'overviewTimerCancelTitle': s.overviewTimerCancelTitle,
    'overviewTimerCancel': s.overviewTimerCancel,
    'overviewDeadDiscardTitle': s.overviewDeadDiscardTitle,
    'overviewDeadDiscardConfirm': s.overviewDeadDiscardConfirm,
    'overviewDeadRequeue': s.overviewDeadRequeue,
    'overviewDeadDiscard': s.overviewDeadDiscard,
    'overviewLoadFailedTitle': s.overviewLoadFailedTitle,
    'overviewMarkSucceeded': s.overviewMarkSucceeded,
    'overviewMarkFailed': s.overviewMarkFailed,
    'overviewTodayUsage': s.overviewTodayUsage,
    'overviewCacheHitRate': s.overviewCacheHitRate,
    'overviewPending': s.overviewPending,
    'overviewFailStreak': s.overviewFailStreak,
    'overviewActFallback': s.overviewActFallback,
    'overviewDeadLettersUnread': s.overviewDeadLettersUnread,
    'overviewUnknownSession': s.overviewUnknownSession,
    'overviewChatTypeDirect': s.overviewChatTypeDirect,
    'overviewChatTypeGroupAt': s.overviewChatTypeGroupAt,
    'overviewChatTypeGroup': s.overviewChatTypeGroup,
    'overviewChatTypeGuild': s.overviewChatTypeGuild,
    'overviewChatTypeUnknown': s.overviewChatTypeUnknown,
    'overviewExternalSessions': s.overviewExternalSessions,
    'overviewExternalSessionsNote': s.overviewExternalSessionsNote,
    'overviewExternalSessionsLoading': s.overviewExternalSessionsLoading,
    'overviewExternalSessionsErrorHint': s.overviewExternalSessionsErrorHint,
    'overviewNoAccumulatedMessages': s.overviewNoAccumulatedMessages,
    'overviewLevelCritical': s.overviewLevelCritical,
    'overviewLevelWarn': s.overviewLevelWarn,
    'overviewLevelInfo': s.overviewLevelInfo,
    'overviewLevelUnknown': s.overviewLevelUnknown,
    'overviewFrameworkNote': s.overviewFrameworkNote,
    'overviewFrameworkNotesLoading': s.overviewFrameworkNotesLoading,
    'overviewFrameworkNotesErrorHint': s.overviewFrameworkNotesErrorHint,
    'overviewNoFrameworkNotes': s.overviewNoFrameworkNotes,
    'overviewTimers': s.overviewTimers,
    'overviewTimersNote': s.overviewTimersNote,
    'overviewNoTimers': s.overviewNoTimers,
    'overviewTimersErrorHint': s.overviewTimersErrorHint,
    'overviewTimerUnknownTime': s.overviewTimerUnknownTime,
    'overviewTimerRecurring': s.overviewTimerRecurring,
    'overviewRecentEmpty': s.overviewRecentEmpty,
    'overviewRecentEmptyAction': s.overviewRecentEmptyAction,
    'overviewRecentEmptyHint': s.overviewRecentEmptyHint,
    'overviewJudgedByRule': s.overviewJudgedByRule,
    'overviewJudgedByModel': s.overviewJudgedByModel,
    'overviewSessionsNotList': s.overviewSessionsNotList,
    'overviewNotesNotList': s.overviewNotesNotList,
    'settingsLaneHeavyLabel': s.settingsLaneHeavyLabel,
    'settingsLaneLightLabel': s.settingsLaneLightLabel,
    'settingsLaneHeavyNote': s.settingsLaneHeavyNote,
    'settingsLaneLightNote': s.settingsLaneLightNote,
    'settingsDepSourceManaged': s.settingsDepSourceManaged,
    'settingsDepSourceSystemPath': s.settingsDepSourceSystemPath,
    'settingsDepVersionUnknown': s.settingsDepVersionUnknown,
    'settingsDepPathUnknown': s.settingsDepPathUnknown,
    'settingsSysHostEmptyError': s.settingsSysHostEmptyError,
    'settingsSysHostLabel': s.settingsSysHostLabel,
    'settingsSysHostNote': s.settingsSysHostNote,
    'settingsSysPortLabel': s.settingsSysPortLabel,
    'settingsSysTimezoneLabel': s.settingsSysTimezoneLabel,
    'settingsSysTimezoneNote': s.settingsSysTimezoneNote,
    'settingsSysStepToolsLabel': s.settingsSysStepToolsLabel,
    'settingsSysStepToolsNote': s.settingsSysStepToolsNote,
    'settingsSysTurnStepsLabel': s.settingsSysTurnStepsLabel,
    'settingsSysTurnStepsNote': s.settingsSysTurnStepsNote,
    'settingsSysTaskTokensLabel': s.settingsSysTaskTokensLabel,
    'settingsSysTaskTokensNote': s.settingsSysTaskTokensNote,
    'settingsSysDailyTokensLabel': s.settingsSysDailyTokensLabel,
    'settingsSysDailyTokensNote': s.settingsSysDailyTokensNote,
    'settingsSysSoftRatioLabel': s.settingsSysSoftRatioLabel,
    'settingsSysSoftRatioNote': s.settingsSysSoftRatioNote,
    'settingsSysFailStreakLabel': s.settingsSysFailStreakLabel,
    'settingsSysFailStreakNote': s.settingsSysFailStreakNote,
    'settingsSysHeartbeatLabel': s.settingsSysHeartbeatLabel,
    'settingsSysHeartbeatNote': s.settingsSysHeartbeatNote,
    'settingsSysCompactionLabel': s.settingsSysCompactionLabel,
    'settingsSysCompactionNote': s.settingsSysCompactionNote,
    'settingsTrustConsequenceWorkspaceUnknown': s.settingsTrustConsequenceWorkspaceUnknown,
    'settingsTrustConsequenceFull': s.settingsTrustConsequenceFull,
    'settingsTrustLabelWorkspace': s.settingsTrustLabelWorkspace,
    'settingsTrustLabelFull': s.settingsTrustLabelFull,
    'settingsWebhookStateNotObject': s.settingsWebhookStateNotObject,
    'settingsProtocolStateNotObject': s.settingsProtocolStateNotObject,
    'settingsDepsReadFailed': s.settingsDepsReadFailed,
    'settingsKeysReadFailed': s.settingsKeysReadFailed,
    'settingsProjectionReadFailed': s.settingsProjectionReadFailed,
    'settingsModelNameRequired': s.settingsModelNameRequired,
    'settingsBaseUrlRequired': s.settingsBaseUrlRequired,
    'settingsNoChanges': s.settingsNoChanges,
    'settingsWrittenModelSettings': s.settingsWrittenModelSettings,
    'settingsWrittenKey': s.settingsWrittenKey,
    'settingsRestartSuffix': s.settingsRestartSuffix,
    'settingsClearKeyBody': s.settingsClearKeyBody,
    'settingsClear': s.settingsClear,
    'settingsKeyCleared': s.settingsKeyCleared,
    'settingsConfigErrorHint': s.settingsConfigErrorHint,
    'settingsConfigUnavailable': s.settingsConfigUnavailable,
    'settingsConfigUnavailableHint': s.settingsConfigUnavailableHint,
    'settingsConfigFallbackNote': s.settingsConfigFallbackNote,
    'settingsModelRestartNote': s.settingsModelRestartNote,
    'settingsKeysNote': s.settingsKeysNote,
    'settingsKeyConfiguredHint': s.settingsKeyConfiguredHint,
    'settingsKeySampleHint': s.settingsKeySampleHint,
    'settingsModelName': s.settingsModelName,
    'settingsBaseUrlNote': s.settingsBaseUrlNote,
    'settingsClearKey': s.settingsClearKey,
    'settingsReading': s.settingsReading,
    'settingsStateReadFailed': s.settingsStateReadFailed,
    'settingsNotConfigured': s.settingsNotConfigured,
    'settingsSpeakNote': s.settingsSpeakNote,
    'settingsSpeakTyping': s.settingsSpeakTyping,
    'settingsSpeakTypingNote': s.settingsSpeakTypingNote,
    'settingsSpeakSpeed': s.settingsSpeakSpeed,
    'settingsSpeakSpeedUnit': s.settingsSpeakSpeedUnit,
    'settingsSpeakSpeedNote': s.settingsSpeakSpeedNote,
    'settingsCurrentlyActive': s.settingsCurrentlyActive,
    'settingsSpeakTypingEnabled': s.settingsSpeakTypingEnabled,
    'settingsSpeakTypingDisabled': s.settingsSpeakTypingDisabled,
    'settingsSpeakSpeedRange': s.settingsSpeakSpeedRange,
    'settingsSavedRestartNote': s.settingsSavedRestartNote,
    'settingsSavedLive': s.settingsSavedLive,
    'settingsSavedRestart': s.settingsSavedRestart,
    'settingsDepsAllReady': s.settingsDepsAllReady,
    'settingsDepsNote': s.settingsDepsNote,
    'settingsDepsProbing': s.settingsDepsProbing,
    'settingsDepsInstallLocation': s.settingsDepsInstallLocation,
    'settingsDepReadyManaged': s.settingsDepReadyManaged,
    'settingsDepReadySystem': s.settingsDepReadySystem,
    'settingsDepMismatch': s.settingsDepMismatch,
    'settingsDepMissing': s.settingsDepMissing,
    'settingsDepNoAction': s.settingsDepNoAction,
    'settingsDepInstalling': s.settingsDepInstalling,
    'settingsInstall': s.settingsInstall,
    'settingsDownloadPage': s.settingsDownloadPage,
    'settingsOpenDownloadPage': s.settingsOpenDownloadPage,
    'settingsDownloadAndInstall': s.settingsDownloadAndInstall,
    'settingsStepDownloadFailed': s.settingsStepDownloadFailed,
    'settingsStepExtractFailed': s.settingsStepExtractFailed,
    'settingsStepVerifyFailed': s.settingsStepVerifyFailed,
    'settingsStepInstallFailed': s.settingsStepInstallFailed,
    'settingsUnknown': s.settingsUnknown,
    'settingsRestartRequired': s.settingsRestartRequired,
    'settingsProtocolTitle': s.settingsProtocolTitle,
    'settingsProtocolNote': s.settingsProtocolNote,
    'settingsProtocolErrorHint': s.settingsProtocolErrorHint,
    'settingsProtocolLoading': s.settingsProtocolLoading,
    'settingsProtocolEmpty': s.settingsProtocolEmpty,
    'settingsProtocolEmptyHint': s.settingsProtocolEmptyHint,
    'settingsProtocolEnabled': s.settingsProtocolEnabled,
    'settingsProtocolEnabledNote': s.settingsProtocolEnabledNote,
    'settingsInstallDir': s.settingsInstallDir,
    'settingsInstallDirHint': s.settingsInstallDirHint,
    'settingsSaveDir': s.settingsSaveDir,
    'settingsInstallDirNote': s.settingsInstallDirNote,
    'settingsOneClickInstall': s.settingsOneClickInstall,
    'settingsOneClickInstallNote': s.settingsOneClickInstallNote,
    'settingsOneClickPrerequisite': s.settingsOneClickPrerequisite,
    'settingsInstallRunningNote': s.settingsInstallRunningNote,
    'settingsInstallLogEmpty': s.settingsInstallLogEmpty,
    'settingsInstallLog': s.settingsInstallLog,
    'settingsInstalledNextTitle': s.settingsInstalledNextTitle,
    'settingsInstalledNextBody': s.settingsInstalledNextBody,
    'settingsInstallDirEmpty': s.settingsInstallDirEmpty,
    'settingsEntryFound': s.settingsEntryFound,
    'settingsEntryMissing': s.settingsEntryMissing,
    'settingsEntryPendingRestart': s.settingsEntryPendingRestart,
    'settingsStart': s.settingsStart,
    'settingsStop': s.settingsStop,
    'settingsOpenPanel': s.settingsOpenPanel,
    'settingsProtocolNotAttachedNote': s.settingsProtocolNotAttachedNote,
    'settingsChainProcess': s.settingsChainProcess,
    'settingsChainUnobserved': s.settingsChainUnobserved,
    'settingsChainNoInstance': s.settingsChainNoInstance,
    'settingsChainNotRunning': s.settingsChainNotRunning,
    'settingsChainNoPort': s.settingsChainNoPort,
    'settingsChainSpawned': s.settingsChainSpawned,
    'settingsChainDiscovered': s.settingsChainDiscovered,
    'settingsChainPortOnly': s.settingsChainPortOnly,
    'settingsChainRunning': s.settingsChainRunning,
    'settingsChainOneBotConfig': s.settingsChainOneBotConfig,
    'settingsChainWithToken': s.settingsChainWithToken,
    'settingsChainNoToken': s.settingsChainNoToken,
    'settingsChainPresent': s.settingsChainPresent,
    'settingsChainUnreadable': s.settingsChainUnreadable,
    'settingsChainMissing': s.settingsChainMissing,
    'settingsChainMissingDetail': s.settingsChainMissingDetail,
    'settingsChainAdapter': s.settingsChainAdapter,
    'settingsChainConnected': s.settingsChainConnected,
    'settingsChainReconnecting': s.settingsChainReconnecting,
    'settingsChainNoEndpoint': s.settingsChainNoEndpoint,
    'settingsChainNoEndpointDetail': s.settingsChainNoEndpointDetail,
    'settingsChainDisabled': s.settingsChainDisabled,
    'settingsChainNotAssembled': s.settingsChainNotAssembled,
    'settingsChainNotAssembledDetail': s.settingsChainNotAssembledDetail,
    'settingsChainNoData': s.settingsChainNoData,
    'settingsCredentialLost': s.settingsCredentialLost,
    'settingsConsentPending': s.settingsConsentPending,
    'settingsPasswordUnchanged': s.settingsPasswordUnchanged,
    'settingsCredentialCopied': s.settingsCredentialCopied,
    'settingsCopyCredential': s.settingsCopyCredential,
    'settingsProtocolRestartNote': s.settingsProtocolRestartNote,
    'settingsInstallDirRequired': s.settingsInstallDirRequired,
    'settingsStartRequested': s.settingsStartRequested,
    'settingsStopRequested': s.settingsStopRequested,
    'settingsOneClickFailed': s.settingsOneClickFailed,
    'settingsInstallNoReason': s.settingsInstallNoReason,
    'settingsInstalledOk': s.settingsInstalledOk,
    'settingsInstalledConfigured': s.settingsInstalledConfigured,
    'settingsInstalledNotConfigured': s.settingsInstalledNotConfigured,
    'settingsRestartSuffixParen': s.settingsRestartSuffixParen,
    'settingsGenerated': s.settingsGenerated,
    'settingsNotGenerated': s.settingsNotGenerated,
    'settingsWebhookNote': s.settingsWebhookNote,
    'settingsWebhookLoading': s.settingsWebhookLoading,
    'settingsWebhookCurrent': s.settingsWebhookCurrent,
    'settingsWebhookNotConfiguredNote': s.settingsWebhookNotConfiguredNote,
    'settingsWebhookRotated': s.settingsWebhookRotated,
    'settingsWebhookNever': s.settingsWebhookNever,
    'settingsRegenerate': s.settingsRegenerate,
    'settingsGenerateWebhook': s.settingsGenerateWebhook,
    'settingsWebhookCredentialNote': s.settingsWebhookCredentialNote,
    'settingsRegenerateTitle': s.settingsRegenerateTitle,
    'settingsRegenerateBody': s.settingsRegenerateBody,
    'settingsNoTokenReturned': s.settingsNoTokenReturned,
    'settingsWebhookRotatedNote': s.settingsWebhookRotatedNote,
    'settingsMemoryNote': s.settingsMemoryNote,
    'settingsNotInEffect': s.settingsNotInEffect,
    'settingsMemoryEnableLabel': s.settingsMemoryEnableLabel,
    'settingsMemoryEnableNote': s.settingsMemoryEnableNote,
    'settingsMemoryOn': s.settingsMemoryOn,
    'settingsMemoryOff': s.settingsMemoryOff,
    'settingsMemoryUnaffectedNote': s.settingsMemoryUnaffectedNote,
    'settingsMemoryRestartNote': s.settingsMemoryRestartNote,
    'settingsMemoryDetail': s.settingsMemoryDetail,
    'settingsMemoryCost': s.settingsMemoryCost,
    'settingsMemoryOnSaved': s.settingsMemoryOnSaved,
    'settingsMemoryOffSaved': s.settingsMemoryOffSaved,
    'settingsTrustNote': s.settingsTrustNote,
    'settingsTrustReachLabel': s.settingsTrustReachLabel,
    'settingsTrustReachNote': s.settingsTrustReachNote,
    'settingsTrustWorkspaceUnknownPath': s.settingsTrustWorkspaceUnknownPath,
    'settingsTrustFullValue': s.settingsTrustFullValue,
    'settingsTrustPendingNote': s.settingsTrustPendingNote,
    'settingsTrustRootNote': s.settingsTrustRootNote,
    'settingsTrustBoundaryNote': s.settingsTrustBoundaryNote,
    'settingsTrustRulesDetail': s.settingsTrustRulesDetail,
    'settingsTrustFullTitle': s.settingsTrustFullTitle,
    'settingsTrustFullConfirmTail': s.settingsTrustFullConfirmTail,
    'settingsTrustWorkspaceSaved': s.settingsTrustWorkspaceSaved,
    'settingsTrustFullSaved': s.settingsTrustFullSaved,
    'settingsSystemNote': s.settingsSystemNote,
    'settingsDataDir': s.settingsDataDir,
    'settingsDataDirNote': s.settingsDataDirNote,
    'settingsSystemFootnote': s.settingsSystemFootnote,
    'settingsLiveNow': s.settingsLiveNow,
    'settingsEdit': s.settingsEdit,
    'settingsAccountNote': s.settingsAccountNote,
    'settingsAccountLegacyBadge': s.settingsAccountLegacyBadge,
    'settingsAccountSessionBadge': s.settingsAccountSessionBadge,
    'settingsAccountInstance': s.settingsAccountInstance,
    'settingsAccountInstanceNote': s.settingsAccountInstanceNote,
    'settingsAccountLegacyNote': s.settingsAccountLegacyNote,
    'settingsChangePassword': s.settingsChangePassword,
    'settingsLogout': s.settingsLogout,
    'settingsSetPasswordFirst': s.settingsSetPasswordFirst,
    'settingsPasswordChanged': s.settingsPasswordChanged,
    'settingsLogoutBody': s.settingsLogoutBody,
    'settingsAboutNote': s.settingsAboutNote,
    'settingsAboutBadge': s.settingsAboutBadge,
    'settingsVersionLabel': s.settingsVersionLabel,
    'settingsGuardedDays': s.settingsGuardedDays,
    'settingsWatermark': s.settingsWatermark,
    'settingsProjectionFootnote': s.settingsProjectionFootnote,
    'settingsDestructivePolicy': s.settingsDestructivePolicy,
    'settingsModify': s.settingsModify,
    'settingsPolicyNoneOption': s.settingsPolicyNoneOption,
    'settingsPolicyAllOption': s.settingsPolicyAllOption,
    'settingsPolicyListOption': s.settingsPolicyListOption,
    'settingsPolicyListTitle': s.settingsPolicyListTitle,
    'settingsPolicyNoTools': s.settingsPolicyNoTools,
    'settingsDestructiveTitle': s.settingsDestructiveTitle,
    'settingsDestructiveRelaxedBody': s.settingsDestructiveRelaxedBody,
    'settingsDestructiveRestrictedBody': s.settingsDestructiveRestrictedBody,
    'settingsPolicyAll': s.settingsPolicyAll,
    'settingsPolicyListEmpty': s.settingsPolicyListEmpty,
    'settingsPolicyNone': s.settingsPolicyNone,
    'settingsListAnd': s.settingsListAnd,
    'settingsUnknownReason': s.settingsUnknownReason,
    'settingsSeeOfficialDocs': s.settingsSeeOfficialDocs,
    'settingsWebhookCurlTokenPlaceholder': s.settingsWebhookCurlTokenPlaceholder,
    'settingsWebhookCurlSampleText': s.settingsWebhookCurlSampleText,
};

/// 可覆盖的键（懒加载一次：= [AppStrings] 的全部无参 getter）
final Set<String> stringOverrideKeys = stringsAsMap(const ZhStrings()).keys.toSet();

/// 把某一段（zh 或 en）里的键值收进 [target]，认不出的进 [ignored]。
///
/// [ignored] 里的句子是**日志现场**（键名 + 原因），刻意写成 ASCII：真正给人看的那句话
/// 在 `AppStrings` 里（设置页那行状态 + [stringsOverrideIgnored]），这一份只落到控制台。
void _collect(
  String section,
  Map<dynamic, dynamic> raw,
  Map<String, String> target,
  List<String> ignored,
) {
  for (final entry in raw.entries) {
    final key = '${entry.key}';
    final value = entry.value;
    if (value is! String) {
      ignored.add('$section.$key: value is not a string');
      continue;
    }
    if (!stringOverrideKeys.contains(key)) {
      ignored.add('$section.$key: unknown key');
      continue;
    }
    target[key] = value;
  }
}

/// 把这次加载的结局写进控制台 / 启动日志（ASCII：它与界面语言无关，是排障那一份）。
///
/// 为什么值得打：拼错的键**不会**让界面报错（静默忽略是刻意的），于是"我改了怎么没变"
/// 的唯一线索就在这里。文件路径也一并打出来——人常把文件放到另一个 `%APPDATA%` 下。
void _logSnapshot(StringsOverrideSnapshot snapshot) {
  final kind = snapshot.errorKind;
  if (kind != null) {
    debugPrint(
      '[strings-override] ${kind.name}: falling back to built-in text '
      '(${snapshot.errorDetail}) ${snapshot.filePath}',
    );
  } else if (snapshot.total > 0) {
    debugPrint(
      '[strings-override] loaded ${snapshot.total} override(s) '
      '(zh ${snapshot.zh.length} / en ${snapshot.en.length}): ${snapshot.filePath}',
    );
  }
  if (snapshot.ignored.isEmpty) return;
  debugPrint('[strings-override] ${snapshot.ignored.length} entr(y/ies) ignored (startup not affected):');
  for (final item in snapshot.ignored) {
    debugPrint('  - $item');
  }
}

/// 默认文案 + 一层覆盖值。**这就是"同一个 [AppStrings] 接口"的兑现方式**：
/// 页面拿到的还是 [AppStrings]，一行不用改。
///
/// 解析顺序：`overrides[键]` 有值就用它，否则回 [base] 的那一条。能被覆盖的只有
/// **无参 getter**（[stringOverrideKeys]）；带参句子原样委托给 [base]（它们的语序
/// 与参数位置由实现决定，交给用户改等于把两种语言的语序都写死成一种）。
class OverriddenStrings extends AppStrings {
  const OverriddenStrings({
    required this.base,
    required this.overrides,
    this.revision = 0,
  });

  /// 默认文案（[ZhStrings] / [EnStrings] 之一）
  final AppStrings base;

  /// 生效的覆盖值（构造前已过滤：只有认识的键）
  final Map<String, String> overrides;

  /// 覆盖层版次（见 [AppStrings.revision]）
  @override
  final int revision;

  @override
  AppLanguage get language => base.language;

  @override
  String get retry => overrides['retry'] ?? base.retry;
  @override
  String get cancel => overrides['cancel'] ?? base.cancel;
  @override
  String get confirm => overrides['confirm'] ?? base.confirm;
  @override
  String get save => overrides['save'] ?? base.save;
  @override
  String get loading => overrides['loading'] ?? base.loading;
  @override
  String get error => overrides['error'] ?? base.error;
  @override
  String get empty => overrides['empty'] ?? base.empty;
  @override
  String get collapse => overrides['collapse'] ?? base.collapse;
  @override
  String get settingsLoadingConfig => overrides['settingsLoadingConfig'] ?? base.settingsLoadingConfig;
  @override
  String get navChat => overrides['navChat'] ?? base.navChat;
  @override
  String get navSettings => overrides['navSettings'] ?? base.navSettings;
  @override
  String get navOverview => overrides['navOverview'] ?? base.navOverview;
  @override
  String get navChannels => overrides['navChannels'] ?? base.navChannels;
  @override
  String get navExtensions => overrides['navExtensions'] ?? base.navExtensions;
  @override
  String get navPersona => overrides['navPersona'] ?? base.navPersona;
  @override
  String get navSchedule => overrides['navSchedule'] ?? base.navSchedule;
  @override
  String get navMemory => overrides['navMemory'] ?? base.navMemory;
  @override
  String get navLogs => overrides['navLogs'] ?? base.navLogs;
  @override
  String get navMore => overrides['navMore'] ?? base.navMore;
  @override
  String get overviewConfigGuide => overrides['overviewConfigGuide'] ?? base.overviewConfigGuide;
  @override
  String get restartSentWithGui => overrides['restartSentWithGui'] ?? base.restartSentWithGui;
  @override
  String get restartSentBackendOnly => overrides['restartSentBackendOnly'] ?? base.restartSentBackendOnly;
  @override
  String get restartNoConclusion => overrides['restartNoConclusion'] ?? base.restartNoConclusion;
  @override
  String get restartBackReady => overrides['restartBackReady'] ?? base.restartBackReady;
  @override
  String get restartNeverWentDown => overrides['restartNeverWentDown'] ?? base.restartNeverWentDown;
  @override
  String get trayShow => overrides['trayShow'] ?? base.trayShow;
  @override
  String get trayHide => overrides['trayHide'] ?? base.trayHide;
  @override
  String get trayRestart => overrides['trayRestart'] ?? base.trayRestart;
  @override
  String get trayQuitUi => overrides['trayQuitUi'] ?? base.trayQuitUi;
  @override
  String get trayQuitAll => overrides['trayQuitAll'] ?? base.trayQuitAll;
  @override
  String get quitAllConfirmTitle => overrides['quitAllConfirmTitle'] ?? base.quitAllConfirmTitle;
  @override
  String get quitAllConfirmLabel => overrides['quitAllConfirmLabel'] ?? base.quitAllConfirmLabel;
  @override
  String get quitAllWorking => overrides['quitAllWorking'] ?? base.quitAllWorking;
  @override
  String get quitAllDone => overrides['quitAllDone'] ?? base.quitAllDone;
  @override
  String get onboardingManualSaved => overrides['onboardingManualSaved'] ?? base.onboardingManualSaved;
  @override
  String get onboardingManualNoChanges => overrides['onboardingManualNoChanges'] ?? base.onboardingManualNoChanges;
  @override
  String get onboardingStepNameTitle => overrides['onboardingStepNameTitle'] ?? base.onboardingStepNameTitle;
  @override
  String get onboardingStepNameNote => overrides['onboardingStepNameNote'] ?? base.onboardingStepNameNote;
  @override
  String get onboardingStepApiTitle => overrides['onboardingStepApiTitle'] ?? base.onboardingStepApiTitle;
  @override
  String get onboardingStepApiNote => overrides['onboardingStepApiNote'] ?? base.onboardingStepApiNote;
  @override
  String get onboardingStepChannelTitle => overrides['onboardingStepChannelTitle'] ?? base.onboardingStepChannelTitle;
  @override
  String get onboardingStepChannelNote => overrides['onboardingStepChannelNote'] ?? base.onboardingStepChannelNote;
  @override
  String get onboardingStepPersonaTitle => overrides['onboardingStepPersonaTitle'] ?? base.onboardingStepPersonaTitle;
  @override
  String get onboardingStepPersonaNote => overrides['onboardingStepPersonaNote'] ?? base.onboardingStepPersonaNote;
  @override
  String get onboardingStepTrustTitle => overrides['onboardingStepTrustTitle'] ?? base.onboardingStepTrustTitle;
  @override
  String get onboardingStepTrustNote => overrides['onboardingStepTrustNote'] ?? base.onboardingStepTrustNote;
  @override
  String get onboardingApiRecommendLead => overrides['onboardingApiRecommendLead'] ?? base.onboardingApiRecommendLead;
  @override
  String get onboardingApiRecommendModel => overrides['onboardingApiRecommendModel'] ?? base.onboardingApiRecommendModel;
  @override
  String get onboardingApiRegisterKey => overrides['onboardingApiRegisterKey'] ?? base.onboardingApiRegisterKey;
  @override
  String get onboardingApiRecommendJoin => overrides['onboardingApiRecommendJoin'] ?? base.onboardingApiRecommendJoin;
  @override
  String get onboardingChannelRecommendLead => overrides['onboardingChannelRecommendLead'] ?? base.onboardingChannelRecommendLead;
  @override
  String get onboardingChannelRecommendQq => overrides['onboardingChannelRecommendQq'] ?? base.onboardingChannelRecommendQq;
  @override
  String get onboardingChannelRecommendTail => overrides['onboardingChannelRecommendTail'] ?? base.onboardingChannelRecommendTail;
  @override
  String get onboardingQqTileDetail => overrides['onboardingQqTileDetail'] ?? base.onboardingQqTileDetail;
  @override
  String get onboardingQqCredentialsTitle => overrides['onboardingQqCredentialsTitle'] ?? base.onboardingQqCredentialsTitle;
  @override
  String get onboardingQqAppIdLabel => overrides['onboardingQqAppIdLabel'] ?? base.onboardingQqAppIdLabel;
  @override
  String get onboardingQqAppIdHint => overrides['onboardingQqAppIdHint'] ?? base.onboardingQqAppIdHint;
  @override
  String get onboardingQqAppSecretLabel => overrides['onboardingQqAppSecretLabel'] ?? base.onboardingQqAppSecretLabel;
  @override
  String get onboardingQqAppSecretHint => overrides['onboardingQqAppSecretHint'] ?? base.onboardingQqAppSecretHint;
  @override
  String get onboardingQqCredentialsNote => overrides['onboardingQqCredentialsNote'] ?? base.onboardingQqCredentialsNote;
  @override
  String get onboardingStepNameHint => overrides['onboardingStepNameHint'] ?? base.onboardingStepNameHint;
  @override
  String get onboardingKeywordsHint => overrides['onboardingKeywordsHint'] ?? base.onboardingKeywordsHint;
  @override
  String get onboardingPersonaHint => overrides['onboardingPersonaHint'] ?? base.onboardingPersonaHint;
  @override
  String get onboardingTrustNoteSame => overrides['onboardingTrustNoteSame'] ?? base.onboardingTrustNoteSame;
  @override
  String get onboardingTrustNoteChanged => overrides['onboardingTrustNoteChanged'] ?? base.onboardingTrustNoteChanged;
  @override
  String get onboardingStepDepsTitle => overrides['onboardingStepDepsTitle'] ?? base.onboardingStepDepsTitle;
  @override
  String get onboardingStepDepsNote => overrides['onboardingStepDepsNote'] ?? base.onboardingStepDepsNote;
  @override
  String get onboardingDepsInstallLabel => overrides['onboardingDepsInstallLabel'] ?? base.onboardingDepsInstallLabel;
  @override
  String get onboardingDepsAllReady => overrides['onboardingDepsAllReady'] ?? base.onboardingDepsAllReady;
  @override
  String get onboardingDepsStatusReady => overrides['onboardingDepsStatusReady'] ?? base.onboardingDepsStatusReady;
  @override
  String get onboardingDepsStatusMissing => overrides['onboardingDepsStatusMissing'] ?? base.onboardingDepsStatusMissing;
  @override
  String get onboardingDepsItemRunning => overrides['onboardingDepsItemRunning'] ?? base.onboardingDepsItemRunning;
  @override
  String get onboardingDepsItemOk => overrides['onboardingDepsItemOk'] ?? base.onboardingDepsItemOk;
  @override
  String get onboardingDepsRetry => overrides['onboardingDepsRetry'] ?? base.onboardingDepsRetry;
  @override
  String get onboardingDepsUnavailable => overrides['onboardingDepsUnavailable'] ?? base.onboardingDepsUnavailable;
  @override
  String get onboardingRestartTitle => overrides['onboardingRestartTitle'] ?? base.onboardingRestartTitle;
  @override
  String get onboardingRestartBody => overrides['onboardingRestartBody'] ?? base.onboardingRestartBody;
  @override
  String get onboardingRestartNow => overrides['onboardingRestartNow'] ?? base.onboardingRestartNow;
  @override
  String get onboardingRestartLater => overrides['onboardingRestartLater'] ?? base.onboardingRestartLater;
  @override
  String get chatTitle => overrides['chatTitle'] ?? base.chatTitle;
  @override
  String get chatSubtitle => overrides['chatSubtitle'] ?? base.chatSubtitle;
  @override
  String get composerHint => overrides['composerHint'] ?? base.composerHint;
  @override
  String get jumpToLatest => overrides['jumpToLatest'] ?? base.jumpToLatest;
  @override
  String get jumpToLatestNew => overrides['jumpToLatestNew'] ?? base.jumpToLatestNew;
  @override
  String get earlierFailed => overrides['earlierFailed'] ?? base.earlierFailed;
  @override
  String get noEarlier => overrides['noEarlier'] ?? base.noEarlier;
  @override
  String get historyErrorTitle => overrides['historyErrorTitle'] ?? base.historyErrorTitle;
  @override
  String get historyErrorMessage => overrides['historyErrorMessage'] ?? base.historyErrorMessage;
  @override
  String get chatEmptyTitle => overrides['chatEmptyTitle'] ?? base.chatEmptyTitle;
  @override
  String get chatEmptyMessage => overrides['chatEmptyMessage'] ?? base.chatEmptyMessage;
  @override
  String get chatEmptyAction => overrides['chatEmptyAction'] ?? base.chatEmptyAction;
  @override
  String get chatEmptyHint => overrides['chatEmptyHint'] ?? base.chatEmptyHint;
  @override
  String get tagFrameworkNotice => overrides['tagFrameworkNotice'] ?? base.tagFrameworkNotice;
  @override
  String get tagFrameworkReminder => overrides['tagFrameworkReminder'] ?? base.tagFrameworkReminder;
  @override
  String get tagInjection => overrides['tagInjection'] ?? base.tagInjection;
  @override
  String get tagContextBoundary => overrides['tagContextBoundary'] ?? base.tagContextBoundary;
  @override
  String get injectionCardTitle => overrides['injectionCardTitle'] ?? base.injectionCardTitle;
  @override
  String get unnamedSender => overrides['unnamedSender'] ?? base.unnamedSender;
  @override
  String get dash => overrides['dash'] ?? base.dash;
  @override
  String get directMessage => overrides['directMessage'] ?? base.directMessage;
  @override
  String get groupMention => overrides['groupMention'] ?? base.groupMention;
  @override
  String get groupMessage => overrides['groupMessage'] ?? base.groupMessage;
  @override
  String get chatTypeDirect => overrides['chatTypeDirect'] ?? base.chatTypeDirect;
  @override
  String get chatTypeGroup => overrides['chatTypeGroup'] ?? base.chatTypeGroup;
  @override
  String get qqOfficialBot => overrides['qqOfficialBot'] ?? base.qqOfficialBot;
  @override
  String get externalChannel => overrides['externalChannel'] ?? base.externalChannel;
  @override
  String get qqMessage => overrides['qqMessage'] ?? base.qqMessage;
  @override
  String get oneBotMessage => overrides['oneBotMessage'] ?? base.oneBotMessage;
  @override
  String get externalMessage => overrides['externalMessage'] ?? base.externalMessage;
  @override
  String get byModel => overrides['byModel'] ?? base.byModel;
  @override
  String get byRule => overrides['byRule'] ?? base.byRule;
  @override
  String get manualWake => overrides['manualWake'] ?? base.manualWake;
  @override
  String get intentWake => overrides['intentWake'] ?? base.intentWake;
  @override
  String get schedulerFire => overrides['schedulerFire'] ?? base.schedulerFire;
  @override
  String get backgroundProgress => overrides['backgroundProgress'] ?? base.backgroundProgress;
  @override
  String get eventDream => overrides['eventDream'] ?? base.eventDream;
  @override
  String get eventMcpDeclChanged => overrides['eventMcpDeclChanged'] ?? base.eventMcpDeclChanged;
  @override
  String get contextClearedHere => overrides['contextClearedHere'] ?? base.contextClearedHere;
  @override
  String get contextCompactedHere => overrides['contextCompactedHere'] ?? base.contextCompactedHere;
  @override
  String get contextClearedHereDetail => overrides['contextClearedHereDetail'] ?? base.contextClearedHereDetail;
  @override
  String get contextCompactedHereDetail => overrides['contextCompactedHereDetail'] ?? base.contextCompactedHereDetail;
  @override
  String get humanReplyRecorded => overrides['humanReplyRecorded'] ?? base.humanReplyRecorded;
  @override
  String get markedOk => overrides['markedOk'] ?? base.markedOk;
  @override
  String get markedFailed => overrides['markedFailed'] ?? base.markedFailed;
  @override
  String get toolRunning => overrides['toolRunning'] ?? base.toolRunning;
  @override
  String get toolExecuting => overrides['toolExecuting'] ?? base.toolExecuting;
  @override
  String get toolDone => overrides['toolDone'] ?? base.toolDone;
  @override
  String get toolError => overrides['toolError'] ?? base.toolError;
  @override
  String get toolTimeout => overrides['toolTimeout'] ?? base.toolTimeout;
  @override
  String get toolDenied => overrides['toolDenied'] ?? base.toolDenied;
  @override
  String get toolUnknown => overrides['toolUnknown'] ?? base.toolUnknown;
  @override
  String get toolNotDispatched => overrides['toolNotDispatched'] ?? base.toolNotDispatched;
  @override
  String get toolOverStepCap => overrides['toolOverStepCap'] ?? base.toolOverStepCap;
  @override
  String get thinkingLabel => overrides['thinkingLabel'] ?? base.thinkingLabel;
  @override
  String get thinkingGap => overrides['thinkingGap'] ?? base.thinkingGap;
  @override
  String get toastContextCleared => overrides['toastContextCleared'] ?? base.toastContextCleared;
  @override
  String get toastDream => overrides['toastDream'] ?? base.toastDream;
  @override
  String get toastDuplicateSend => overrides['toastDuplicateSend'] ?? base.toastDuplicateSend;
  @override
  String get settingsTitle => overrides['settingsTitle'] ?? base.settingsTitle;
  @override
  String get settingsSubtitle => overrides['settingsSubtitle'] ?? base.settingsSubtitle;
  @override
  String get settingsSectionUi => overrides['settingsSectionUi'] ?? base.settingsSectionUi;
  @override
  String get settingsUiNote => overrides['settingsUiNote'] ?? base.settingsUiNote;
  @override
  String get instantApply => overrides['instantApply'] ?? base.instantApply;
  @override
  String get settingsThemeMode => overrides['settingsThemeMode'] ?? base.settingsThemeMode;
  @override
  String get themeLight => overrides['themeLight'] ?? base.themeLight;
  @override
  String get themeDark => overrides['themeDark'] ?? base.themeDark;
  @override
  String get settingsCurrentTheme => overrides['settingsCurrentTheme'] ?? base.settingsCurrentTheme;
  @override
  String get settingsThemeNote => overrides['settingsThemeNote'] ?? base.settingsThemeNote;
  @override
  String get settingsCloseToTray => overrides['settingsCloseToTray'] ?? base.settingsCloseToTray;
  @override
  String get settingsCloseToTrayNote => overrides['settingsCloseToTrayNote'] ?? base.settingsCloseToTrayNote;
  @override
  String get settingsLanguage => overrides['settingsLanguage'] ?? base.settingsLanguage;
  @override
  String get languageFollowSystem => overrides['languageFollowSystem'] ?? base.languageFollowSystem;
  @override
  String get settingsLanguageNote => overrides['settingsLanguageNote'] ?? base.settingsLanguageNote;
  @override
  String get settingsStringsOverride => overrides['settingsStringsOverride'] ?? base.settingsStringsOverride;
  @override
  String get settingsStringsOverrideNote => overrides['settingsStringsOverrideNote'] ?? base.settingsStringsOverrideNote;
  @override
  String get stringsOverridePathLabel => overrides['stringsOverridePathLabel'] ?? base.stringsOverridePathLabel;
  @override
  String get stringsOverrideOpen => overrides['stringsOverrideOpen'] ?? base.stringsOverrideOpen;
  @override
  String get stringsOverrideReload => overrides['stringsOverrideReload'] ?? base.stringsOverrideReload;
  @override
  String get stringsOverrideExport => overrides['stringsOverrideExport'] ?? base.stringsOverrideExport;
  @override
  String get stringsOverrideNone => overrides['stringsOverrideNone'] ?? base.stringsOverrideNone;
  @override
  String get stringsOverrideBadRoot => overrides['stringsOverrideBadRoot'] ?? base.stringsOverrideBadRoot;
  @override
  String get settingsAnchorCaption => overrides['settingsAnchorCaption'] ?? base.settingsAnchorCaption;
  @override
  String get settingsNavModel => overrides['settingsNavModel'] ?? base.settingsNavModel;
  @override
  String get settingsNavUi => overrides['settingsNavUi'] ?? base.settingsNavUi;
  @override
  String get settingsNavSpeak => overrides['settingsNavSpeak'] ?? base.settingsNavSpeak;
  @override
  String get settingsNavDeps => overrides['settingsNavDeps'] ?? base.settingsNavDeps;
  @override
  String get settingsNavProtocol => overrides['settingsNavProtocol'] ?? base.settingsNavProtocol;
  @override
  String get settingsNavWebhook => overrides['settingsNavWebhook'] ?? base.settingsNavWebhook;
  @override
  String get settingsNavMemory => overrides['settingsNavMemory'] ?? base.settingsNavMemory;
  @override
  String get settingsNavTrust => overrides['settingsNavTrust'] ?? base.settingsNavTrust;
  @override
  String get settingsNavSystem => overrides['settingsNavSystem'] ?? base.settingsNavSystem;
  @override
  String get settingsNavAccount => overrides['settingsNavAccount'] ?? base.settingsNavAccount;
  @override
  String get settingsNavAbout => overrides['settingsNavAbout'] ?? base.settingsNavAbout;
  @override
  String get overviewSubtitle => overrides['overviewSubtitle'] ?? base.overviewSubtitle;
  @override
  String get overviewSectionAdvice => overrides['overviewSectionAdvice'] ?? base.overviewSectionAdvice;
  @override
  String get overviewSectionRecent => overrides['overviewSectionRecent'] ?? base.overviewSectionRecent;
  @override
  String get overviewPersonaSeedAdvice => overrides['overviewPersonaSeedAdvice'] ?? base.overviewPersonaSeedAdvice;
  @override
  String get overviewNoPendingCalls => overrides['overviewNoPendingCalls'] ?? base.overviewNoPendingCalls;
  @override
  String get overviewTimerCancelTitle => overrides['overviewTimerCancelTitle'] ?? base.overviewTimerCancelTitle;
  @override
  String get overviewTimerCancel => overrides['overviewTimerCancel'] ?? base.overviewTimerCancel;
  @override
  String get overviewDeadDiscardTitle => overrides['overviewDeadDiscardTitle'] ?? base.overviewDeadDiscardTitle;
  @override
  String get overviewDeadDiscardConfirm => overrides['overviewDeadDiscardConfirm'] ?? base.overviewDeadDiscardConfirm;
  @override
  String get overviewDeadRequeue => overrides['overviewDeadRequeue'] ?? base.overviewDeadRequeue;
  @override
  String get overviewDeadDiscard => overrides['overviewDeadDiscard'] ?? base.overviewDeadDiscard;
  @override
  String get overviewLoadFailedTitle => overrides['overviewLoadFailedTitle'] ?? base.overviewLoadFailedTitle;
  @override
  String get overviewMarkSucceeded => overrides['overviewMarkSucceeded'] ?? base.overviewMarkSucceeded;
  @override
  String get overviewMarkFailed => overrides['overviewMarkFailed'] ?? base.overviewMarkFailed;
  @override
  String get overviewTodayUsage => overrides['overviewTodayUsage'] ?? base.overviewTodayUsage;
  @override
  String get overviewCacheHitRate => overrides['overviewCacheHitRate'] ?? base.overviewCacheHitRate;
  @override
  String get overviewPending => overrides['overviewPending'] ?? base.overviewPending;
  @override
  String get overviewFailStreak => overrides['overviewFailStreak'] ?? base.overviewFailStreak;
  @override
  String get overviewActFallback => overrides['overviewActFallback'] ?? base.overviewActFallback;
  @override
  String get overviewDeadLettersUnread => overrides['overviewDeadLettersUnread'] ?? base.overviewDeadLettersUnread;
  @override
  String get overviewUnknownSession => overrides['overviewUnknownSession'] ?? base.overviewUnknownSession;
  @override
  String get overviewChatTypeDirect => overrides['overviewChatTypeDirect'] ?? base.overviewChatTypeDirect;
  @override
  String get overviewChatTypeGroupAt => overrides['overviewChatTypeGroupAt'] ?? base.overviewChatTypeGroupAt;
  @override
  String get overviewChatTypeGroup => overrides['overviewChatTypeGroup'] ?? base.overviewChatTypeGroup;
  @override
  String get overviewChatTypeGuild => overrides['overviewChatTypeGuild'] ?? base.overviewChatTypeGuild;
  @override
  String get overviewChatTypeUnknown => overrides['overviewChatTypeUnknown'] ?? base.overviewChatTypeUnknown;
  @override
  String get overviewExternalSessions => overrides['overviewExternalSessions'] ?? base.overviewExternalSessions;
  @override
  String get overviewExternalSessionsNote => overrides['overviewExternalSessionsNote'] ?? base.overviewExternalSessionsNote;
  @override
  String get overviewExternalSessionsLoading => overrides['overviewExternalSessionsLoading'] ?? base.overviewExternalSessionsLoading;
  @override
  String get overviewExternalSessionsErrorHint => overrides['overviewExternalSessionsErrorHint'] ?? base.overviewExternalSessionsErrorHint;
  @override
  String get overviewNoAccumulatedMessages => overrides['overviewNoAccumulatedMessages'] ?? base.overviewNoAccumulatedMessages;
  @override
  String get overviewLevelCritical => overrides['overviewLevelCritical'] ?? base.overviewLevelCritical;
  @override
  String get overviewLevelWarn => overrides['overviewLevelWarn'] ?? base.overviewLevelWarn;
  @override
  String get overviewLevelInfo => overrides['overviewLevelInfo'] ?? base.overviewLevelInfo;
  @override
  String get overviewLevelUnknown => overrides['overviewLevelUnknown'] ?? base.overviewLevelUnknown;
  @override
  String get overviewFrameworkNote => overrides['overviewFrameworkNote'] ?? base.overviewFrameworkNote;
  @override
  String get overviewFrameworkNotesLoading => overrides['overviewFrameworkNotesLoading'] ?? base.overviewFrameworkNotesLoading;
  @override
  String get overviewFrameworkNotesErrorHint => overrides['overviewFrameworkNotesErrorHint'] ?? base.overviewFrameworkNotesErrorHint;
  @override
  String get overviewNoFrameworkNotes => overrides['overviewNoFrameworkNotes'] ?? base.overviewNoFrameworkNotes;
  @override
  String get overviewTimers => overrides['overviewTimers'] ?? base.overviewTimers;
  @override
  String get overviewTimersNote => overrides['overviewTimersNote'] ?? base.overviewTimersNote;
  @override
  String get overviewNoTimers => overrides['overviewNoTimers'] ?? base.overviewNoTimers;
  @override
  String get overviewTimersErrorHint => overrides['overviewTimersErrorHint'] ?? base.overviewTimersErrorHint;
  @override
  String get overviewTimerUnknownTime => overrides['overviewTimerUnknownTime'] ?? base.overviewTimerUnknownTime;
  @override
  String get overviewTimerRecurring => overrides['overviewTimerRecurring'] ?? base.overviewTimerRecurring;
  @override
  String get overviewRecentEmpty => overrides['overviewRecentEmpty'] ?? base.overviewRecentEmpty;
  @override
  String get overviewRecentEmptyAction => overrides['overviewRecentEmptyAction'] ?? base.overviewRecentEmptyAction;
  @override
  String get overviewRecentEmptyHint => overrides['overviewRecentEmptyHint'] ?? base.overviewRecentEmptyHint;
  @override
  String get overviewJudgedByRule => overrides['overviewJudgedByRule'] ?? base.overviewJudgedByRule;
  @override
  String get overviewJudgedByModel => overrides['overviewJudgedByModel'] ?? base.overviewJudgedByModel;
  @override
  String get overviewSessionsNotList => overrides['overviewSessionsNotList'] ?? base.overviewSessionsNotList;
  @override
  String get overviewNotesNotList => overrides['overviewNotesNotList'] ?? base.overviewNotesNotList;
  @override
  String get settingsLaneHeavyLabel => overrides['settingsLaneHeavyLabel'] ?? base.settingsLaneHeavyLabel;
  @override
  String get settingsLaneLightLabel => overrides['settingsLaneLightLabel'] ?? base.settingsLaneLightLabel;
  @override
  String get settingsLaneHeavyNote => overrides['settingsLaneHeavyNote'] ?? base.settingsLaneHeavyNote;
  @override
  String get settingsLaneLightNote => overrides['settingsLaneLightNote'] ?? base.settingsLaneLightNote;
  @override
  String get settingsDepSourceManaged => overrides['settingsDepSourceManaged'] ?? base.settingsDepSourceManaged;
  @override
  String get settingsDepSourceSystemPath => overrides['settingsDepSourceSystemPath'] ?? base.settingsDepSourceSystemPath;
  @override
  String get settingsDepVersionUnknown => overrides['settingsDepVersionUnknown'] ?? base.settingsDepVersionUnknown;
  @override
  String get settingsDepPathUnknown => overrides['settingsDepPathUnknown'] ?? base.settingsDepPathUnknown;
  @override
  String get settingsSysHostEmptyError => overrides['settingsSysHostEmptyError'] ?? base.settingsSysHostEmptyError;
  @override
  String get settingsSysHostLabel => overrides['settingsSysHostLabel'] ?? base.settingsSysHostLabel;
  @override
  String get settingsSysHostNote => overrides['settingsSysHostNote'] ?? base.settingsSysHostNote;
  @override
  String get settingsSysPortLabel => overrides['settingsSysPortLabel'] ?? base.settingsSysPortLabel;
  @override
  String get settingsSysTimezoneLabel => overrides['settingsSysTimezoneLabel'] ?? base.settingsSysTimezoneLabel;
  @override
  String get settingsSysTimezoneNote => overrides['settingsSysTimezoneNote'] ?? base.settingsSysTimezoneNote;
  @override
  String get settingsSysStepToolsLabel => overrides['settingsSysStepToolsLabel'] ?? base.settingsSysStepToolsLabel;
  @override
  String get settingsSysStepToolsNote => overrides['settingsSysStepToolsNote'] ?? base.settingsSysStepToolsNote;
  @override
  String get settingsSysTurnStepsLabel => overrides['settingsSysTurnStepsLabel'] ?? base.settingsSysTurnStepsLabel;
  @override
  String get settingsSysTurnStepsNote => overrides['settingsSysTurnStepsNote'] ?? base.settingsSysTurnStepsNote;
  @override
  String get settingsSysTaskTokensLabel => overrides['settingsSysTaskTokensLabel'] ?? base.settingsSysTaskTokensLabel;
  @override
  String get settingsSysTaskTokensNote => overrides['settingsSysTaskTokensNote'] ?? base.settingsSysTaskTokensNote;
  @override
  String get settingsSysDailyTokensLabel => overrides['settingsSysDailyTokensLabel'] ?? base.settingsSysDailyTokensLabel;
  @override
  String get settingsSysDailyTokensNote => overrides['settingsSysDailyTokensNote'] ?? base.settingsSysDailyTokensNote;
  @override
  String get settingsSysSoftRatioLabel => overrides['settingsSysSoftRatioLabel'] ?? base.settingsSysSoftRatioLabel;
  @override
  String get settingsSysSoftRatioNote => overrides['settingsSysSoftRatioNote'] ?? base.settingsSysSoftRatioNote;
  @override
  String get settingsSysFailStreakLabel => overrides['settingsSysFailStreakLabel'] ?? base.settingsSysFailStreakLabel;
  @override
  String get settingsSysFailStreakNote => overrides['settingsSysFailStreakNote'] ?? base.settingsSysFailStreakNote;
  @override
  String get settingsSysHeartbeatLabel => overrides['settingsSysHeartbeatLabel'] ?? base.settingsSysHeartbeatLabel;
  @override
  String get settingsSysHeartbeatNote => overrides['settingsSysHeartbeatNote'] ?? base.settingsSysHeartbeatNote;
  @override
  String get settingsSysCompactionLabel => overrides['settingsSysCompactionLabel'] ?? base.settingsSysCompactionLabel;
  @override
  String get settingsSysCompactionNote => overrides['settingsSysCompactionNote'] ?? base.settingsSysCompactionNote;
  @override
  String get settingsTrustConsequenceWorkspaceUnknown => overrides['settingsTrustConsequenceWorkspaceUnknown'] ?? base.settingsTrustConsequenceWorkspaceUnknown;
  @override
  String get settingsTrustConsequenceFull => overrides['settingsTrustConsequenceFull'] ?? base.settingsTrustConsequenceFull;
  @override
  String get settingsTrustLabelWorkspace => overrides['settingsTrustLabelWorkspace'] ?? base.settingsTrustLabelWorkspace;
  @override
  String get settingsTrustLabelFull => overrides['settingsTrustLabelFull'] ?? base.settingsTrustLabelFull;
  @override
  String get settingsWebhookStateNotObject => overrides['settingsWebhookStateNotObject'] ?? base.settingsWebhookStateNotObject;
  @override
  String get settingsProtocolStateNotObject => overrides['settingsProtocolStateNotObject'] ?? base.settingsProtocolStateNotObject;
  @override
  String get settingsDepsReadFailed => overrides['settingsDepsReadFailed'] ?? base.settingsDepsReadFailed;
  @override
  String get settingsKeysReadFailed => overrides['settingsKeysReadFailed'] ?? base.settingsKeysReadFailed;
  @override
  String get settingsProjectionReadFailed => overrides['settingsProjectionReadFailed'] ?? base.settingsProjectionReadFailed;
  @override
  String get settingsModelNameRequired => overrides['settingsModelNameRequired'] ?? base.settingsModelNameRequired;
  @override
  String get settingsBaseUrlRequired => overrides['settingsBaseUrlRequired'] ?? base.settingsBaseUrlRequired;
  @override
  String get settingsNoChanges => overrides['settingsNoChanges'] ?? base.settingsNoChanges;
  @override
  String get settingsWrittenModelSettings => overrides['settingsWrittenModelSettings'] ?? base.settingsWrittenModelSettings;
  @override
  String get settingsWrittenKey => overrides['settingsWrittenKey'] ?? base.settingsWrittenKey;
  @override
  String get settingsRestartSuffix => overrides['settingsRestartSuffix'] ?? base.settingsRestartSuffix;
  @override
  String get settingsClearKeyBody => overrides['settingsClearKeyBody'] ?? base.settingsClearKeyBody;
  @override
  String get settingsClear => overrides['settingsClear'] ?? base.settingsClear;
  @override
  String get settingsKeyCleared => overrides['settingsKeyCleared'] ?? base.settingsKeyCleared;
  @override
  String get settingsConfigErrorHint => overrides['settingsConfigErrorHint'] ?? base.settingsConfigErrorHint;
  @override
  String get settingsConfigUnavailable => overrides['settingsConfigUnavailable'] ?? base.settingsConfigUnavailable;
  @override
  String get settingsConfigUnavailableHint => overrides['settingsConfigUnavailableHint'] ?? base.settingsConfigUnavailableHint;
  @override
  String get settingsConfigFallbackNote => overrides['settingsConfigFallbackNote'] ?? base.settingsConfigFallbackNote;
  @override
  String get settingsModelRestartNote => overrides['settingsModelRestartNote'] ?? base.settingsModelRestartNote;
  @override
  String get settingsKeysNote => overrides['settingsKeysNote'] ?? base.settingsKeysNote;
  @override
  String get settingsKeyConfiguredHint => overrides['settingsKeyConfiguredHint'] ?? base.settingsKeyConfiguredHint;
  @override
  String get settingsKeySampleHint => overrides['settingsKeySampleHint'] ?? base.settingsKeySampleHint;
  @override
  String get settingsModelName => overrides['settingsModelName'] ?? base.settingsModelName;
  @override
  String get settingsBaseUrlNote => overrides['settingsBaseUrlNote'] ?? base.settingsBaseUrlNote;
  @override
  String get settingsClearKey => overrides['settingsClearKey'] ?? base.settingsClearKey;
  @override
  String get settingsReading => overrides['settingsReading'] ?? base.settingsReading;
  @override
  String get settingsStateReadFailed => overrides['settingsStateReadFailed'] ?? base.settingsStateReadFailed;
  @override
  String get settingsNotConfigured => overrides['settingsNotConfigured'] ?? base.settingsNotConfigured;
  @override
  String get settingsSpeakNote => overrides['settingsSpeakNote'] ?? base.settingsSpeakNote;
  @override
  String get settingsSpeakTyping => overrides['settingsSpeakTyping'] ?? base.settingsSpeakTyping;
  @override
  String get settingsSpeakTypingNote => overrides['settingsSpeakTypingNote'] ?? base.settingsSpeakTypingNote;
  @override
  String get settingsSpeakSpeed => overrides['settingsSpeakSpeed'] ?? base.settingsSpeakSpeed;
  @override
  String get settingsSpeakSpeedUnit => overrides['settingsSpeakSpeedUnit'] ?? base.settingsSpeakSpeedUnit;
  @override
  String get settingsSpeakSpeedNote => overrides['settingsSpeakSpeedNote'] ?? base.settingsSpeakSpeedNote;
  @override
  String get settingsCurrentlyActive => overrides['settingsCurrentlyActive'] ?? base.settingsCurrentlyActive;
  @override
  String get settingsSpeakTypingEnabled => overrides['settingsSpeakTypingEnabled'] ?? base.settingsSpeakTypingEnabled;
  @override
  String get settingsSpeakTypingDisabled => overrides['settingsSpeakTypingDisabled'] ?? base.settingsSpeakTypingDisabled;
  @override
  String get settingsSpeakSpeedRange => overrides['settingsSpeakSpeedRange'] ?? base.settingsSpeakSpeedRange;
  @override
  String get settingsSavedRestartNote => overrides['settingsSavedRestartNote'] ?? base.settingsSavedRestartNote;
  @override
  String get settingsSavedLive => overrides['settingsSavedLive'] ?? base.settingsSavedLive;
  @override
  String get settingsSavedRestart => overrides['settingsSavedRestart'] ?? base.settingsSavedRestart;
  @override
  String get settingsDepsAllReady => overrides['settingsDepsAllReady'] ?? base.settingsDepsAllReady;
  @override
  String get settingsDepsNote => overrides['settingsDepsNote'] ?? base.settingsDepsNote;
  @override
  String get settingsDepsProbing => overrides['settingsDepsProbing'] ?? base.settingsDepsProbing;
  @override
  String get settingsDepsInstallLocation => overrides['settingsDepsInstallLocation'] ?? base.settingsDepsInstallLocation;
  @override
  String get settingsDepReadyManaged => overrides['settingsDepReadyManaged'] ?? base.settingsDepReadyManaged;
  @override
  String get settingsDepReadySystem => overrides['settingsDepReadySystem'] ?? base.settingsDepReadySystem;
  @override
  String get settingsDepMismatch => overrides['settingsDepMismatch'] ?? base.settingsDepMismatch;
  @override
  String get settingsDepMissing => overrides['settingsDepMissing'] ?? base.settingsDepMissing;
  @override
  String get settingsDepNoAction => overrides['settingsDepNoAction'] ?? base.settingsDepNoAction;
  @override
  String get settingsDepInstalling => overrides['settingsDepInstalling'] ?? base.settingsDepInstalling;
  @override
  String get settingsInstall => overrides['settingsInstall'] ?? base.settingsInstall;
  @override
  String get settingsDownloadPage => overrides['settingsDownloadPage'] ?? base.settingsDownloadPage;
  @override
  String get settingsOpenDownloadPage => overrides['settingsOpenDownloadPage'] ?? base.settingsOpenDownloadPage;
  @override
  String get settingsDownloadAndInstall => overrides['settingsDownloadAndInstall'] ?? base.settingsDownloadAndInstall;
  @override
  String get settingsStepDownloadFailed => overrides['settingsStepDownloadFailed'] ?? base.settingsStepDownloadFailed;
  @override
  String get settingsStepExtractFailed => overrides['settingsStepExtractFailed'] ?? base.settingsStepExtractFailed;
  @override
  String get settingsStepVerifyFailed => overrides['settingsStepVerifyFailed'] ?? base.settingsStepVerifyFailed;
  @override
  String get settingsStepInstallFailed => overrides['settingsStepInstallFailed'] ?? base.settingsStepInstallFailed;
  @override
  String get settingsUnknown => overrides['settingsUnknown'] ?? base.settingsUnknown;
  @override
  String get settingsRestartRequired => overrides['settingsRestartRequired'] ?? base.settingsRestartRequired;
  @override
  String get settingsProtocolTitle => overrides['settingsProtocolTitle'] ?? base.settingsProtocolTitle;
  @override
  String get settingsProtocolNote => overrides['settingsProtocolNote'] ?? base.settingsProtocolNote;
  @override
  String get settingsProtocolErrorHint => overrides['settingsProtocolErrorHint'] ?? base.settingsProtocolErrorHint;
  @override
  String get settingsProtocolLoading => overrides['settingsProtocolLoading'] ?? base.settingsProtocolLoading;
  @override
  String get settingsProtocolEmpty => overrides['settingsProtocolEmpty'] ?? base.settingsProtocolEmpty;
  @override
  String get settingsProtocolEmptyHint => overrides['settingsProtocolEmptyHint'] ?? base.settingsProtocolEmptyHint;
  @override
  String get settingsProtocolEnabled => overrides['settingsProtocolEnabled'] ?? base.settingsProtocolEnabled;
  @override
  String get settingsProtocolEnabledNote => overrides['settingsProtocolEnabledNote'] ?? base.settingsProtocolEnabledNote;
  @override
  String get settingsInstallDir => overrides['settingsInstallDir'] ?? base.settingsInstallDir;
  @override
  String get settingsInstallDirHint => overrides['settingsInstallDirHint'] ?? base.settingsInstallDirHint;
  @override
  String get settingsSaveDir => overrides['settingsSaveDir'] ?? base.settingsSaveDir;
  @override
  String get settingsInstallDirNote => overrides['settingsInstallDirNote'] ?? base.settingsInstallDirNote;
  @override
  String get settingsOneClickInstall => overrides['settingsOneClickInstall'] ?? base.settingsOneClickInstall;
  @override
  String get settingsOneClickInstallNote => overrides['settingsOneClickInstallNote'] ?? base.settingsOneClickInstallNote;
  @override
  String get settingsOneClickPrerequisite => overrides['settingsOneClickPrerequisite'] ?? base.settingsOneClickPrerequisite;
  @override
  String get settingsInstallRunningNote => overrides['settingsInstallRunningNote'] ?? base.settingsInstallRunningNote;
  @override
  String get settingsInstallLogEmpty => overrides['settingsInstallLogEmpty'] ?? base.settingsInstallLogEmpty;
  @override
  String get settingsInstallLog => overrides['settingsInstallLog'] ?? base.settingsInstallLog;
  @override
  String get settingsInstalledNextTitle => overrides['settingsInstalledNextTitle'] ?? base.settingsInstalledNextTitle;
  @override
  String get settingsInstalledNextBody => overrides['settingsInstalledNextBody'] ?? base.settingsInstalledNextBody;
  @override
  String get settingsInstallDirEmpty => overrides['settingsInstallDirEmpty'] ?? base.settingsInstallDirEmpty;
  @override
  String get settingsEntryFound => overrides['settingsEntryFound'] ?? base.settingsEntryFound;
  @override
  String get settingsEntryMissing => overrides['settingsEntryMissing'] ?? base.settingsEntryMissing;
  @override
  String get settingsEntryPendingRestart => overrides['settingsEntryPendingRestart'] ?? base.settingsEntryPendingRestart;
  @override
  String get settingsStart => overrides['settingsStart'] ?? base.settingsStart;
  @override
  String get settingsStop => overrides['settingsStop'] ?? base.settingsStop;
  @override
  String get settingsOpenPanel => overrides['settingsOpenPanel'] ?? base.settingsOpenPanel;
  @override
  String get settingsProtocolNotAttachedNote => overrides['settingsProtocolNotAttachedNote'] ?? base.settingsProtocolNotAttachedNote;
  @override
  String get settingsChainProcess => overrides['settingsChainProcess'] ?? base.settingsChainProcess;
  @override
  String get settingsChainUnobserved => overrides['settingsChainUnobserved'] ?? base.settingsChainUnobserved;
  @override
  String get settingsChainNoInstance => overrides['settingsChainNoInstance'] ?? base.settingsChainNoInstance;
  @override
  String get settingsChainNotRunning => overrides['settingsChainNotRunning'] ?? base.settingsChainNotRunning;
  @override
  String get settingsChainNoPort => overrides['settingsChainNoPort'] ?? base.settingsChainNoPort;
  @override
  String get settingsChainSpawned => overrides['settingsChainSpawned'] ?? base.settingsChainSpawned;
  @override
  String get settingsChainDiscovered => overrides['settingsChainDiscovered'] ?? base.settingsChainDiscovered;
  @override
  String get settingsChainPortOnly => overrides['settingsChainPortOnly'] ?? base.settingsChainPortOnly;
  @override
  String get settingsChainRunning => overrides['settingsChainRunning'] ?? base.settingsChainRunning;
  @override
  String get settingsChainOneBotConfig => overrides['settingsChainOneBotConfig'] ?? base.settingsChainOneBotConfig;
  @override
  String get settingsChainWithToken => overrides['settingsChainWithToken'] ?? base.settingsChainWithToken;
  @override
  String get settingsChainNoToken => overrides['settingsChainNoToken'] ?? base.settingsChainNoToken;
  @override
  String get settingsChainPresent => overrides['settingsChainPresent'] ?? base.settingsChainPresent;
  @override
  String get settingsChainUnreadable => overrides['settingsChainUnreadable'] ?? base.settingsChainUnreadable;
  @override
  String get settingsChainMissing => overrides['settingsChainMissing'] ?? base.settingsChainMissing;
  @override
  String get settingsChainMissingDetail => overrides['settingsChainMissingDetail'] ?? base.settingsChainMissingDetail;
  @override
  String get settingsChainAdapter => overrides['settingsChainAdapter'] ?? base.settingsChainAdapter;
  @override
  String get settingsChainConnected => overrides['settingsChainConnected'] ?? base.settingsChainConnected;
  @override
  String get settingsChainReconnecting => overrides['settingsChainReconnecting'] ?? base.settingsChainReconnecting;
  @override
  String get settingsChainNoEndpoint => overrides['settingsChainNoEndpoint'] ?? base.settingsChainNoEndpoint;
  @override
  String get settingsChainNoEndpointDetail => overrides['settingsChainNoEndpointDetail'] ?? base.settingsChainNoEndpointDetail;
  @override
  String get settingsChainDisabled => overrides['settingsChainDisabled'] ?? base.settingsChainDisabled;
  @override
  String get settingsChainNotAssembled => overrides['settingsChainNotAssembled'] ?? base.settingsChainNotAssembled;
  @override
  String get settingsChainNotAssembledDetail => overrides['settingsChainNotAssembledDetail'] ?? base.settingsChainNotAssembledDetail;
  @override
  String get settingsChainNoData => overrides['settingsChainNoData'] ?? base.settingsChainNoData;
  @override
  String get settingsCredentialLost => overrides['settingsCredentialLost'] ?? base.settingsCredentialLost;
  @override
  String get settingsConsentPending => overrides['settingsConsentPending'] ?? base.settingsConsentPending;
  @override
  String get settingsPasswordUnchanged => overrides['settingsPasswordUnchanged'] ?? base.settingsPasswordUnchanged;
  @override
  String get settingsCredentialCopied => overrides['settingsCredentialCopied'] ?? base.settingsCredentialCopied;
  @override
  String get settingsCopyCredential => overrides['settingsCopyCredential'] ?? base.settingsCopyCredential;
  @override
  String get settingsProtocolRestartNote => overrides['settingsProtocolRestartNote'] ?? base.settingsProtocolRestartNote;
  @override
  String get settingsInstallDirRequired => overrides['settingsInstallDirRequired'] ?? base.settingsInstallDirRequired;
  @override
  String get settingsStartRequested => overrides['settingsStartRequested'] ?? base.settingsStartRequested;
  @override
  String get settingsStopRequested => overrides['settingsStopRequested'] ?? base.settingsStopRequested;
  @override
  String get settingsOneClickFailed => overrides['settingsOneClickFailed'] ?? base.settingsOneClickFailed;
  @override
  String get settingsInstallNoReason => overrides['settingsInstallNoReason'] ?? base.settingsInstallNoReason;
  @override
  String get settingsInstalledOk => overrides['settingsInstalledOk'] ?? base.settingsInstalledOk;
  @override
  String get settingsInstalledConfigured => overrides['settingsInstalledConfigured'] ?? base.settingsInstalledConfigured;
  @override
  String get settingsInstalledNotConfigured => overrides['settingsInstalledNotConfigured'] ?? base.settingsInstalledNotConfigured;
  @override
  String get settingsRestartSuffixParen => overrides['settingsRestartSuffixParen'] ?? base.settingsRestartSuffixParen;
  @override
  String get settingsGenerated => overrides['settingsGenerated'] ?? base.settingsGenerated;
  @override
  String get settingsNotGenerated => overrides['settingsNotGenerated'] ?? base.settingsNotGenerated;
  @override
  String get settingsWebhookNote => overrides['settingsWebhookNote'] ?? base.settingsWebhookNote;
  @override
  String get settingsWebhookLoading => overrides['settingsWebhookLoading'] ?? base.settingsWebhookLoading;
  @override
  String get settingsWebhookCurrent => overrides['settingsWebhookCurrent'] ?? base.settingsWebhookCurrent;
  @override
  String get settingsWebhookNotConfiguredNote => overrides['settingsWebhookNotConfiguredNote'] ?? base.settingsWebhookNotConfiguredNote;
  @override
  String get settingsWebhookRotated => overrides['settingsWebhookRotated'] ?? base.settingsWebhookRotated;
  @override
  String get settingsWebhookNever => overrides['settingsWebhookNever'] ?? base.settingsWebhookNever;
  @override
  String get settingsRegenerate => overrides['settingsRegenerate'] ?? base.settingsRegenerate;
  @override
  String get settingsGenerateWebhook => overrides['settingsGenerateWebhook'] ?? base.settingsGenerateWebhook;
  @override
  String get settingsWebhookCredentialNote => overrides['settingsWebhookCredentialNote'] ?? base.settingsWebhookCredentialNote;
  @override
  String get settingsRegenerateTitle => overrides['settingsRegenerateTitle'] ?? base.settingsRegenerateTitle;
  @override
  String get settingsRegenerateBody => overrides['settingsRegenerateBody'] ?? base.settingsRegenerateBody;
  @override
  String get settingsNoTokenReturned => overrides['settingsNoTokenReturned'] ?? base.settingsNoTokenReturned;
  @override
  String get settingsWebhookRotatedNote => overrides['settingsWebhookRotatedNote'] ?? base.settingsWebhookRotatedNote;
  @override
  String get settingsMemoryNote => overrides['settingsMemoryNote'] ?? base.settingsMemoryNote;
  @override
  String get settingsNotInEffect => overrides['settingsNotInEffect'] ?? base.settingsNotInEffect;
  @override
  String get settingsMemoryEnableLabel => overrides['settingsMemoryEnableLabel'] ?? base.settingsMemoryEnableLabel;
  @override
  String get settingsMemoryEnableNote => overrides['settingsMemoryEnableNote'] ?? base.settingsMemoryEnableNote;
  @override
  String get settingsMemoryOn => overrides['settingsMemoryOn'] ?? base.settingsMemoryOn;
  @override
  String get settingsMemoryOff => overrides['settingsMemoryOff'] ?? base.settingsMemoryOff;
  @override
  String get settingsMemoryUnaffectedNote => overrides['settingsMemoryUnaffectedNote'] ?? base.settingsMemoryUnaffectedNote;
  @override
  String get settingsMemoryRestartNote => overrides['settingsMemoryRestartNote'] ?? base.settingsMemoryRestartNote;
  @override
  String get settingsMemoryDetail => overrides['settingsMemoryDetail'] ?? base.settingsMemoryDetail;
  @override
  String get settingsMemoryCost => overrides['settingsMemoryCost'] ?? base.settingsMemoryCost;
  @override
  String get settingsMemoryOnSaved => overrides['settingsMemoryOnSaved'] ?? base.settingsMemoryOnSaved;
  @override
  String get settingsMemoryOffSaved => overrides['settingsMemoryOffSaved'] ?? base.settingsMemoryOffSaved;
  @override
  String get settingsTrustNote => overrides['settingsTrustNote'] ?? base.settingsTrustNote;
  @override
  String get settingsTrustReachLabel => overrides['settingsTrustReachLabel'] ?? base.settingsTrustReachLabel;
  @override
  String get settingsTrustReachNote => overrides['settingsTrustReachNote'] ?? base.settingsTrustReachNote;
  @override
  String get settingsTrustWorkspaceUnknownPath => overrides['settingsTrustWorkspaceUnknownPath'] ?? base.settingsTrustWorkspaceUnknownPath;
  @override
  String get settingsTrustFullValue => overrides['settingsTrustFullValue'] ?? base.settingsTrustFullValue;
  @override
  String get settingsTrustPendingNote => overrides['settingsTrustPendingNote'] ?? base.settingsTrustPendingNote;
  @override
  String get settingsTrustRootNote => overrides['settingsTrustRootNote'] ?? base.settingsTrustRootNote;
  @override
  String get settingsTrustBoundaryNote => overrides['settingsTrustBoundaryNote'] ?? base.settingsTrustBoundaryNote;
  @override
  String get settingsTrustRulesDetail => overrides['settingsTrustRulesDetail'] ?? base.settingsTrustRulesDetail;
  @override
  String get settingsTrustFullTitle => overrides['settingsTrustFullTitle'] ?? base.settingsTrustFullTitle;
  @override
  String get settingsTrustFullConfirmTail => overrides['settingsTrustFullConfirmTail'] ?? base.settingsTrustFullConfirmTail;
  @override
  String get settingsTrustWorkspaceSaved => overrides['settingsTrustWorkspaceSaved'] ?? base.settingsTrustWorkspaceSaved;
  @override
  String get settingsTrustFullSaved => overrides['settingsTrustFullSaved'] ?? base.settingsTrustFullSaved;
  @override
  String get settingsSystemNote => overrides['settingsSystemNote'] ?? base.settingsSystemNote;
  @override
  String get settingsDataDir => overrides['settingsDataDir'] ?? base.settingsDataDir;
  @override
  String get settingsDataDirNote => overrides['settingsDataDirNote'] ?? base.settingsDataDirNote;
  @override
  String get settingsSystemFootnote => overrides['settingsSystemFootnote'] ?? base.settingsSystemFootnote;
  @override
  String get settingsLiveNow => overrides['settingsLiveNow'] ?? base.settingsLiveNow;
  @override
  String get settingsEdit => overrides['settingsEdit'] ?? base.settingsEdit;
  @override
  String get settingsAccountNote => overrides['settingsAccountNote'] ?? base.settingsAccountNote;
  @override
  String get settingsAccountLegacyBadge => overrides['settingsAccountLegacyBadge'] ?? base.settingsAccountLegacyBadge;
  @override
  String get settingsAccountSessionBadge => overrides['settingsAccountSessionBadge'] ?? base.settingsAccountSessionBadge;
  @override
  String get settingsAccountInstance => overrides['settingsAccountInstance'] ?? base.settingsAccountInstance;
  @override
  String get settingsAccountInstanceNote => overrides['settingsAccountInstanceNote'] ?? base.settingsAccountInstanceNote;
  @override
  String get settingsAccountLegacyNote => overrides['settingsAccountLegacyNote'] ?? base.settingsAccountLegacyNote;
  @override
  String get settingsChangePassword => overrides['settingsChangePassword'] ?? base.settingsChangePassword;
  @override
  String get settingsLogout => overrides['settingsLogout'] ?? base.settingsLogout;
  @override
  String get settingsSetPasswordFirst => overrides['settingsSetPasswordFirst'] ?? base.settingsSetPasswordFirst;
  @override
  String get settingsPasswordChanged => overrides['settingsPasswordChanged'] ?? base.settingsPasswordChanged;
  @override
  String get settingsLogoutBody => overrides['settingsLogoutBody'] ?? base.settingsLogoutBody;
  @override
  String get settingsAboutNote => overrides['settingsAboutNote'] ?? base.settingsAboutNote;
  @override
  String get settingsAboutBadge => overrides['settingsAboutBadge'] ?? base.settingsAboutBadge;
  @override
  String get settingsVersionLabel => overrides['settingsVersionLabel'] ?? base.settingsVersionLabel;
  @override
  String get settingsGuardedDays => overrides['settingsGuardedDays'] ?? base.settingsGuardedDays;
  @override
  String get settingsWatermark => overrides['settingsWatermark'] ?? base.settingsWatermark;
  @override
  String get settingsProjectionFootnote => overrides['settingsProjectionFootnote'] ?? base.settingsProjectionFootnote;
  @override
  String get settingsDestructivePolicy => overrides['settingsDestructivePolicy'] ?? base.settingsDestructivePolicy;
  @override
  String get settingsModify => overrides['settingsModify'] ?? base.settingsModify;
  @override
  String get settingsPolicyNoneOption => overrides['settingsPolicyNoneOption'] ?? base.settingsPolicyNoneOption;
  @override
  String get settingsPolicyAllOption => overrides['settingsPolicyAllOption'] ?? base.settingsPolicyAllOption;
  @override
  String get settingsPolicyListOption => overrides['settingsPolicyListOption'] ?? base.settingsPolicyListOption;
  @override
  String get settingsPolicyListTitle => overrides['settingsPolicyListTitle'] ?? base.settingsPolicyListTitle;
  @override
  String get settingsPolicyNoTools => overrides['settingsPolicyNoTools'] ?? base.settingsPolicyNoTools;
  @override
  String get settingsDestructiveTitle => overrides['settingsDestructiveTitle'] ?? base.settingsDestructiveTitle;
  @override
  String get settingsDestructiveRelaxedBody => overrides['settingsDestructiveRelaxedBody'] ?? base.settingsDestructiveRelaxedBody;
  @override
  String get settingsDestructiveRestrictedBody => overrides['settingsDestructiveRestrictedBody'] ?? base.settingsDestructiveRestrictedBody;
  @override
  String get settingsPolicyAll => overrides['settingsPolicyAll'] ?? base.settingsPolicyAll;
  @override
  String get settingsPolicyListEmpty => overrides['settingsPolicyListEmpty'] ?? base.settingsPolicyListEmpty;
  @override
  String get settingsPolicyNone => overrides['settingsPolicyNone'] ?? base.settingsPolicyNone;
  @override
  String get settingsListAnd => overrides['settingsListAnd'] ?? base.settingsListAnd;
  @override
  String get settingsUnknownReason => overrides['settingsUnknownReason'] ?? base.settingsUnknownReason;
  @override
  String get settingsSeeOfficialDocs => overrides['settingsSeeOfficialDocs'] ?? base.settingsSeeOfficialDocs;
  @override
  String get settingsWebhookCurlTokenPlaceholder => overrides['settingsWebhookCurlTokenPlaceholder'] ?? base.settingsWebhookCurlTokenPlaceholder;
  @override
  String get settingsWebhookCurlSampleText => overrides['settingsWebhookCurlSampleText'] ?? base.settingsWebhookCurlSampleText;

  @override
  String expandAll(int chars) => base.expandAll(chars);
  @override
  String loadFailed(String reason) => base.loadFailed(reason);
  @override
  String configReadFailed(String reason) => base.configReadFailed(reason);
  @override
  String restartConfirmed(String evidence) => base.restartConfirmed(evidence);
  @override
  String restartEvidence(int backendPid, bool portReady) => base.restartEvidence(backendPid, portReady);
  @override
  String restartFailed(String reason) => base.restartFailed(reason);
  @override
  String restartRefused(String reason) => base.restartRefused(reason);
  @override
  String restartBackTimeout(int seconds) => base.restartBackTimeout(seconds);
  @override
  String quitAllConfirmBody(bool busy) => base.quitAllConfirmBody(busy);
  @override
  String quitAllFailed(String reason) => base.quitAllFailed(reason);
  @override
  String onboardingSecretConfigured(String? mask) => base.onboardingSecretConfigured(mask);
  @override
  String onboardingDepsItemFailed(String reason) => base.onboardingDepsItemFailed(reason);
  @override
  String onboardingDepsSummary(int ok, int failed) => base.onboardingDepsSummary(ok, failed);
  @override
  String onboardingDepsLastRun(int ok, int failed) => base.onboardingDepsLastRun(ok, failed);
  @override
  String onboardingDepsReadFailed(String reason) => base.onboardingDepsReadFailed(reason);
  @override
  String onboardingOpenLinkFailed(String url) => base.onboardingOpenLinkFailed(url);
  @override
  String onboardingChannelSaveFailed(String reason) => base.onboardingChannelSaveFailed(reason);
  @override
  String onboardingSecretsSaveFailed(String reason) => base.onboardingSecretsSaveFailed(reason);
  @override
  String receivedFrom(String sender, String id) => base.receivedFrom(sender, id);
  @override
  String mentionsYou(String where) => base.mentionsYou(where);
  @override
  String talkingAbout(String what) => base.talkingAbout(what);
  @override
  String fromWho(String who) => base.fromWho(who);
  @override
  String scheduledAt(String at) => base.scheduledAt(at);
  @override
  String thinkingStep(String step) => base.thinkingStep(step);
  @override
  String thinkingChars(String chars) => base.thinkingChars(chars);
  @override
  String thinkingElapsed(String elapsed) => base.thinkingElapsed(elapsed);
  @override
  String compactChars(int chars) => base.compactChars(chars);
  @override
  String toastClearFailed(String reason) => base.toastClearFailed(reason);
  @override
  String toastTriggerFailed(String reason) => base.toastTriggerFailed(reason);
  @override
  String toastSendFailed(String reason) => base.toastSendFailed(reason);
  @override
  String stringsOverrideLoaded(int zh, int en) => base.stringsOverrideLoaded(zh, en);
  @override
  String stringsOverrideFailed(String reason) => base.stringsOverrideFailed(reason);
  @override
  String stringsOverrideUnreadable(String detail) => base.stringsOverrideUnreadable(detail);
  @override
  String stringsOverrideBadJson(String detail) => base.stringsOverrideBadJson(detail);
  @override
  String stringsOverrideIgnored(int count) => base.stringsOverrideIgnored(count);
  @override
  String stringsOverrideExported(String path) => base.stringsOverrideExported(path);
  @override
  String stringsOverrideExportFailed(String reason) => base.stringsOverrideExportFailed(reason);
  @override
  String stringsOverrideOpenFailed(String path) => base.stringsOverrideOpenFailed(path);
  @override
  String overviewAdviceLine(String title, String body) => base.overviewAdviceLine(title, body);
  @override
  String overviewDeadLetterLine(int seq, int claimCount, String? stamp) => base.overviewDeadLetterLine(seq, claimCount, stamp);
  @override
  String overviewPendingCount(int count) => base.overviewPendingCount(count);
  @override
  String overviewTodayUsageTooltip(String exact) => base.overviewTodayUsageTooltip(exact);
  @override
  String overviewTimerCancelBody(String timerId) => base.overviewTimerCancelBody(timerId);
  @override
  String overviewTimerCancelled(String timerId) => base.overviewTimerCancelled(timerId);
  @override
  String overviewTimerCancelFailed(String timerId, String reason) => base.overviewTimerCancelFailed(timerId, reason);
  @override
  String overviewTimerCancelToastFailed(String reason) => base.overviewTimerCancelToastFailed(reason);
  @override
  String overviewMarkFailedToast(String reason) => base.overviewMarkFailedToast(reason);
  @override
  String overviewDeadRequeued(int seq) => base.overviewDeadRequeued(seq);
  @override
  String overviewDeadDiscardBody(int inputSeq) => base.overviewDeadDiscardBody(inputSeq);
  @override
  String overviewDeadDiscarded(int seq) => base.overviewDeadDiscarded(seq);
  @override
  String overviewDeadActionFailed(String verb, int seq, String reason) => base.overviewDeadActionFailed(verb, seq, reason);
  @override
  String overviewDeadActionToastFailed(String verb, String reason) => base.overviewDeadActionToastFailed(verb, reason);
  @override
  String overviewHistoricalBadge(String label) => base.overviewHistoricalBadge(label);
  @override
  String overviewSourceFramework(String? fingerprint) => base.overviewSourceFramework(fingerprint);
  @override
  String overviewSourceChat(String who) => base.overviewSourceChat(who);
  @override
  String overviewQuote(String text) => base.overviewQuote(text);
  @override
  String overviewGroupsCount(int count) => base.overviewGroupsCount(count);
  @override
  String overviewSinglesCount(int count) => base.overviewSinglesCount(count);
  @override
  String overviewOthersCount(int count) => base.overviewOthersCount(count);
  @override
  String overviewUnreadTotal(int count) => base.overviewUnreadTotal(count);
  @override
  String overviewMessagesSeen(int count) => base.overviewMessagesSeen(count);
  @override
  String overviewUnreadBadge(int count) => base.overviewUnreadBadge(count);
  @override
  String overviewTimersWaiting(int count) => base.overviewTimersWaiting(count);
  @override
  String overviewTimerCron(String cron) => base.overviewTimerCron(cron);
  @override
  String overviewTimerPayload(String payload) => base.overviewTimerPayload(payload);
  @override
  String overviewExternalSessionsError(String reason) => base.overviewExternalSessionsError(reason);
  @override
  String overviewFrameworkNotesError(String reason) => base.overviewFrameworkNotesError(reason);
  @override
  String settingsSysEmptyError(String label) => base.settingsSysEmptyError(label);
  @override
  String settingsSysIntRequired(String label) => base.settingsSysIntRequired(label);
  @override
  String settingsSysPortRange(String label) => base.settingsSysPortRange(label);
  @override
  String settingsSysMinOne(String label) => base.settingsSysMinOne(label);
  @override
  String settingsSysRatioRequired(String label) => base.settingsSysRatioRequired(label);
  @override
  String settingsSysRatioRange(String label) => base.settingsSysRatioRange(label);
  @override
  String settingsSysMin(String label, int lo) => base.settingsSysMin(label, lo);
  @override
  String settingsSysMax(String label, int hi) => base.settingsSysMax(label, hi);
  @override
  String settingsTrustConsequenceWorkspace(String root) => base.settingsTrustConsequenceWorkspace(root);
  @override
  String settingsSaveFailed(String err) => base.settingsSaveFailed(err);
  @override
  String settingsClearFailed(String err) => base.settingsClearFailed(err);
  @override
  String settingsKeysReadFailedHint(String keysError) => base.settingsKeysReadFailedHint(keysError);
  @override
  String settingsKeyEnvNote(String envName) => base.settingsKeyEnvNote(envName);
  @override
  String settingsSpeakTypingOn(String saved) => base.settingsSpeakTypingOn(saved);
  @override
  String settingsSpeakTypingOff(String saved) => base.settingsSpeakTypingOff(saved);
  @override
  String settingsDepsReadFailedHint(String depsError) => base.settingsDepsReadFailedHint(depsError);
  @override
  String settingsInstallRequestFailed(String err) => base.settingsInstallRequestFailed(err);
  @override
  String settingsOpenedUrl(String url) => base.settingsOpenedUrl(url);
  @override
  String settingsProtocolError(String protocolError) => base.settingsProtocolError(protocolError);
  @override
  String settingsInstallManualRoute(String protocolDownloadUrl) => base.settingsInstallManualRoute(protocolDownloadUrl);
  @override
  String settingsEndpointPoint(String wsUrl) => base.settingsEndpointPoint(wsUrl);
  @override
  String settingsChainListening(String url) => base.settingsChainListening(url);
  @override
  String settingsChainEndpoint(String ws) => base.settingsChainEndpoint(ws);
  @override
  String settingsChainDelivered(String delivered) => base.settingsChainDelivered(delivered);
  @override
  String settingsChainBackoff(String attempts) => base.settingsChainBackoff(attempts);
  @override
  String settingsCredentialCaptured(String user, String masked) => base.settingsCredentialCaptured(user, masked);
  @override
  String settingsCredentialFromLog(String user, String masked) => base.settingsCredentialFromLog(user, masked);
  @override
  String settingsQrLoginAt(String webuiUrl) => base.settingsQrLoginAt(webuiUrl);
  @override
  String settingsManualDownloadGuide(String protocolDownloadUrl) => base.settingsManualDownloadGuide(protocolDownloadUrl);
  @override
  String settingsInstallRequestFailedHint(String err) => base.settingsInstallRequestFailedHint(err);
  @override
  String settingsWebhookErrorHint(String webhookError) => base.settingsWebhookErrorHint(webhookError);
  @override
  String settingsWebhookCurrentValue(String secretId, String createdAt) => base.settingsWebhookCurrentValue(secretId, createdAt);
  @override
  String settingsWebhookBy(String by) => base.settingsWebhookBy(by);
  @override
  String settingsGenerateFailed(String err) => base.settingsGenerateFailed(err);
  @override
  String settingsTrustWorkspaceValue(String root) => base.settingsTrustWorkspaceValue(root);
  @override
  String settingsProjectionReadFailedHint(String projError) => base.settingsProjectionReadFailedHint(projError);
  @override
  String settingsDaysCount(String days) => base.settingsDaysCount(days);
  @override
  String settingsDaysSince(String days, String stamp) => base.settingsDaysSince(days, stamp);
  @override
  String settingsSaved(String written, String restart) => base.settingsSaved(written, restart);
  @override
  String settingsClearKeyTitle(String laneLabel) => base.settingsClearKeyTitle(laneLabel);
  @override
  String settingsKeyConfiguredMask(String mask) => base.settingsKeyConfiguredMask(mask);
  @override
  String settingsDepPipUnavailable(String? reason) => base.settingsDepPipUnavailable(reason);
  @override
  String settingsInstallConfirmBody(String managedDir) => base.settingsInstallConfirmBody(managedDir);
  @override
  String settingsDepReadyToast(String label, String version) => base.settingsDepReadyToast(label, version);
  @override
  String settingsStepErrorToast(String step, String error) => base.settingsStepErrorToast(step, error);
  @override
  String settingsNoDownloadPage(String hint) => base.settingsNoDownloadPage(hint);
  @override
  String settingsOpenUrlFailed(String url, String? hint) => base.settingsOpenUrlFailed(url, hint);
  @override
  String settingsInstalledVersion(String? version) => base.settingsInstalledVersion(version);
  @override
  String settingsWriteErrorNote(String writeError) => base.settingsWriteErrorNote(writeError);
  @override
  String settingsChainSince(String when) => base.settingsChainSince(when);
  @override
  String settingsChainUnreadableDetail(String path) => base.settingsChainUnreadableDetail(path);
  @override
  String settingsProtocolToggled(bool on, bool restart) => base.settingsProtocolToggled(on, restart);
  @override
  String settingsInstallDirSaved(String saved, bool restart) => base.settingsInstallDirSaved(saved, restart);
  @override
  String settingsProtocolActionFailed(bool start, String err) => base.settingsProtocolActionFailed(start, err);
  @override
  String settingsWebhookFileNote(String file) => base.settingsWebhookFileNote(file);
  @override
  String settingsTrustFullBody(String consequence) => base.settingsTrustFullBody(consequence);
  @override
  String settingsPolicyListCount(int count) => base.settingsPolicyListCount(count);
  @override
  String settingsDepsSuggested(int count) => base.settingsDepsSuggested(count);
  @override
  String settingsDepPipReady(String version) => base.settingsDepPipReady(version);
  @override
  String settingsDepPurposeImpact(String purpose, String impact) => base.settingsDepPurposeImpact(purpose, impact);
  @override
  String settingsInstallTitle(String label) => base.settingsInstallTitle(label);
  @override
  String settingsPolicySave(int count) => base.settingsPolicySave(count);
  @override
  String settingsInstallHead(bool ok, String? version, bool configured) =>
      base.settingsInstallHead(ok, version, configured);
}
