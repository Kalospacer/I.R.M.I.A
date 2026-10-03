import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Irmia GUI 主题 —— 与 Web 端同一颗种子（#2563EB）派生，两处不打架。
/// 规格来源：docs/gui-design.md §4。
class IrmiaTheme {
  IrmiaTheme._();

  static const seed = Color(0xFF2563EB);

  /// 状态四色在明暗两模下不变（语义不随主题漂移）
  static const ok = Color(0xFF2F9E44);
  static const warn = Color(0xFFF08C00);
  static const danger = Color(0xFFE03131);
  static const sleep = Color(0xFFADB5BD);

  /// 发丝影：不是泛光，是纸的厚度
  static const hairline = <BoxShadow>[
    BoxShadow(color: Color(0x0D101828), blurRadius: 2, offset: Offset(0, 1)),
  ];

  static const radiusCard = 12.0;
  static const radiusCtl = 8.0;
  static const radiusAvatar = 16.0;

  /// 动效节奏（MaidKit 实证值）
  static const durPage = Duration(milliseconds: 180);
  static const durCard = Duration(milliseconds: 240);
  static const durSse = Duration(milliseconds: 150);

  /// 界面字体栈。**只在这里写一次**：`ThemeData.fontFamily` 与那几个"直接交给 Material、
  /// 不与环境 DefaultTextStyle 合并"的地方（按钮文字、提示条正文）共用同一个串——
  /// 少写一处就掉回平台兜底字体，第九条那轮"一粗一细"就是这么来的。
  static const windowsUiFont = 'Microsoft YaHei UI';

  static ThemeData light() => _build(Brightness.light);
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final scheme = ColorScheme.fromSeed(seedColor: seed, brightness: brightness);
    final isDark = brightness == Brightness.dark;

