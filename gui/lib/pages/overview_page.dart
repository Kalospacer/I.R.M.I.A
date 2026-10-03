import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';

import '../app.dart';
import '../theme.dart';
import '../ui_kit.dart';
import 'page_chrome.dart';

/// 运行情况页（默认首页）——与 Web 端同构。
/// 状态卡 → 磁贴四枚（带 24h 趋势）→ 建议 → 外部会话 → 框架提示 → 最近事件（默认 8 条）。
///
/// 「外部会话」与「框架提示」两张卡（v33）答的是用户自己的两个问题：
/// **她手边那个软件里攒了多少**（谁来过、她还没看的有几条）、**框架有没有替她留意到什么**
/// （注入预警、告警）。数据分别来自 `GET /api/sessions` 与 `GET /api/framework-notes`，
/// 两张卡**各有自己的三态**——它们读的是附加信息，读不到时该灰的是这张卡，不是整页。
class OverviewPage extends StatefulWidget {
  const OverviewPage({super.key, required this.state});
  final AppState state;

  @override
  State<OverviewPage> createState() => _OverviewPageState();
}

class _OverviewPageState extends State<OverviewPage> {
  Map<String, dynamic>? stats;
  Map<String, dynamic>? proj;
  String? error;
  bool loading = true;

  /// 外部会话（她见过的会话 + 各自的积累）。`null` 有两种含义，靠 [sessionsError] 与
  /// [sessionsLoading] 区分：还在读 / 读失败 / 读到了但是空的。
  List<_SessionRow>? sessions;
  String? sessionsError;
  bool sessionsLoading = true;

