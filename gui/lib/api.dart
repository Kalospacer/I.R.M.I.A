import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// 主进程 API 客户端（与 Web 端同一批端点、同一个 token）
/// 规格：docs/gui-design.md §5。零第三方依赖——只用 dart:io 的 HttpClient。
class IrmiaApi {
  IrmiaApi({required this.baseUrl, this.token});

  final String baseUrl;
  String? token;

  /// 常用 GET：解析 JSON；401 抛 ApiAuthError 让上层弹门
  Future<dynamic> get(String path) async {
    final res = await _send('GET', path);
    return _decode(res);
  }

  /// 命令 POST：body 为 JSON；危险操作可带 confirm 短语（X-Confirm 头）
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    final res = await _send('POST', path, body: body, confirm: confirm);
    return _decode(res);
  }

  /// 资源 PUT：只给「写一份配置资源」用（协议端的 `PUT /api/protocol-side/config`）。
  ///
  /// 为什么与 post 分开而不是复用：那条端点的语义是**可重复提交**（同样的 body 发两遍结果一样），
  /// 而 `/api/commands/*` 那批是"触发一个动作"（唤醒、结案、安装），两者对重试的容忍度不同。
  /// 走同一段 HTTP 通道，只把方法名分开——服务端据此区分的也正是这件事。
  Future<dynamic> put(String path, Map<String, dynamic> body) async {
    final res = await _send('PUT', path, body: body);
    return _decode(res);
  }

  Future<HttpClientResponse> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    String? confirm,
  }) async {
    // connectionTimeout **只管建连那一下**（dart:_http 里它只包在 Socket.startConnect 外面），
    // 不覆盖整条请求——这正是「一键安装」那条同步端点能跑一两分钟而不被掐断的原因。
    // 所以别把它当成"请求超时"：真要给某条请求设总时限，得自己想清楚超时之后服务端还在做什么
    // （安装那条就不能设：回执丢了而东西装好了，是这里最难查的一种故障）。
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
    try {
      final uri = Uri.parse('$baseUrl$path');
      final req = await client.openUrl(method, uri);
      if (token != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      if (confirm != null) req.headers.set('X-Confirm', confirm);
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(body));
      }
      final res = await req.close();
      if (res.statusCode == 401) {
        throw const ApiAuthError('认证失败：token 无效');
      }
      return res;
    } finally {
      // 响应读完后再关：调用方在 _decode 里读流
      client.close();
    }
  }

  Future<dynamic> _decode(HttpClientResponse res) async {
    final text = await res.transform(utf8.decoder).join();
    dynamic decoded;
    try {
      decoded = text.isEmpty ? null : jsonDecode(text);
    } catch (_) {
      decoded = text;
    }
    if (res.statusCode >= 400) {
      final message = decoded is Map && decoded['error'] is Map
          ? (decoded['error']['message']?.toString() ?? 'HTTP ${res.statusCode}')
          : 'HTTP ${res.statusCode}';
      throw ApiError(res.statusCode, message);
    }
    return decoded;
  }

  /// SSE 事件流：手工分行解析（data: 一行一条 JSON），断线由调用方重连。
  /// 返回的 Stream 关闭时请求随之取消。
  Stream<Map<String, dynamic>> events({int? lastEventId}) {
    final controller = StreamController<Map<String, dynamic>>();
    HttpClient? client;

    Future<void> start() async {
      client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
      try {
        final req = await client!.getUrl(Uri.parse('$baseUrl/api/events/stream'));
        if (token != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
        req.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
        if (lastEventId != null) req.headers.set('Last-Event-ID', '$lastEventId');
        final res = await req.close();
        if (res.statusCode == 401) {
          controller.addError(const ApiAuthError('认证失败：token 无效'));
          await controller.close();
          return;
        }
        var buffer = '';
        await for (final chunk in res.transform(utf8.decoder)) {
          buffer += chunk;
          while (true) {
            final idx = buffer.indexOf('\n');
            if (idx < 0) break;
            final line = buffer.substring(0, idx).trimRight();
            buffer = buffer.substring(idx + 1);
            if (!line.startsWith('data:')) continue; // event:/id:/retry: 行进 UI 不需要
            final payload = line.substring(5).trim();
            if (payload.isEmpty) continue;
            try {
              final parsed = jsonDecode(payload);
              if (parsed is Map<String, dynamic>) controller.add(parsed);
            } catch (_) {
              // 单行坏数据不打断整条流
            }
          }
        }
        if (!controller.isClosed) await controller.close();
      } catch (err) {
        if (!controller.isClosed) {
          controller.addError(err);
          await controller.close();
        }
      }
    }

    controller.onListen = () {
      unawaited(start());
    };
    controller.onCancel = () {
      client?.close(force: true);
    };
    return controller.stream;
  }
}

class ApiAuthError implements Exception {
  const ApiAuthError(this.message);
  final String message;
  @override
  String toString() => message;
}

class ApiError implements Exception {
  const ApiError(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}