    // 与 Web token 表对齐的少量覆写：外壳用 surfaceContainer 系
    final surface = isDark ? const Color(0xFF14161A) : const Color(0xFFFFFFFF);
    final surfaceContainer = isDark ? const Color(0xFF1A1D22) : const Color(0xFFF5F7FA);
    final surfaceHighest = isDark ? const Color(0xFF232A3A) : const Color(0xFFE8EEF9);
    final outline = isDark ? const Color(0xFF2C3138) : const Color(0xFFE8ECF0);
    final onSurface = isDark ? const Color(0xFFE9ECEF) : const Color(0xFF1F2329);
    final onVariant = isDark ? const Color(0xFF98A0AA) : const Color(0xFF8F959E);

    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme.copyWith(
        surface: surface,
        onSurface: onSurface,
        surfaceContainer: surfaceContainer,
        surfaceContainerHighest: surfaceHighest,
        outlineVariant: outline,
        onSurfaceVariant: onVariant,
        primary: isDark ? const Color(0xFF3B82F6) : seed,
      ),
      scaffoldBackgroundColor: surface,
      // 系统字体栈：中文原生感（Flutter 默认即平台字体，这里显式声明意图）
      fontFamily: Platform.isWindows ? windowsUiFont : null,
      visualDensity: VisualDensity.standard,
      splashFactory: InkSparkle.splashFactory,
    );

    // 按钮文字：**只在这里定义一次**。
    //
    // 为什么必须派生、不能就地写 `TextStyle(fontSize: 13, …)`：ButtonStyle 里的 textStyle
    // 是**直接**交给 Material 用的（见 ButtonStyleButton.build 的 `Material(textStyle: …)`），
    // 不会与上下文的 DefaultTextStyle 合并——少写一个 fontFamily 就落到平台兜底字体。
    // 结果同一个界面里，写死 textStyle 的按钮是一种字形、没写的（走 labelLarge）是另一种，
    // 看着就是"一粗一细"（用户 ⑨ 的原话）。
    //
    // 从主题的 labelLarge 派生，字体栈就跟着 ThemeData 的 fontFamily 走；
    // 各页面也**不要**再传 textStyle，字号要统一就在这里改。
    final buttonText = (base.textTheme.labelLarge ?? const TextStyle())
        .copyWith(fontSize: 13, fontWeight: FontWeight.w500);

    return base.copyWith(
      dividerTheme: DividerThemeData(color: outline, thickness: 1, space: 1),
      cardTheme: CardThemeData(
        color: surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusCard),
          side: BorderSide(color: outline),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusCtl),
          borderSide: BorderSide(color: outline),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusCtl),
          borderSide: BorderSide(color: outline),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusCtl),
          borderSide: BorderSide(color: base.colorScheme.primary, width: 1.4),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          // 控件圆角一律走 radiusCtl（用户 ⑧："多处圆角不一致？统一为这种吧"——
          // 他指的是同一张卡里输入框那种 8）。这里原来是写死的 22：按钮是胶囊、
          // 挨着它的输入框是 8，一张卡里两种圆角。
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusCtl)),
          textStyle: buttonText,
        ),
      ),
      // 分段控件同理：M3 默认是胶囊（StadiumBorder），与同页的输入框、侧栏选中项都不是一个形。
      // 分段两端的内圆角由这个 shape 裁出来（见 SegmentedButton 的 borderClipPath），
      // 所以给它 8 就整组一致，段与段之间仍是直线分隔。
      segmentedButtonTheme: SegmentedButtonThemeData(
        style: ButtonStyle(
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusCtl)),
          ),
          textStyle: WidgetStatePropertyAll(buttonText),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: base.colorScheme.primary,
          // 与 FilledButton 同一条：按钮家族的圆角都取 radiusCtl。
          // 文字按钮平时看不见底色，但按下去那圈 ink 是有形的——它也得是同一个数。
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusCtl)),
          // 字号也一样，理由见 buttonText 那一段
          textStyle: buttonText,
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: onSurface,
        // fontFamily 必须显式给：contentTextStyle 是**直接交给 Material** 的，
        // 不与环境里的 DefaultTextStyle 合并——漏了它就掉回平台兜底字体（第九条那轮"一粗一细"）。
        // 用 [windowsUiFont] 而不是就地抄一遍字符串：字体栈只在一个地方写。
        contentTextStyle: TextStyle(
            color: surface, fontSize: 13.5, fontFamily: Platform.isWindows ? windowsUiFont : null),
        // 贴底留白（用户 ⑱："稍微往上移动一点"）。
        // 为什么写在这里而不是 SnackBar 的 margin：⑫ 给提示条加 `width` 之后，
        // `width` 与 `margin` 互斥（SnackBar 自己断言了），margin 一撤底部间距就没了、
        // 条子贴到窗口下沿。主题里的 insetPadding 是 margin 的兜底来源（snack_bar.dart:718-721），
        // 定宽时横向不生效、纵向照样把它托起来 ✓。
        insetPadding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusCtl)),
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: onSurface,
          borderRadius: BorderRadius.circular(6),
        ),
        textStyle: TextStyle(color: surface, fontSize: 12),
      ),
    );
  }

  /// 氛围光：内容区顶部一片淡蓝晕开（与 Web 同一片光）
  static BoxDecoration dawn(Brightness brightness) {
    final primary = brightness == Brightness.dark ? const Color(0xFF3B82F6) : seed;
    final base = brightness == Brightness.dark ? const Color(0xFF14161A) : Colors.white;
    return BoxDecoration(
      gradient: LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          Color.alphaBlend(primary.withValues(alpha: 0.07), base),
          base,
        ],
        stops: const [0.0, 0.35],
      ),
    );
  }

  /// 状态点颜色（六态）
  static Color dotColor(String kind) {
    switch (kind) {
      case 'running':
        return ok;
      case 'idle':
        return seed;
      case 'sleeping':
        return sleep;
      case 'needs-review':
      case 'paused':
      case 'degraded':
      case 'offline':
        return warn;
      default:
        return sleep;
    }
  }

  /// 状态词表：与 Web shell.js 同一张表（docs/copy-guide.md §2）
  static String humanState(String? state, {int needsReview = 0}) {
    switch (state) {
      case 'running':
        return '执行中';
      case 'idle':
        return '就绪';
      case 'sleeping':
        return '休眠中';
      case 'degraded':
        return '降级运行';
      case 'paused':
        return '已暂停（预算耗尽）';
      case 'needs-review':
        return needsReview > 0 ? '待确认（$needsReview 项）' : '待确认';
      case 'offline':
        return '连接中断';
      // 六态之外的值如实标记，不假装就绪（docs/copy-guide.md §1）
      default:
        return '状态未知';
    }
  }

  /// 24h 迷你趋势线（纯 CustomPaint，零图表库）
  static void paintSparkline(Canvas canvas, Size size, List<double> values, Color color) {
    if (values.isEmpty) return;
    final maxValue = values.reduce(math.max);
    final max = maxValue <= 0 ? 1.0 : maxValue;
    final step = size.width / (values.length - 1 == 0 ? 1 : values.length - 1);

    final line = Path();
    for (var i = 0; i < values.length; i++) {
      final x = i * step;
      final y = size.height - (values[i] / max) * (size.height - 3) - 1;
      if (i == 0) {
        line.moveTo(x, y);
      } else {
        line.lineTo(x, y);
      }
    }
    final area = Path.from(line)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();

    canvas.drawPath(area, Paint()..color = color.withValues(alpha: 0.12));
    canvas.drawPath(
      line,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round,
    );
  }
}