  /// 框架提示（注入预警 + 告警）。空列表是**常态**，不是异常。
  List<_FrameworkNote>? notes;
  String? notesError;
  bool notesLoading = true;

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_onStateChange);
    unawaited(load());
  }

  @override
  void dispose() {
    widget.state.removeListener(_onStateChange);
    super.dispose();
  }

  void _onStateChange() {
    if (widget.state.online && error != null) unawaited(load());
  }

  Future<void> load() async {
    final api = widget.state.api;
    // 两张附加卡各自吃自己的错（内部 try/catch），但**和主数据一起等**：
    // 下拉刷新等人等的应该是同一件事，而不是主卡先回来、附加卡等一下再跳出来
    final extras = Future.wait([_loadSessions(), _loadNotes()]);
    try {
      final results = await Future.wait([
        api.get('/api/stats/dashboard'),
        api.get('/api/projection'),
      ]);
      if (mounted) {
        setState(() {
          stats = results[0] is Map<String, dynamic> ? results[0] as Map<String, dynamic> : null;
          proj = results[1] is Map<String, dynamic> ? results[1] as Map<String, dynamic> : null;
          error = null;
          loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() {
          error = err.toString();
          loading = false;
        });
      }
    }
    await extras;
  }

  /// 会话清单：她见过谁、谁那里攒了多少条没看。
  ///
  /// 与 [`/api/stats/dashboard`] 分开取的理由不只是"职责清楚"：这段数据变了不影响状态卡，
  /// 而读失败时**只有这张卡**该灰（卡片自己的三态），整页照常可用。
  Future<void> _loadSessions() async {
    if (mounted) setState(() => sessionsLoading = true);
    try {
      final data = await widget.state.api.get('/api/sessions');
      final list = data is Map ? data['sessions'] : null;
      if (!mounted) return;
      setState(() {
        sessions = list is List
            ? [for (final item in list) _SessionRow.from(item)]
            : null;
        // 非对象/缺字段当"读失败"而不是"没有会话"：说"没有"是断言，得先真的读到
        sessionsError = sessions == null ? '返回的数据不是会话清单' : null;
        sessionsLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        sessionsError = err.toString();
        sessionsLoading = false;
      });
    }
  }

  /// 框架提示：注入预警与告警。空数组是常态（没有提示 = 一切都好），照样进空态。
  Future<void> _loadNotes() async {
    if (mounted) setState(() => notesLoading = true);
    try {
      final data = await widget.state.api.get('/api/framework-notes');
      final list = data is Map ? data['notes'] : null;
      if (!mounted) return;
      setState(() {
        notes = list is List ? [for (final item in list) _FrameworkNote.from(item)] : null;
        notesError = notes == null ? '返回的数据不是提示清单' : null;
        notesLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        notesError = err.toString();
        notesLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const PageHeader(title: '运行情况', subtitle: '当前状态、用量与待确认项'),
        Expanded(
          child: RefreshIndicator(
            onRefresh: load,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(26, 16, 26, 30),
              children: [
                if (loading) const _Loading() else if (error != null) _ErrorBlock(message: error!, onRetry: load) else ...[
                  _HeroCard(state: widget.state, stats: stats, onRestart: _restart, onGoto: _goto),
                  if (_reviewItems.isNotEmpty) _ReviewCard(items: _reviewItems, onResolve: _resolve),
                  const SizedBox(height: 16),
                  _Tiles(stats: stats, proj: proj),
                  if (_advice.isNotEmpty) ...[
                    const SizedBox(height: 18),
                    const _SectionTitle('建议'),
                    CappedChildren(children: [
                      for (final item in _advice) _AdviceCard(text: item, onTap: () => _goto('persona')),
                    ]),
                  ],
                  const SizedBox(height: 16),
                  _ExternalSessionsCard(
                    sessions: sessions,
                    error: sessionsError,
                    loading: sessionsLoading,
                    onRetry: _loadSessions,
                  ),
                  const SizedBox(height: 16),
                  _FrameworkNotesCard(
                    notes: notes,
                    error: notesError,
                    loading: notesLoading,
                    onRetry: _loadNotes,
                  ),
                  const SizedBox(height: 18),
                  const _SectionTitle('最近事件'),
                  _RecentList(stats: stats, onWake: () => unawaited(_restart())),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  List<Map<String, dynamic>> get _reviewItems {
    final raw = proj?['needsReview'];
    if (raw is! List) return const [];
    return raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }

  List<String> get _advice {
    final out = <String>[];
    final list = stats?['suggestions'];
    if (list is List) {
      for (final s in list.whereType<Map>()) {
        final title = s['title']?.toString() ?? '';
        final body = s['body']?.toString() ?? '';
        if (title.isNotEmpty) out.add(body.isEmpty ? title : '$title：$body');
      }
    }
    if (stats?['personaIsSeed'] == true) {
      out.add('人格资产未初始化：IDENTITY.md 仍为模板，先补全身份与语气。');
    }
    return out;
  }

  /// **重启前后端**（用户 2026-10-04：原来这里是"立即唤醒"，那个功能已经没用了）。
  ///
  /// 界面把自己的可执行路径一起发过去——脚本不该猜界面装在哪；给了路径它就连界面一起重启。
  /// 服务端会用 WMI 起一个**分离的** pwsh 去跑 tools/restart-agent.ps1（本进程不能自己重启
  /// 自己），并延迟两秒动手，好让这次回执先发回来。
  Future<void> _restart() async {
    try {
      await widget.state.api.post(
        '/api/commands/restart',
        {'guiExe': Platform.resolvedExecutable},
        confirm: 'restart',
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('正在重启前后端（约 20 秒）')),
        );
      }
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('重启失败：$err')));
      }
    }
  }

  Future<void> _resolve(String callId, String outcome) async {
    try {
      await widget.state.api.post('/api/commands/review-resolve', {
        'callId': callId,
        'outcome': outcome,
        'note': '',
      });
      await load();
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('标记失败：$err')));
      }
    }
  }

  void _goto(String pageId) => widget.state.setPage(pageId);
}

class _Loading extends StatelessWidget {
  const _Loading();
  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.symmetric(vertical: 60),
        child: Center(child: CircularProgressIndicator()),
      );
}

