import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'sse.dart';

/// 後端回傳的錯誤(格式 `{ "error": { "code": "...", "message": "..." } }`)。
class ApiException implements Exception {
  ApiException(this.status, this.code, this.message, [this.extra = const {}]);

  final int status;
  final String code;
  final String message;
  final Map<String, dynamic> extra;

  /// 登入已失效,必須回到登入畫面
  bool get isAuthFailure => status == 401 && code != 'INVALID_CREDENTIALS';

  /// 被另一台裝置登入踢掉
  bool get isSessionReplaced => code == 'SESSION_REPLACED';

  bool get isInsufficientPoints => code == 'INSUFFICIENT_POINTS';

  @override
  String toString() => 'ApiException($status $code: $message)';
}

/// 與後端 gateway 溝通的唯一入口。
class ApiClient {
  ApiClient({required this.baseUrl, http.Client? client}) : _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  String? token;

  /// 任何請求收到 401(登入失效)時通知上層
  void Function(ApiException error)? onAuthFailure;

  Map<String, String> get _headers => {
        'content-type': 'application/json',
        if (token != null) 'authorization': 'Bearer $token',
      };

  Uri _uri(String path, [Map<String, dynamic>? query]) => Uri.parse('$baseUrl/v1$path').replace(
        queryParameters: query?.map((k, v) => MapEntry(k, v.toString())),
      );

  Future<Map<String, dynamic>> _json(http.Response res) async {
    final body = utf8.decode(res.bodyBytes);
    final decoded = body.isEmpty ? <String, dynamic>{} : jsonDecode(body);
    if (res.statusCode >= 400) throw _toException(res.statusCode, decoded);
    return (decoded as Map).cast<String, dynamic>();
  }

  ApiException _toException(int status, Object? decoded) {
    final err = (decoded is Map ? decoded['error'] : null);
    final e = err is Map
        ? ApiException(
            status,
            '${err['code'] ?? 'ERROR'}',
            '${err['message'] ?? '發生錯誤'}',
            err.cast<String, dynamic>(),
          )
        : ApiException(status, 'ERROR', '發生錯誤($status)');
    if (e.isAuthFailure) onAuthFailure?.call(e);
    return e;
  }

  Future<Map<String, dynamic>> get(String path, {Map<String, dynamic>? query}) async {
    try {
      return await _json(await _client.get(_uri(path, query), headers: _headers).timeout(const Duration(seconds: 15)));
    } on TimeoutException {
      throw ApiException(0, 'TIMEOUT', '連線逾時,請檢查網路');
    } on http.ClientException catch (e) {
      throw ApiException(0, 'NETWORK', '無法連線到伺服器:${e.message}');
    }
  }

  Future<Map<String, dynamic>> post(String path, [Object? body]) async {
    try {
      return await _json(await _client
          .post(_uri(path), headers: _headers, body: jsonEncode(body ?? {}))
          .timeout(const Duration(seconds: 15)));
    } on TimeoutException {
      throw ApiException(0, 'TIMEOUT', '連線逾時,請檢查網路');
    } on http.ClientException catch (e) {
      throw ApiException(0, 'NETWORK', '無法連線到伺服器:${e.message}');
    }
  }

  Future<Map<String, dynamic>> delete(String path, [Object? body]) async {
    try {
      final req = http.Request('DELETE', _uri(path))
        ..headers.addAll(_headers)
        ..body = jsonEncode(body ?? {});
      return await _json(await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 15))));
    } on TimeoutException {
      throw ApiException(0, 'TIMEOUT', '連線逾時,請檢查網路');
    } on http.ClientException catch (e) {
      throw ApiException(0, 'NETWORK', '無法連線到伺服器:${e.message}');
    }
  }

  /// 開啟一條 SSE 串流。
  /// 回應不是 text/event-stream(例如 402 點數不足、409 忙碌)時丟出 [ApiException];
  /// 取消訂閱時會關閉底層連線([http.Client] 的串流以取消訂閱來中止)。
  Stream<SseEvent> sse(String method, String path, {Object? body}) {
    late StreamController<SseEvent> controller;
    StreamSubscription<SseEvent>? sub;
    final client = http.Client(); // 每條串流用獨立連線,關閉它就等於中止請求

    controller = StreamController<SseEvent>(
      onListen: () async {
        try {
          final req = http.Request(method, _uri(path))
            ..headers.addAll(_headers)
            ..headers['accept'] = 'text/event-stream';
          if (body != null) req.body = jsonEncode(body);
          final res = await client.send(req).timeout(const Duration(seconds: 20));
          final type = res.headers['content-type'] ?? '';
          if (!type.startsWith('text/event-stream')) {
            final text = await res.stream.bytesToString();
            throw _toException(res.statusCode, text.isEmpty ? null : jsonDecode(text));
          }
          sub = parseSse(res.stream).listen(
            controller.add,
            onError: controller.addError,
            onDone: () {
              controller.close();
              client.close();
            },
          );
        } on TimeoutException {
          controller.addError(ApiException(0, 'TIMEOUT', '連線逾時,請檢查網路'));
          await controller.close();
          client.close();
        } on http.ClientException catch (e) {
          controller.addError(ApiException(0, 'NETWORK', '無法連線到伺服器:${e.message}'));
          await controller.close();
          client.close();
        } catch (e) {
          controller.addError(e);
          await controller.close();
          client.close();
        }
      },
      onCancel: () async {
        await sub?.cancel();
        client.close();
      },
    );
    return controller.stream;
  }

  void close() => _client.close();
}