// ──────────────────────────────── 品牌图案 ────────────────────────────────
//
// 两处显示标识的地方各有一个 widget，取同一份图案、同一套取色规则：
//   · [BrandMark] —— 只有图案，没有底、没有字形（运行情况页顶部卡片）；
//   · [HerFace]   —— 图案 + 圆形浅底（聊天页每条消息左边那枚小头像）。
//
// **按主题取色**：图案只有单色一张图（`brand/export/irmia-mark-*.png` 里 RGB 是常量、
// 形状全在 alpha 通道），浅色主题用品牌蓝 `#0066E8`、深色主题用白色。这不是审美选择——
// 白图案压在浅色底上等于隐形，反过来蓝图案压在深色底上也太沉。
//
// 资源分档（`assets/brand/`，1x 名 + Flutter 的分辨率变体目录）：
//   大图 `mark-48.png`    —— 顶栏卡片那种 40~48 逻辑像素的用法；
//   小图 `mark-16.png`    —— 头像那种 16~28 逻辑像素的用法。**这一档是专用几何**：
//                            `brand/tools/build_ico.py` 的 16/24/32 三档针尖加粗、环加厚
//                            （MARK_PLAN 的 `small=True` + `uniform`），直接缩 512 的大图
//                            在这个尺寸下针尖会淡掉。别的尺寸都是从这两张里最近的一档
//                            重采样出来的，不重新渲染几何。
// 每档都有 `2.0x/` `3.0x/` —— 150% / 200% / 300% 缩放的机器各自取最近的一档，不放大。

/// 取图案资产：`stem` 是档位名（`mark-48` / `mark-16`），按主题在蓝/白之间选。
String _markAsset(String stem, Brightness brightness) =>
    'assets/brand/${brightness == Brightness.dark ? stem : '$stem-blue'}.png';

/// 要的是"图案本身"、没有底色块的地方用它（用户："因为是矢量图，感觉不需要背景吧。
/// 就图案就行了，后面搞个圆角背景不太好看"）。
///
/// 画布是 [size] 见方的方框，图案按**原始宽高比**缩放着色（`BoxFit.contain`，
/// 不是 fill）：图案本身是 1.2:1 的横宽比例（环比星芒宽），任何一边被拉一下都看得出来。
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 40});

  /// 逻辑像素边长，也就是图案的**外接方框**——图案自带约 1.5% 的留白，
  /// 不额外加 padding，免得比它替掉的那个方块看着小一圈。
  final double size;

  /// 这一档的大图（顶栏卡片 40~48）
  static const _stem = 'mark-48';

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: Image.asset(
        _markAsset(_stem, Theme.of(context).brightness),
        width: size,
        height: size,
        fit: BoxFit.contain,
        // 图案的细节（星芒的针尖、环的粗细变化）全靠缩放算法，默认的中等质量会糊
        filterQuality: FilterQuality.high,
        // 载入失败**不静默**：不占位、不假装没事，留一个明显的红点让人一眼看出资源没进来
        // （这条路径由 pubspec 的 assets 声明守着，正常构建不会走到）。
        errorBuilder: (context, error, stack) => const ColoredBox(color: Colors.red),
      ),
    );
  }
}