class _ErrorBlock extends StatelessWidget {
  const _ErrorBlock({required this.message, required this.onRetry});
  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: IrmiaTheme.danger.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('无法获取运行数据', style: TextStyle(color: IrmiaTheme.danger, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(message, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: () => unawaited(onRetry()), child: const Text('重试')),
        ],
      ),
    );
  }
}

class _HeroCard extends StatelessWidget {
  const _HeroCard({required this.state, required this.stats, required this.onRestart, required this.onGoto});
  final AppState state;
  final Map<String, dynamic>? stats;
  final Future<void> Function() onRestart;
  final void Function(String pageId) onGoto;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Row(
        children: [
          // 只放 IRMIA 图案本身（原先是 64 的「圆角底块 + 字形」）。
          // 收到 48：这张卡里 64 的方块偏大，而图案没有底色块托着，同尺寸会比方块显得更满；
          // Row 是居中对齐，右边的文字块与「重启前后端」按钮位置不受影响。
          const BrandMark(size: 48),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(state.stateText,
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text(state.subText, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          FilledButton(onPressed: () => unawaited(onRestart()), child: const Text('重启前后端')),
        ],
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.items, required this.onResolve});
  final List<Map<String, dynamic>> items;
  final void Function(String callId, String outcome) onResolve;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(top: 16),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: IrmiaTheme.warn),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('待确认 ${items.length} 项',
              style: const TextStyle(color: IrmiaTheme.warn, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          for (final item in items.take(3))
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(item['name']?.toString() ?? item['callId']?.toString() ?? '?',
                            style: const TextStyle(fontWeight: FontWeight.w500)),
                        Text(AppState.hhmm(item['at']?.toString() ?? ''),
                            style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                      ],
                    ),
                  ),
                  TextButton(
                    onPressed: () => onResolve(item['callId']?.toString() ?? '', 'succeeded'),
                    child: const Text('标记成功'),
                  ),
                  TextButton(
                    style: TextButton.styleFrom(foregroundColor: IrmiaTheme.danger),
                    onPressed: () => onResolve(item['callId']?.toString() ?? '', 'failed'),
                    child: const Text('标记失败'),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Tiles extends StatelessWidget {
  const _Tiles({required this.stats, required this.proj});
  final Map<String, dynamic>? stats;
  final Map<String, dynamic>? proj;

  @override
  Widget build(BuildContext context) {
    final budget = stats?['budget'] as Map<String, dynamic>? ?? const {};
    final tiles = stats?['tiles'] as Map<String, dynamic>? ?? const {};
    final hourly = (stats?['hourly'] as List?) ?? const [];

    final tokens = (budget['tokensToday'] as num?)?.toInt() ?? 0;
    final rate = tiles['cacheHitRate'];
    final pending = (tiles['pending'] as num?)?.toInt() ?? 0;
    final fail = (tiles['failStreak'] as num?)?.toInt() ?? 0;

    final tokenSeries = hourly
        .whereType<Map>()
        .map((h) => ((h['tokens'] as num?) ?? 0).toDouble())
        .toList();
    final hitSeries = hourly.whereType<Map>().map((h) {
      final hit = ((h['hit'] as num?) ?? 0).toDouble();
      final miss = ((h['miss'] as num?) ?? 0).toDouble();
      final sum = hit + miss;
      return sum == 0 ? 0.0 : hit / sum;
    }).toList();

    return Row(
      children: [
        Expanded(
          child: _Tile(
            value: tokens >= 1000 ? '${(tokens / 1000).toStringAsFixed(1)}k' : '$tokens',
            label: '今日用量',
            series: tokenSeries,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: _Tile(
            value: rate == null ? '–' : '${((rate as num) * 100).round()}%',
            label: '缓存命中率',
            series: hitSeries,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(child: _Tile(value: '$pending', label: '待确认')),
        const SizedBox(width: 12),
        Expanded(child: _Tile(value: '$fail', label: '连续失败')),
      ],
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.value, required this.label, this.series});
  final String value;
  final String label;
  final List<double>? series;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: const TextStyle(
                  fontSize: 26, fontWeight: FontWeight.w600, fontFeatures: [FontFeature.tabularFigures()])),
          const SizedBox(height: 2),
          Text(label, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
          if (series != null && series!.isNotEmpty) ...[
            const SizedBox(height: 8),
            SizedBox(
              height: 24,
              width: double.infinity,
              child: CustomPaint(
                painter: _SparkPainter(values: series!, color: scheme.primary),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _SparkPainter extends CustomPainter {
  _SparkPainter({required this.values, required this.color});
  final List<double> values;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) => IrmiaTheme.paintSparkline(canvas, size, values, color);

  @override
  bool shouldRepaint(_SparkPainter old) => old.values != values || old.color != color;
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(text,
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
    );
  }
}

class _AdviceCard extends StatelessWidget {
  const _AdviceCard({required this.text, required this.onTap});
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: scheme.outlineVariant),
            ),
            child: Text(text, style: const TextStyle(fontSize: 13.5)),
          ),
        ),
      ),
    );
  }
}

