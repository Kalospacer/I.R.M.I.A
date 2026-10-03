part of 'extensions_page.dart';

/// 信任门四态的展示词（与 Web 端同一张表）
const _trustLabel = <String, String>{
  'trusted': '已确认', 'never-confirmed': '未确认',
  'agent-proposed': 'agent 提议', 'content-changed': '确认后已变更',
};

/// MCP 运行期的展示词：日志里没有启动事件就显示"从未启动"，不臆造"正在运行"
const _mcpLabel = <String, String>{
  'started': '已运行', 'stopped': '已停止',
  'disabled': '已停用', 'never-started': '从未启动',
};

/// 徽章取色表：信任门与 sideEffect 共用一张，键不重叠
const _tone = <String, Color>{
  'trusted': IrmiaTheme.ok, 'started': IrmiaTheme.ok, 'running': IrmiaTheme.ok,
  'agent-proposed': IrmiaTheme.warn, 'stopped': IrmiaTheme.warn,
  'content-changed': IrmiaTheme.danger, 'destructive': IrmiaTheme.danger,
  'disabled': IrmiaTheme.sleep, 'none': IrmiaTheme.sleep,
};

int _int(Object? v) => v is num ? v.toInt() : 0;

List<Map<String, dynamic>> _maps(Object? v) =>
    v is List ? v.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() : const [];

List<String> _strings(Object? v) => v is List ? v.map((e) => '$e').toList() : const [];

/// 超时展示词：0 是"没有超时"，不是"0 秒"
String _ms(Object? v) {
  final n = _int(v);
  if (n <= 0) return '无';
  if (n < 1000) return '${n}ms';
  final sec = n / 1000;
  return sec == sec.roundToDouble() ? '${sec.round()}s' : '${sec.toStringAsFixed(1)}s';
}

/// 截断长文案：toast 里塞一整段服务端报错会把它挤成一团，前 N 个字符说到点就够
String _clip(String text, int max) {
  final runes = text.runes;
  return runes.length <= max ? text : '${String.fromCharCodes(runes.take(max))}…';
}

/// 今天的时刻只给 HH:mm，隔天补日期（MCP 的"最近一次"常在几天前）
String _stamp(Object? v) {
  final dt = v is String && v.isNotEmpty ? DateTime.tryParse(v)?.toLocal() : null;
  if (dt == null) return '';
  final now = DateTime.now();
  final hm = '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  final today = dt.year == now.year && dt.month == now.month && dt.day == now.day;
  return today ? hm : '${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} $hm';
}

String _policy(Object? v) {
  if (v == true) return '全开';
  if (v is List) return v.isEmpty ? '按名单（空）' : '按名单（${v.length} 件）';
  return '全关';
}

/// 徽章取色：表里没有的走主色（idempotent / never-started），再退到灰
Color _toneOf(ColorScheme s, String key) {
  if (key == 'idempotent' || key == 'never-started') return s.primary;
  return _tone[key] ?? s.onSurfaceVariant;
}

/// 属性徽章：底色取主色 10%、边框 35%，不用字面色值
Widget _badge(String text, Color color) => Container(
      margin: const EdgeInsets.only(right: 6),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Text(text, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w500)),
    );

Widget _monoText(String text) => Text(text,
    style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, height: 1.5));

Widget _small(String text) => Builder(builder: (context) {
      final scheme = Theme.of(context).colorScheme;
      return Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Text(text, style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant)),
      );
    });

/// 卡片内的一行：标题（可等宽）+ 徽章 + 等宽副行 + 单行描述 + 右侧动作；
/// 技术字段（描述、路径、参数…）一律先折叠，点「详情」才铺开。
///
/// 为什么行内还要再折一层 [DetailFold]：这一页的行大多是"名字 + 一句说明"，
/// 而路径、指纹、入参 schema 这些东西平时没人看，摊开会把一屏塞满——
/// 技术字段默认收起是 docs/astrbot-benchmark.md §3.4 的口径，这里照办。
Widget _row({
  required ColorScheme cs,
  required Key key,
  required String title,
  bool titleMono = false,
  List<Widget> badges = const [],
  String monoLine = '',
  List<String> notes = const [],
  List<Widget> detail = const [],
  Widget? trailing,
}) {
  final body = Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Wrap(
        spacing: 0,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Text(title,
                style: TextStyle(
                    fontFamily: titleMono ? 'monospace' : null,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600)),
          ),
          ...badges,
        ],
      ),
      if (monoLine.isNotEmpty)
        Padding(padding: const EdgeInsets.only(top: 4), child: _monoText(monoLine)),
      for (final note in notes)
        Padding(
          padding: const EdgeInsets.only(top: 3),
          child: Text(note,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12.5, height: 1.5, color: cs.onSurfaceVariant)),
        ),
      if (detail.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: DetailFold(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: detail),
          ),
        ),
    ],
  );
  if (trailing == null) {
    return KeyedSubtree(key: key, child: body);
  }
  return Row(
    // key 挂在**整行**上，不是行内那一列：测试与无障碍都要能按行定位到它的开关
    key: key,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(child: body),
      Padding(padding: const EdgeInsets.only(left: 12, top: 2), child: trailing),
    ],
  );
}

