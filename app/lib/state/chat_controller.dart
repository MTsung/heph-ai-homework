import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/sse.dart';
import '../models/models.dart';

/// 單一對話的狀態:訊息列表、歷史分頁、送出、串流、重試、續傳。
///
/// 設計重點:
///  - 訊息以伺服器給的 [ChatMessage.seq] 排序與去重(對話內嚴格遞增、無空洞),不靠時間戳。
///  - 送出時先樂觀顯示;冪等鍵 clientMsgId 在重試時**沿用同一個**,
///    所以網路抖動、使用者連點重試都不會重複送出或重複扣點。
///  - 串流和連線脫鉤:伺服器端會把回覆生成完。畫面這邊斷線(切換對話、網路中斷)時,
///    用 /stream 續傳端點接回來,先收到 snapshot(斷線期間累積的內容),再繼續收後續片段。
class ChatController extends ChangeNotifier {
  ChatController({
    required this.api,
    required this.conversationId,
    required this.onBalance,
    required this.onPreview,
  });

  final ApiClient api;
  final String conversationId;

  /// 回覆完成時伺服器帶回的最新餘額
  final void Function(int balance) onBalance;
  final void Function(String preview) onPreview;

  final List<ChatMessage> messages = []; // 依 seq 由舊到新;尚未配號的本地訊息(seq = -1)排在最後
  bool loading = true;
  bool loadingOlder = false;
  bool hasMoreOlder = false;
  String? loadError;

  /// 目前是否有一則 AI 回覆正在進行(輸入框據此停用送出)
  bool get busy => messages.any((m) => m.status == MessageStatus.streaming || m.status == MessageStatus.sending);

  /// 送出時的即時錯誤(點數不足、忙碌…),顯示在輸入框上方
  String? sendError;
  bool insufficientPoints = false;

  StreamSubscription<SseEvent>? _sub;
  bool _disposed = false;
  int _resumeAttempts = 0;

  // ------------------------------------------------------------------ 載入歷史
  Future<void> load() async {
    loading = true;
    loadError = null;
    notifyListeners();
    try {
      final res = await api.get('/conversations/$conversationId/messages', query: {'limit': 30});
      _replaceWith((res['items'] as List).map((e) => ChatMessage.fromJson((e as Map).cast())).toList());
      hasMoreOlder = res['has_more_before'] == true;
      loading = false;
      notifyListeners();
      _resumeIfStreaming();
    } on ApiException catch (e) {
      loadError = e.message;
      loading = false;
      notifyListeners();
    }
  }

  /// 往上滑:用目前最舊那則的 seq 當游標(keyset 分頁),不會因為新訊息進來而重複或漏掉
  Future<void> loadOlder() async {
    if (loadingOlder || !hasMoreOlder || messages.isEmpty) return;
    final oldest = messages.firstWhere((m) => m.seq > 0, orElse: () => messages.first).seq;
    if (oldest <= 1) {
      hasMoreOlder = false;
      return;
    }
    loadingOlder = true;
    notifyListeners();
    try {
      final res = await api.get('/conversations/$conversationId/messages', query: {'before_seq': oldest, 'limit': 30});
      final older = (res['items'] as List).map((e) => ChatMessage.fromJson((e as Map).cast())).toList();
      _merge(older);
      hasMoreOlder = res['has_more_before'] == true;
    } on ApiException {
      // 載入更早的訊息失敗不打斷閱讀;使用者再往上滑會重試
    } finally {
      loadingOlder = false;
      notifyListeners();
    }
  }

  /// App 回到前景 / 網路恢復後,把可能漏掉的訊息補回來(另一台裝置曾經發過訊息的情況)
  Future<void> syncNewer() async {
    final latest = messages.where((m) => m.seq > 0).fold<int>(0, (a, m) => max(a, m.seq));
    try {
      final res = await api.get('/conversations/$conversationId/messages', query: {'after_seq': latest, 'limit': 100});
      final newer = (res['items'] as List).map((e) => ChatMessage.fromJson((e as Map).cast())).toList();
      if (newer.isNotEmpty) {
        _merge(newer);
        notifyListeners();
        _resumeIfStreaming();
      }
    } on ApiException {
      /* 靜默失敗 */
    }
  }