// ──────────────────── 外部会话（GET /api/sessions） ────────────────────

/// 一行外部会话。
///
/// 为什么不直接拿 Map 用：这一行有六七处取值（名字、类型、条数、未读、退路用的 openid），
/// 散着写 `s['field']` 时字段改名只会静默变成 null——界面上就是"少了一句话"，
/// 而没人会为此报错（设置页 `_DepEntry` 记过同一条纪律）。
class _SessionRow {
  const _SessionRow({
    required this.sid,
    required this.chatType,
    required this.messages,
    required this.unread,
    required this.name,
    required this.person,
    required this.chatId,
  });

  final String sid;
  final String chatType;

  /// 这个会话里她一共收到过多少条
  final int messages;

  /// 她还没看的条数（0 = 都看过了）
  final int unread;

  /// 人给这个会话起的名字（`config.persona.contacts`）；没起过就是 null
  final String? name;

  /// 最近跟她说话的人（QQ 给的就是 openid）
  final String person;

  /// 会话本身的 id（群里是群的 openid）
  final String chatId;

  static _SessionRow from(Object? raw) {
    final map = raw is Map ? raw.cast<String, dynamic>() : const <String, dynamic>{};
    String text(String key) {
      final value = map[key];
      return value == null ? '' : '$value';
    }

    return _SessionRow(
      sid: text('sid'),
      chatType: text('chatType'),
      messages: (map['messages'] as num?)?.toInt() ?? 0,
      unread: (map['unread'] as num?)?.toInt() ?? 0,
      name: text('name').isEmpty ? null : text('name'),
      person: text('person'),
      chatId: text('chatId'),
    );
  }

  String get typeLabel => _chatTypeLabel(chatType);

  bool get isGroup => chatType == 'group' || chatType == 'group-at';

  /// 行首那个名字：人起的名字 > 平台的 openid。
  ///
  /// 群聊退回**会话的 openid**（`chatId`）而不是最后说话的那位：`person` 是"最近发言的人"，
  /// 拿它当群名等于把门牌换成路人（她会以为那个群就是那个人）。单聊两者本来就是同一个 id。
  String get displayName {
    if (name != null) return name!;
    for (final candidate in isGroup ? [chatId, person, sid] : [person, chatId, sid]) {
      if (candidate.isNotEmpty) return candidate;
    }
    return '未知会话';
  }
}

/// 会话类型显示词：与频道页 `_chatTypes`、`src/channel/sessions.ts` 的 `CHAT_TYPE_LABELS`
/// 同一套词。认不出的类型原样显示——不猜成"群聊"，那会把频道说成群。
String _chatTypeLabel(String chatType) => switch (chatType) {
      'c2c' => '单聊',
      'group-at' => '群聊@',
      'group' => '群聊',
      'guild' => '频道',
      _ => chatType.isEmpty ? '类型未知' : chatType,
    };