/// 列表里的卡片：标题 + 说明 + 若干行（行间一根发丝线，行数默认 8 行，其余收进「查看全部」）。
///
/// 排版与设置页的 `_SectionCard` 对齐（标题 15/w600、说明另起一行、内边距 18/16、卡片间距 18）：
/// 前几版里这些卡各写各的——标题字号差 1.5、说明挤在标题右边、间距一个靠 margin 一个靠
/// SizedBox，攒在一起就是"这个页面跟别的页不像"（v28 记的正是这件事）。
Widget _card({required String title, required String hint, required List<Widget> children}) {
  return Builder(builder: (context) {
    final s = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 18),
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      decoration: BoxDecoration(
        color: s.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: s.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          if (hint.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(hint, style: TextStyle(fontSize: 12.5, height: 1.5, color: s.onSurfaceVariant)),
            ),
          const SizedBox(height: 10),
          CappedChildren(
            children: [
              for (final child in children)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(border: Border(top: BorderSide(color: s.outlineVariant))),
                  child: child,
                ),
            ],
          ),
        ],
      ),
    );
  });
}

/// 底部引导条：这一项**怎么加、加完过哪道门、什么时候生效**。
///
/// 为什么每项都要一条：这个页面上的四类东西各有一套"引导添加"的口径（技能要过信任门、
/// MCP 要重启、工具只是名字、Hooks 只有人能改），把它们塞进详情页头会淹没主内容，
/// 所以一律放在最下面——读完了自然会看到，要用的时候也找得到。
Widget _guide({required IconData icon, required List<String> lines}) {
  return Builder(builder: (context) {
    final s = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 2),
      padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
      decoration: BoxDecoration(
        color: s.surfaceContainer,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: s.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 15, color: s.onSurfaceVariant),
              const SizedBox(width: 8),
              Text('从这里开始', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: s.onSurface)),
            ],
          ),
          for (final line in lines)
            Padding(
              padding: const EdgeInsets.only(left: 23, top: 4),
              child: Text(line, style: TextStyle(fontSize: 12, height: 1.6, color: s.onSurfaceVariant)),
            ),
        ],
      ),
    );
  });
}

/// 纪律说明条：不是"跳转去改"的入口，是把一条**边界**说清楚（Hooks 的 agent 只读）
Widget _notice(String text) => Builder(builder: (context) {
      final s = Theme.of(context).colorScheme;
      return Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: BoxDecoration(
          color: s.surfaceContainer,
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          border: Border.all(color: s.outlineVariant),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.lock_outline_rounded, size: 15, color: s.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: TextStyle(fontSize: 12.5, height: 1.6, color: s.onSurfaceVariant))),
        ]),
      );
    });

/// 行尾 icon-only 操作按钮（照 AstrBot `ConversationPage.vue:170-181` 的 actions 列）：
/// 28×28 命中区、16px 图标，文案由 tooltip 承担
Widget _iconAction(BuildContext context,
    {required IconData icon, required String tooltip, required VoidCallback? onPressed, Color? color}) {
  final s = Theme.of(context).colorScheme;
  return IconButton(
    icon: Icon(icon, size: 16, color: color ?? (onPressed == null ? s.outlineVariant : s.onSurfaceVariant)),
    tooltip: tooltip,
    onPressed: onPressed,
    padding: EdgeInsets.zero,
    constraints: const BoxConstraints.tightFor(width: 28, height: 28),
    visualDensity: VisualDensity.compact,
    style: IconButton.styleFrom(tapTargetSize: MaterialTapTargetSize.shrinkWrap),
  );
}

Widget _problem(String text) => Builder(builder: (context) {
      final s = Theme.of(context).colorScheme;
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 2),
            child: Icon(Icons.error_outline_rounded, size: 14, color: IrmiaTheme.warn),
          ),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: TextStyle(fontSize: 12.5, height: 1.5, color: s.onSurface))),
        ],
      );
    });

/// 次级文字按钮的统一手感（扫描目录 / 全开 / 全关这一排）
ButtonStyle _textButtonStyle() => TextButton.styleFrom(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      minimumSize: const Size(0, 32),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );

/// 弹窗里的一个输入框（带一行标签与提示）。MCP / Hooks 那两张表单字段多，
/// 统一成一个零件，免得每处都要重写一遍 `InputDecoration` 的七个参数。
Widget _dialogField(TextEditingController controller, String label, String hint, {int maxLines = 1, Key? fieldKey}) {
  return Builder(builder: (context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
          const SizedBox(height: 4),
          TextField(
            // 按 key 而不是按 hint 定位：hint 是**提示文案**（改文案就会打不到），
            // key 是契约。测试与无障碍都靠它认框（与渠道页的 field-<path> 同一手法）。
            key: fieldKey,
            controller: controller,
            maxLines: maxLines,
            autocorrect: false,
            enableSuggestions: false,
            style: const TextStyle(fontSize: 12.5),
            decoration: InputDecoration(
              isDense: true,
              hintText: hint,
              border: const OutlineInputBorder(),
            ),
          ),
        ],
      ),
    );
  });
}

/// 弹窗关掉之后再销毁控制器。
///
/// 为什么不能就地 dispose：`showDialog` 的 Future 在**路由弹出时**就 resolve，
/// 而弹窗的退场动画还要几十毫秒才把 TextField 从树上摘掉——这期间 `didUpdateWidget`
/// 仍会去 listen 那个已经销毁的 controller，于是报 "A TextEditingController was used
/// after being disposed"（实测踩到过：弹窗一关，整页就崩）。延迟一拍最省事：
/// 退场动画（200ms）跑完再丢。代价是几百毫秒的临时对象，收益是这一页不会因为关弹窗而崩。
void _disposeSoon(List<TextEditingController> controllers) {
  Future<void>.delayed(const Duration(milliseconds: 600), () {
    for (final controller in controllers) {
      controller.dispose();
    }
  });
}

/// 多行文本 → 字符串列表（agent 表单里的 args：一行一个参数）
List<String> _lines(String text) =>
    text.split('\n').map((line) => line.trim()).where((line) => line.isNotEmpty).toList();

/// 多行文本 → env 映射（`KEY=VALUE`，一行一个；没有 `=` 的行丢掉，不塞进一个空值变量）
Map<String, String> _envPairs(String text) {
  final out = <String, String>{};
  for (final line in text.split('\n')) {
    final trimmed = line.trim();
    if (trimmed.isEmpty) continue;
    final at = trimmed.indexOf('=');
    if (at <= 0) continue;
    out[trimmed.substring(0, at).trim()] = trimmed.substring(at + 1).trim();
  }
  return out;
}

/// 表单里的一个字段定义（[_formDialog] 用）：key 是回传时的字段名
class _FormField {
  const _FormField({
    required this.key,
    required this.label,
    required this.hint,
    this.maxLines = 1,
    this.validator,
  });

  final String key;
  final String label;
  final String hint;
  final int maxLines;

  /// 返回非 null 即错误文案；为空时按钮不提交（在弹窗里当场说清楚，省一次往返）
  final String? Function(String value)? validator;
}

/// 通用小表单弹窗：标题 + 说明 + 若干个输入框 + 取消/创建。
///
/// 为什么自己写而不复用 `showDialog`：这一页有四处"填两个字段建个东西"（新建技能、
/// 添加服务、添加钩子…），各写一遍会把同一套校验/布局抄四份。
/// 校验在**这里**做（而不是等 POST 回来）：名字不合规这种错，当场说比绕一圈说清楚。
Future<Map<String, String>?> _formDialog(
  BuildContext context, {
  required String title,
  required String hint,
  required List<_FormField> fields,
  String confirmLabel = '创建',
}) async {
  final controllers = {for (final field in fields) field.key: TextEditingController()};
  final errors = <String, String?>{};
  final result = await showDialog<Map<String, String>>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (builderContext, setDialogState) {
        final scheme = Theme.of(builderContext).colorScheme;
        return AlertDialog(
          constraints: const BoxConstraints(minWidth: 400, maxWidth: 520),
          title: Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(hint, style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant)),
                const SizedBox(height: 12),
                for (final field in fields) ...[
                  Text(field.label, style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                  const SizedBox(height: 4),
                  TextField(
                    key: ValueKey('form-${field.key}'),
                    controller: controllers[field.key],
                    maxLines: field.maxLines,
                    autocorrect: false,
                    enableSuggestions: false,
                    style: const TextStyle(fontSize: 12.5),
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: field.hint,
                      errorText: errors[field.key],
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(null),
              style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () {
                final out = <String, String>{};
                var bad = false;
                for (final field in fields) {
                  final value = controllers[field.key]!.text.trim();
                  final message = value.isEmpty ? '这一项不能为空' : field.validator?.call(value);
                  errors[field.key] = message;
                  if (message != null) bad = true;
                  out[field.key] = value;
                }
                if (bad) {
                  setDialogState(() {});
                  return;
                }
                Navigator.of(dialogContext).pop(out);
              },
              child: Text(confirmLabel),
            ),
          ],
        );
      },
    ),
  );
  // 退场动画跑完再销毁：见 _disposeSoon 的注释
  _disposeSoon(controllers.values.toList());
  return result;
}
