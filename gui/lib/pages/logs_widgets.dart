part of 'logs_page.dart';

const _jsonEncoder = JsonEncoder.withIndent('  ');

/// 事件类型分组：与 Web 端同一张表，过滤菜单照它排布
const _eventGroups = <String, List<String>>{
  '生命周期': ['session/start', 'session/end', 'turn/start', 'turn/end', 'step/start', 'step/end'],
  '消息': ['message/user', 'message/assistant', 'message/reasoning', 'developer/message'],
  '工具': ['tool/call', 'tool/result', 'tool/zombie'],
  '唤醒与队列': ['wake/timer', 'wake/file', 'wake/webhook', 'wake/manual', 'wake/heartbeat', 'wake/intention', 'wake/job', 'wake/channel', 'timer/set', 'timer/fired', 'timer/cancelled', 'input/claimed', 'input/dead-letter', 'input/requeued'],
  '预算': ['budget/consumed', 'budget/rollover', 'budget/exhausted', 'budget/topped-up'],
  '策略与审计': ['policy/denied', 'log/repaired', 'instance/takeover', 'alarm/sent', 'review/resolved', 'snapshot/checkpoint', 'compaction/summary', 'persona/updated', 'config/changed'],
  '扩展面': ['mcp/server-started', 'mcp/server-stopped', 'skill/installed', 'hook/fired', 'speak/sent', 'intention/raised', 'intention/acted', 'todo/updated', 'job/started', 'job/finished', 'human/asked', 'human/answered', 'human/expired', 'model/degraded', 'model/restored'],
};

// ─── 取值与格式化 ───

int _int(Object? value) => value is num ? value.toInt() : 0;

String _str(Object? value) => value?.toString() ?? '';

Map<String, dynamic> _map(Object? value) =>
    value is Map ? value.cast<String, dynamic>() : const <String, dynamic>{};

List<Map<String, dynamic>> _maps(Object? value) => (value is List ? value : const [])
    .whereType<Map>()
    .map((e) => e.cast<String, dynamic>())
    .toList();

double _hitRate(Map<String, dynamic> point) {
  final hit = _int(point['hit']).toDouble();
  final miss = _int(point['miss']).toDouble();
  return hit + miss == 0 ? 0.0 : hit / (hit + miss);
}

String _clip(String text, [int max = 80]) => text.length <= max ? text : '${text.substring(0, max)}…';

String _brief(Object? value, [int max = 70]) {
  if (value == null) return '';
  if (value is String) return _clip(value, max);
  try {
    return _clip(_jsonEncoder.convert(value), max);
  } catch (_) {
    return _clip(value.toString(), max);
  }
}

String _short(Object? hash) {
  final text = _str(hash);
  if (text.isEmpty) return '未知';
  return text.length <= 8 ? text : text.substring(0, 8);
}

String _num(int value) {
  if (value >= 1000000) return '${(value / 1000000).toStringAsFixed(1)}M';
  if (value >= 1000) return '${(value / 1000).toStringAsFixed(1)}k';
  return '$value';
}

String _p2(int value) => value.toString().padLeft(2, '0');

String _hms(String? iso) {
  final dt = DateTime.tryParse(iso ?? '')?.toLocal();
  if (dt == null) return '--:--:--';
  return '${_p2(dt.hour)}:${_p2(dt.minute)}:${_p2(dt.second)}';
}

String _stamp(String? iso) {
  final dt = DateTime.tryParse(iso ?? '')?.toLocal();
  if (dt == null) return '—';
  return '${_p2(dt.month)}-${_p2(dt.day)} ${_p2(dt.hour)}:${_p2(dt.minute)}';
}

TextStyle _mono(double size, Color color) => TextStyle(
      fontFamily: 'monospace',
      fontSize: size,
      color: color,
      fontFeatures: const [FontFeature.tabularFigures()],
    );

Widget _card(BuildContext context, Widget child) {
  final scheme = Theme.of(context).colorScheme;
  return Container(
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: scheme.surface,
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
      border: Border.all(color: scheme.outlineVariant),
      boxShadow: IrmiaTheme.hairline,
    ),
    child: child,
  );
}

/// 结局色调：失败红、预算类黄，其余保持正文色
Color? _reasonTone(String? kind) {
  if (kind == null) return null;
  if (kind.contains('fail') || kind.contains('error')) return IrmiaTheme.danger;
  if (kind.contains('budget') || kind.contains('abort')) return IrmiaTheme.warn;
  return null;
}

Color _typeTone(BuildContext context, String type) {
  final scheme = Theme.of(context).colorScheme;
  const danger = ['policy/denied', 'input/dead-letter', 'log/repaired'];
  if (danger.contains(type) || type.startsWith('tool/zombie')) return IrmiaTheme.danger;
  if (type.startsWith('budget/')) return IrmiaTheme.warn;
  if (type.startsWith('tool/')) return scheme.primary;
  return scheme.onSurfaceVariant;
}

// ─── 基础小组件 ───

class _TabBar extends StatelessWidget {
  const _TabBar({required this.labels, required this.index, required this.onPick});

  final List<String> labels;
  final int index;
  final ValueChanged<int> onPick;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < labels.length; i++)
            Padding(
              padding: EdgeInsets.only(right: i < labels.length - 1 ? 3 : 0),
              child: Material(
                color: i == index ? scheme.surface : Colors.transparent,
                borderRadius: BorderRadius.circular(6),
                child: InkWell(
                  borderRadius: BorderRadius.circular(6),
                  onTap: () => onPick(i),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
                    child: Text(
                      labels[i],
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: i == index ? FontWeight.w600 : FontWeight.w400,
                        color: i == index ? scheme.primary : scheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _HeadText extends StatelessWidget {
  const _HeadText(this.text, {this.end = false});

  final String text;
  final bool end;

  @override
  Widget build(BuildContext context) => Text(
        text,
        textAlign: end ? TextAlign.right : TextAlign.left,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      );
}

class _Badge extends StatelessWidget {
  const _Badge(this.text, {this.tone});

  final String text;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final color = tone ?? Theme.of(context).colorScheme.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(text, style: _mono(11, color)),
    );
  }
}

class _StateBlock extends StatelessWidget {
  const _StateBlock({required this.title, this.detail, this.loading = false, this.onRetry});

  final String title;
  final String? detail;
  final bool loading;
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(26),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (loading) const CircularProgressIndicator(),
            if (loading) const SizedBox(height: 14),
            Text(title, style: TextStyle(fontSize: 13.5, color: scheme.onSurfaceVariant)),
            if (detail != null && detail!.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(detail!,
                  textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
            ],
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              OutlinedButton(onPressed: () => unawaited(onRetry!()), child: const Text('重试')),
            ],
          ],
        ),
      ),
    );
  }
}

class _Spark extends StatelessWidget {
  const _Spark({required this.values, required this.color});

  final List<double> values;
  final Color color;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 34,
        width: double.infinity,
        child: CustomPaint(painter: _SparkPainter(values: values, color: color)),
      );
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