/// 「外部会话」卡：她有几个群聊 / 几个单聊 / 合计多少条没看，以及每个会话攒了多少。
///
/// 为什么要有它：QQ 改成"她手边一个可以点开的软件"之后，**没叫醒她的消息**（`channel/message`）
/// 只在她那边的会话清单里可见——人在这块屏幕上原先只看得到"有会话"，看不出"她在漏消息"。
class _ExternalSessionsCard extends StatelessWidget {
  const _ExternalSessionsCard({
    required this.sessions,
    required this.error,
    required this.loading,
    required this.onRetry,
  });

  final List<_SessionRow>? sessions;
  final String? error;
  final bool loading;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final list = sessions ?? const <_SessionRow>[];
    final groups = list.where((row) => row.isGroup).length;
    final singles = list.where((row) => row.chatType == 'c2c').length;
    // 认不出的类型单独报一个数，而不是并进"群聊"：数字对不上时人只会怀疑界面
    final others = list.length - groups - singles;
    final unread = list.fold<int>(0, (sum, row) => sum + row.unread);

    return _Card(
      title: '外部会话',
      // 用户 ② 指定的文案：只讲这张卡收什么、消息去哪。
      // 这里原先挂着一句接口限制（"官方接口只推单聊与 @ 她的群消息——群里没 @ 的话到不了这里"），
      // 它是**防误读**用的：不写它，"没有积累的消息"会被读成"她都看过了"，而真相可能是那些话
      // 根本没送到（见 docs/review.md「欠账：信箱在 QQ 官方通道下收不到东西」）。用户要求换成
      // 现在这句，所以那条限制目前不在这张卡上出现——它更像是通道的属性，落点记在修订清单 ②。
      note: '经由消息适配器添加的会话。消息自动存入信箱，由 Agent 自行查看。',
      children: [
        if (loading)
          const StateBlock.loading(hint: '正在读外部会话…')
        else if (error != null)
          StateBlock.error(
            message: '外部会话读取失败：$error',
            hint: '状态与用量不受影响；读到数据后这张卡会自己出现。',
            onRetry: () => unawaited(onRetry()),
            padding: _inCardBlockPadding,
          )
        else ...[
          Text(
            [
              '$groups 个群聊',
              '$singles 个单聊',
              if (others > 0) '$others 个其它',
              '合计 $unread 条未读',
            ].join(' · '),
            style: TextStyle(
              fontSize: 12,
              color: scheme.onSurfaceVariant,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 10),
          // 一条未读都没有时**不摆那几行**：剩下的会是一屏"来过 N 条"的零信息行，
          // 而安静是常态、不是异常——摘要行已经答了"她有几个群聊"，这里一句灰字收尾
          if (unread == 0)
            _hintLine('没有积累的消息。')
          else
            CappedChildren(children: [
              for (var i = 0; i < list.length; i += 1) _SessionLine(row: list[i], divider: i > 0),
            ]),
        ],
      ],
    );
  }
}

/// 一行会话：名字 + 类型徽章 + 来过多少条 + 未读徽章。
class _SessionLine extends StatelessWidget {
  const _SessionLine({required this.row, required this.divider});

  final _SessionRow row;
  final bool divider;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        border: divider ? Border(top: BorderSide(color: scheme.outlineVariant)) : null,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              row.displayName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              // 有未读的行名字加重：徽章在一行末尾，扫一列时先看到的是名字
              style: TextStyle(fontSize: 13.5, fontWeight: row.unread > 0 ? FontWeight.w600 : FontWeight.w500),
            ),
          ),
          const SizedBox(width: 10),
          _Badge(row.typeLabel, tone: scheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Text(
            '来过 ${row.messages} 条',
            style: TextStyle(
              fontSize: 11.5,
              color: scheme.onSurfaceVariant,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          // 0 条不摆徽章：0 不是信息，是噪音（摆上去会让每行都挂个橙点，真正有未读的那行就不显眼了）
          if (row.unread > 0) ...[
            const SizedBox(width: 8),
            _Badge('未读 ${row.unread}', tone: IrmiaTheme.warn),
          ],
        ],
      ),
    );
  }
}