  // ------------------------------------------------------------------ 送出
  /// [clientMsgId] 為 null 表示新訊息;重試時傳入同一個 id。
  Future<void> send(String text, {String? clientMsgId}) async {
    final content = text.trim();
    if (content.isEmpty || (busy && clientMsgId == null)) return;
    sendError = null;
    insufficientPoints = false;
    final cmid = clientMsgId ?? _newId();

    // 樂觀顯示。重試時(同一個 cmid)沿用原本那則,不重複加
    var local = messages.where((m) => m.clientMsgId == cmid && m.isUser).firstOrNull;
    if (local == null) {
      local = ChatMessage(
        id: 'local-$cmid',
        seq: -1,
        role: 'user',
        content: content,
        status: MessageStatus.completed,
        createdAt: DateTime.now(),
        clientMsgId: cmid,
      );
      messages.add(local);
    }
    // 重試:移除上一次失敗的 AI 泡泡,伺服器會沿用同一則訊息重新生成
    messages.removeWhere((m) => !m.isUser && m.status == MessageStatus.failed && m.seq == (local!.seq > 0 ? local.seq + 1 : -2));
    notifyListeners();

    await _runStream(
      api.sse('POST', '/conversations/$conversationId/messages', body: {'content': content, 'client_msg_id': cmid}),
      pendingUser: local,
    );
  }

  /// 失敗的 AI 回覆 → 重試(用同一個 client_msg_id)
  Future<void> retryLast() async {
    final failedIdx = messages.lastIndexWhere((m) => !m.isUser && m.status == MessageStatus.failed);
    if (failedIdx < 0) return;
    final user = messages.sublist(0, failedIdx).lastWhere((m) => m.isUser, orElse: () => messages.first);
    if (!user.isUser || user.clientMsgId == null) {
      // 從伺服器載入的歷史訊息也帶有 client_msg_id;沒有的話(開場白)無法重試
      return;
    }
    messages.removeAt(failedIdx);
    await send(user.content, clientMsgId: user.clientMsgId);
  }

  // ------------------------------------------------------------------ 串流處理
  ChatMessage? _streamingAssistant;

  Future<void> _runStream(Stream<SseEvent> stream, {ChatMessage? pendingUser}) async {
    await _sub?.cancel();
    final done = Completer<void>();
    var gotTerminal = false;

    _sub = stream.listen(
      (ev) {
        gotTerminal = _handle(ev, pendingUser) || gotTerminal;
      },
      onError: (Object e) {
        if (e is ApiException) {
          _onSendFailure(e, pendingUser);
          gotTerminal = true;
        }
        if (!done.isCompleted) done.complete();
      },
      onDone: () {
        if (!done.isCompleted) done.complete();
      },
      cancelOnError: true,
    );
    await done.future;
    if (_disposed) return;

    // 串流提前結束(沒收到 done / error):網路中斷。回覆在伺服器端仍會生成完,用續傳接回來。
    if (!gotTerminal && _streamingAssistant != null && !_disposed) {
      _scheduleResume();
    }
  }

  /// 回傳 true 表示這是終止事件(done / error)
  bool _handle(SseEvent ev, ChatMessage? pendingUser) {
    switch (ev.event) {
      case 'user_message':
        final m = ChatMessage.fromJson(ev.json);
        if (pendingUser != null) {
          pendingUser.seq = m.seq; // 本地訊息換成伺服器配的序號(id 維持不變,畫面不會閃動)
          pendingUser.clientMsgId = m.clientMsgId ?? pendingUser.clientMsgId;
        } else {
          _merge([m]);
        }
        notifyListeners();
        return false;

      case 'assistant_start':
        final j = ev.json;
        final seq = j['seq'] as int;
        final existing = messages.where((m) => m.id == j['id']).firstOrNull;
        if (existing != null) {
          existing
            ..status = MessageStatus.streaming
            ..content = '';
          _streamingAssistant = existing;
        } else {
          final m = ChatMessage(
            id: j['id'] as String,
            seq: seq,
            role: 'assistant',
            content: '',
            status: MessageStatus.streaming,
            createdAt: DateTime.tryParse('${j['created_at']}')?.toLocal() ?? DateTime.now(),
          );
          messages.add(m);
          _sortMessages();
          _streamingAssistant = m;
        }
        _resumeAttempts = 0;
        notifyListeners();
        return false;

      case 'snapshot':
        // 續傳時:伺服器告知「到目前為止已經生成的完整內容」,直接取代,不會重複
        final target = _streamingAssistant ?? messages.where((m) => m.id == ev.json['id']).firstOrNull;
        if (target != null) {
          target.content = ev.json['content'] as String;
          notifyListeners();
        }
        return false;

      case 'delta':
        final t = _streamingAssistant;
        if (t != null) {
          t.content += ev.json['t'] as String;
          notifyListeners();
        }
        return false;

      case 'done':
        final j = ev.json;
        final final_ = ChatMessage.fromJson((j['message'] as Map).cast());
        final t = _streamingAssistant ?? messages.where((m) => m.id == final_.id).firstOrNull;
        if (t != null) {
          t.content = final_.content;
          t.status = MessageStatus.completed;
        } else {
          _merge([final_]);
        }
        _streamingAssistant = null;
        final bal = j['balance'];
        if (bal is int) onBalance(bal);
        onPreview(final_.content);
        notifyListeners();
        return true;

      case 'error':
        final j = ev.json;
        final t = _streamingAssistant ?? messages.where((m) => m.id == (j['state'] as Map)['id']).firstOrNull;
        if (t != null) {
          t.status = MessageStatus.failed;
          t.errorCode = j['code'] as String?;
          t.errorText = j['message'] as String?;
          final partial = (j['state'] as Map)['content'];
          if (partial is String && partial.length >= t.content.length) t.content = partial;
        }
        _streamingAssistant = null;
        notifyListeners();
        return true;
    }
    return false;
  }