/// 她的头像：**圆形浅底 + IRMIA 图案**。
///
/// 原来底里是"灵鹿衔火"那个通用字形（`IrmiaTheme.paintHerMark` 画的），用户指着聊天页
/// 那排小圆标问"是不是忘了换了"——所以这里换成图案。**底留着**，理由：
///   ① 聊天页一行一条，这枚圆标是"这句话是她说的"的锚点，去掉底就只剩一枚很小的
///      蓝图案浮在正文旁边，行首会散掉；
///   ② 图案在深色主题下是白色、底是 `surfaceContainerHighest`，浅色主题下是蓝图案压
///      淡蓝底——两种主题下这块底都让图案"坐得住"，不靠运气。
/// 圆形（不是原来的圆角方）是跟聊天气泡的圆角语言一致，尺寸没动。
///
/// 图案占直径的 62.5%：图案自身在方框里是 1.2:1 的横宽比，铺满会让环顶到圆边上。
class HerFace extends StatelessWidget {
  const HerFace({super.key, this.size = 40, this.radius});

  /// 头像直径（逻辑像素）
  final double size;

  /// 旧参数：圆角方底的圆角。底现在是正圆，这个值**不再被读**——
  /// 保留只是为了不惊动那两个还传着它的调用点（token 门、空页占位）；
  /// 顺手改它们的构造参数属于一次与"换图案"无关的重构，不在这轮的盘子里。
  final double? radius;

  /// 这一档的小图。**按尺寸在大小两档之间选**：小档（`mark-16`，针尖加粗的专用几何）
  /// 只有 16 逻辑像素的底图，撑到 56 那种大头上（空会话页那枚）就是 3.5 倍拉伸，糊。
  /// 分界取 32：≤32 用小档，>32 用大档。两档都是 1x/2x/3x 成套的。
  static const _smallStem = 'mark-16';
  static const _largeStem = 'mark-48';

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final stem = size <= 32 ? _smallStem : _largeStem;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        shape: BoxShape.circle,
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Center(
        child: Image.asset(
          _markAsset(stem, Theme.of(context).brightness),
          width: size * 0.625,
          height: size * 0.625,
          fit: BoxFit.contain,
          filterQuality: FilterQuality.high,
          errorBuilder: (context, error, stack) => const ColoredBox(color: Colors.red),
        ),
      ),
    );
  }
}

/// 呼吸状态点：沉睡 2.4s 缓慢呼吸、运行常亮、告警 1s 脉冲（只动 opacity）
class BreathDot extends StatefulWidget {
  const BreathDot({super.key, required this.kind, this.size = 8});

  final String kind;
  final double size;

  @override
  State<BreathDot> createState() => _BreathDotState();
}

class _BreathDotState extends State<BreathDot> with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  // kind 变化时要在 didUpdateWidget 里换挡（进页时 'loading' → 实测状态就是这么变的）：
  // 这个字段不能是 final，否则二次赋值抛 LateInitializationError
  late Animation<double> _opacity;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: _duration());
    _opacity = Tween<double>(begin: 1, end: _minOpacity()).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );
    if (_animates()) _controller.repeat(reverse: true);
  }

  Duration _duration() =>
      widget.kind == 'running' ? const Duration(seconds: 1) : const Duration(milliseconds: 2400);

  double _minOpacity() => widget.kind == 'running' ? 1 : 0.45;

  bool _animates() => widget.kind != 'running';

  @override
  void didUpdateWidget(BreathDot old) {
    super.didUpdateWidget(old);
    if (old.kind != widget.kind) {
      _controller.duration = _duration();
      _opacity = Tween<double>(begin: 1, end: _minOpacity()).animate(
        CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
      );
      _controller.stop();
      if (_animates()) {
        _controller.repeat(reverse: true);
      } else {
        _controller.value = 0;
      }
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _opacity,
      child: Container(
        width: widget.size,
        height: widget.size,
        decoration: BoxDecoration(
          color: IrmiaTheme.dotColor(widget.kind),
          shape: BoxShape.circle,
        ),
      ),
    );
  }
}