// ──────────────────── 框架提示（GET /api/framework-notes） ────────────────────

/// 一条框架提示：注入预警（外部消息里有想指挥她的迹象）或告警。
class _FrameworkNote {
  const _FrameworkNote({
    required this.kind,
    required this.label,
    required this.level,
    required this.title,
    required this.reason,
    required this.quotes,
    required this.by,
    required this.fingerprint,
    required this.sid,
    required this.person,
    required this.chatType,
    required this.name,
    required this.at,
  });

  /// `injection` / `alarm`（未知值按告警处理：宁可把它当回事，也别悄悄吞掉）
  final String kind;

  /// 类别词，由后端给（界面不自己维护第二份词表）
  final String label;

  /// `info` / `warn` / `critical`：两种类别共用一套等级，取色只看它
  final String level;

  /// 一句说明
  final String title;

  /// 判定的理由（只有注入预警有）
  final String reason;

  /// 外部原文里最可疑的几个片段（后端已截断）
  final List<String> quotes;

  /// 判定来自规则还是模型（只有注入预警有）
  final String? by;

  /// 告警指纹（只有告警有；排障时拿它对上告警目录）
  final String? fingerprint;

  final String sid;
  final String person;
  final String chatType;
  final String? name;
  final String at;

  static _FrameworkNote from(Object? raw) {
    final map = raw is Map ? raw.cast<String, dynamic>() : const <String, dynamic>{};
    String text(String key) {
      final value = map[key];
      return value == null ? '' : '$value';
    }

    final quotes = map['quotes'];
    return _FrameworkNote(
      kind: text('kind') == 'injection' ? 'injection' : 'alarm',
      label: text('label'),
      level: text('level'),
      title: text('title'),
      reason: text('reason'),
      quotes: quotes is List ? [for (final quote in quotes) '$quote'] : const [],
      by: text('by').isEmpty ? null : text('by'),
      fingerprint: text('fingerprint').isEmpty ? null : text('fingerprint'),
      sid: text('sid'),
      person: text('person'),
      chatType: text('chatType'),
      name: text('name').isEmpty ? null : text('name'),
      at: text('at'),
    );
  }

  bool get isAlarm => kind == 'alarm';

  /// 等级词。写出来而不只靠颜色：色盲、截图、单色打印都不能丢信息（copy-guide §二的精神）
  String get levelLabel => switch (level) {
        'critical' => '严重',
        'warn' => '警告',
        'info' => '提示',
        _ => level.isEmpty ? '未知等级' : level,
      };

  /// 徽章文案：类别 + （告警才有的）等级
  String get badgeText {
    if (!isAlarm) return label.isEmpty ? '框架提示' : label;
    return label.isEmpty ? levelLabel : '$label · $levelLabel';
  }

  /// 等级取色：与设置页徽章同一套语义色，不另造色板；认不出的等级走中性灰
  Color tone(ColorScheme scheme) => switch (level) {
        'critical' => IrmiaTheme.danger,
        'warn' => IrmiaTheme.warn,
        'info' => scheme.primary,
        _ => scheme.onSurfaceVariant,
      };

  /// 来源一行：哪个会话、谁、判定来自哪一级；告警没有会话，来源就是框架自身。
  /// 名字解析不出就退回 openid（与外部会话卡、与 `render.ts` 同一条纪律：不编名字）。
  String get sourceLine {
    if (isAlarm) {
      return fingerprint == null ? '来源：框架自身' : '来源：框架自身 · $fingerprint';
    }
    final who = name ?? person;
    final judge = switch (by) {
      'rule' => '规则判定',
      'model' => '模型判定',
      _ => '',
    };
    return [
      '来源：${who.isEmpty ? (sid.isEmpty ? '未知会话' : sid) : who}',
      if (name != null && person.isNotEmpty) person, // 有名字时把 openid 也摆出来，对得上日志
      if (chatType.isNotEmpty) _chatTypeLabel(chatType),
      if (judge.isNotEmpty) judge,
    ].join(' · ');
  }
}