  void _onSendFailure(ApiException e, ChatMessage? pendingUser) {
    // 沒有進入串流就失敗:點數不足(402)、對話忙碌(409)、被限流(429)、網路問題…
    // 這些情況伺服器都不會留下訊息,所以把樂觀顯示的那則拿掉,並把文字還給輸入框由使用者決定
    if (pendingUser != null && pendingUser.seq < 0) messages.remove(pendingUser);
    insufficientPoints = e.isInsufficientPoints;
    sendError = switch (e.code) {
      'INSUFFICIENT_POINTS' => '點數不足,無法繼續對話',
      'GENERATION_IN_PROGRESS' => 'AI 還在回覆上一則訊息,請稍候',
      'RATE_LIMITED' => '送得太快了,請稍後再試',
      'SERVER_BUSY' || 'SERVER_DRAINING' || 'UPSTREAM_UNAVAILABLE' || 'SERVICE_UNAVAILABLE' => '系統忙碌中,請稍後再試',
      _ => e.message,
    };
    _streamingAssistant = null;
    notifyListeners();
  }

  // ------------------------------------------------------------------ 續傳
  void _resumeIfStreaming() {
    final s = messages.where((m) => m.status == MessageStatus.streaming && !m.isUser).lastOrNull;
    if (s == null || _sub != null && _streamingAssistant != null) return;
    _streamingAssistant = s;
    _resume(s);
  }

  void _scheduleResume() {
    final s = _streamingAssistant;
    if (s == null || _resumeAttempts >= 6) {
      // 放棄自動續傳:標成失敗讓使用者手動重試;伺服器端其實可能已生成完,重試會取回完成的結果
      s?.status = MessageStatus.failed;
      s?.errorText = '連線中斷,請重試';
      _streamingAssistant = null;
      notifyListeners();
      return;
    }
    _resumeAttempts++;
    final delay = Duration(milliseconds: 500 * (1 << (_resumeAttempts - 1))); // 0.5s, 1s, 2s, 4s…
    Future.delayed(delay, () {
      if (!_disposed && _streamingAssistant != null) _resume(_streamingAssistant!);
    });
  }

  Future<void> _resume(ChatMessage target) async {
    await _runStream(api.sse('GET', '/conversations/$conversationId/messages/${target.id}/stream'));
  }

  // ------------------------------------------------------------------ 合併 / 排序
  void _replaceWith(List<ChatMessage> items) {
    messages
      ..clear()
      ..addAll(items);
    _sortMessages();
  }

  /// 以 seq 去重合併;同一個 seq 以伺服器版本為準
  void _merge(List<ChatMessage> incoming) {
    for (final m in incoming) {
      final i = messages.indexWhere((x) => x.id == m.id || (x.seq > 0 && x.seq == m.seq));
      if (i >= 0) {
        // 保留本地的 id,避免 ListView 的 key 變動造成閃動
        final keep = messages[i];
        keep
          ..seq = m.seq
          ..content = m.content
          ..status = m.status
          ..errorCode = m.errorCode;
      } else {
        messages.add(m);
      }
    }
    _sortMessages();
  }

  void _sortMessages() {
    messages.sort((a, b) {
      final sa = a.seq < 0 ? 1 << 40 : a.seq;
      final sb = b.seq < 0 ? 1 << 40 : b.seq;
      return sa.compareTo(sb);
    });
  }

  static final _rng = Random.secure();
  static String _newId() {
    final b = List<int>.generate(16, (_) => _rng.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    String h(int i) => b[i].toRadixString(16).padLeft(2, '0');
    return '${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}';
  }

  @override
  void dispose() {
    _disposed = true;
    // 只取消「收看」;伺服器端的回覆會繼續生成並存檔,下次打開對話時從歷史或續傳取回
    _sub?.cancel();
    super.dispose();
  }
}