/// 「框架提示」卡：框架替她留意到的事——注入预警与告警。
///
/// 为什么要它：这两类事都写在事件日志里（`injection/flagged` / `alarm/sent`），
/// 但那是几万条内部簿记中间的两行，人不会去翻。框架提示了她、或者框架自己出了事，
/// 用户得在这块屏幕上看得见。
class _FrameworkNotesCard extends StatelessWidget {
  const _FrameworkNotesCard({
    required this.notes,
    required this.error,
    required this.loading,
    required this.onRetry,
  });

  final List<_FrameworkNote>? notes;
  final String? error;
  final bool loading;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final list = notes ?? const <_FrameworkNote>[];
    return _Card(
      title: '框架提示',
      // 用户 ②：这张卡不要副标题（原来那句是"外部消息里的注入迹象，以及框架自己发出的告警。"）。
      // 每条提示自己带类别徽章与来源，标题已经说清这是什么地方。
      children: [
        if (loading)
          const StateBlock.loading(hint: '正在读框架提示…')
        else if (error != null)
          StateBlock.error(
            message: '框架提示读取失败：$error',
            hint: '运行不受影响；注入预警与告警仍照常记录在事件日志里。',
            onRetry: () => unawaited(onRetry()),
            padding: _inCardBlockPadding,
          )
        else if (list.isEmpty)
          // 空是常态：没判出迹象、没发过告警，就是一切照常。摆一张空表反而像漏了什么
          _hintLine('没有需要你知道的事。')
        else
          CappedChildren(children: [
            for (var i = 0; i < list.length; i += 1) _NoteLine(note: list[i], divider: i > 0),
          ]),
      ],
    );
  }
}

/// 一条提示：徽章 + 说明 + 来源 + 时刻；注入预警还要把理由与引用片段摆出来。
class _NoteLine extends StatelessWidget {
  const _NoteLine({required this.note, required this.divider});

  final _FrameworkNote note;
  final bool divider;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 9),
      decoration: BoxDecoration(
        border: divider ? Border(top: BorderSide(color: scheme.outlineVariant)) : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Badge(note.badgeText, tone: note.tone(scheme)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(note.title,
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
              ),
              const SizedBox(width: 8),
              Text(
                _noteStamp(note.at),
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: scheme.onSurfaceVariant,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          Text(note.sourceLine,
              style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant)),
          // 框架说的那句话（reason）与它引的外人原话（quotes）分开摆：
          // "她当时看到了什么"是这段话的全部意义——光有结论没法判断该不该管
          if (note.reason.isNotEmpty) ...[
            const SizedBox(height: 5),
            Text(note.reason, style: TextStyle(fontSize: 12.5, height: 1.6, color: scheme.onSurface)),
          ],
          for (final quote in note.quotes) _QuoteBlock(text: quote),
        ],
      ),
    );
  }
}

/// 引用片段：外部原文，左侧一条竖线把它与框架的话分开
/// （v32 渲染纪律的界面版：框里是别人的话，框外才是框架的话，归属要一眼分得开）。
class _QuoteBlock extends StatelessWidget {
  const _QuoteBlock({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 5),
      padding: const EdgeInsets.fromLTRB(8, 5, 8, 5),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        border: Border(left: BorderSide(color: scheme.outlineVariant, width: 2)),
      ),
      child: Text(
        '「$text」',
        style: TextStyle(
          fontFamily: 'monospace',
          fontSize: 11.5,
          height: 1.5,
          color: scheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

// ──────────────────── 两张卡共用的零件 ────────────────────

/// 卡片外壳：标题 + 一句说明 + 内容（与设置页 `_SectionCard` 同一形态：surface 底、
/// outlineVariant 描边、radiusCard 圆角、hairline 投影）。这一页的卡没有右侧动作位。
class _Card extends StatelessWidget {
  const _Card({required this.title, required this.children, this.note});

  final String title;

  /// 副标题：一句话说清这张卡收什么。**不写就整块不占高度**——
  /// 「框架提示」那张卡按用户 ② 的要求不摆副标题（条目自带类别徽章，标题已经够用）。
  final String? note;

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final note = this.note;
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 14),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          if (note != null && note.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(note,
                  style: TextStyle(fontSize: 12.5, height: 1.5, color: scheme.onSurfaceVariant)),
            ),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    );
  }
}

/// 小圆角徽章：与设置页 `_badge` / 扩展页 `_badge` **同一形态**（12% 淡底、radiusCtl、11px 语义色），
/// 色一律取 `IrmiaTheme` 的四色——两张卡不该长出自己的配色。
class _Badge extends StatelessWidget {
  const _Badge(this.text, {required this.tone});

  final String text;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      ),
      child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: tone)),
    );
  }
}

/// 卡内的一行灰字：空态用（实现已收进 ui_kit 的 [HintLine]，与渠道页共用一份）
Widget _hintLine(String text) => HintLine(text);

/// 卡内三态块的内边距：`StateBlock` 默认左右各 26 是给整页用的，卡里再留一次就缩成一条
const _inCardBlockPadding = EdgeInsets.symmetric(vertical: 6);

/// 时刻：今天只给 HH:mm，隔天补上 MM-DD。
/// 框架提示不像"最近事件"那样都在眼前——三天前那条只给钟点会被读成"刚刚"。
String _noteStamp(String iso) {
  final dt = DateTime.tryParse(iso)?.toLocal();
  if (dt == null) return '—';
  final now = DateTime.now();
  final hm = '${_p2(dt.hour)}:${_p2(dt.minute)}';
  final today = dt.year == now.year && dt.month == now.month && dt.day == now.day;
  return today ? hm : '${_p2(dt.month)}-${_p2(dt.day)} $hm';
}

String _p2(int value) => value.toString().padLeft(2, '0');

class _RecentList extends StatelessWidget {
  const _RecentList({required this.stats, required this.onWake});

  final Map<String, dynamic>? stats;
  final VoidCallback onWake;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final events = ((stats?['recent'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => e.cast<String, dynamic>())
        .where(_visible)
        .toList()
        .reversed
        .take(kListCap)
        .toList();

    if (events.isEmpty) {
      return GuideBar(
        icon: Icons.history_rounded,
        text: '还没有事件记录。',
        actionLabel: '立即唤醒',
        onAction: onWake,
        hint: '唤醒或外部消息写入后，这里列出最近发生的事。',
      );
    }

    return Column(
      children: [
        for (final e in events)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 8),
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: scheme.outlineVariant)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(AppState.hhmm(e['ts']?.toString() ?? ''),
                    style: TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11.5,
                        color: scheme.onSurfaceVariant)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(e['summary']?.toString() ?? e['type']?.toString() ?? '',
                      style: const TextStyle(fontSize: 13.5)),
                ),
              ],
            ),
          ),
      ],
    );
  }

  /// 镜像与过程不上屏（与 Web 同规则）
  static bool _visible(Map<String, dynamic> e) {
    final type = e['type']?.toString() ?? '';
    if (type == 'message/user') return false;
    if (type == 'turn/start' || type == 'step/start' || type == 'step/end') return false;
    if (type == 'wake/heartbeat') return false;
    final summary = e['summary']?.toString() ?? '';
    if (type == 'turn/end' && summary.contains('completed')) return false;
    if (e['visibility'] != 'model' && type != 'turn/end') return false;
    return true;
  }
}
