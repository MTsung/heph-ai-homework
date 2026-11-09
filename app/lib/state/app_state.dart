import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../api/booking_api.dart';
import '../models/booking_models.dart';
import '../models/models.dart';
import 'booking_controller.dart';
import 'chat_controller.dart';

/// 為什麼目前沒有登入
enum LogoutReason { none, replacedByOtherDevice, expired }

/// 全域狀態:登入 session、角色、對話列表、點數。
class AppState extends ChangeNotifier {
  AppState({required this.api, required SharedPreferences prefs}) : _prefs = prefs {
    api.onAuthFailure = _onAuthFailure;
  }

  final ApiClient api;
  final SharedPreferences _prefs;

  // ---- session
  String? userId;
  String? username;
  String? nickname;
  bool get loggedIn => api.token != null;
  LogoutReason logoutReason = LogoutReason.none;
  String? replacedByDevice; // 「已在 XXX 登入」

  // ---- 資料
  List<Character> characters = [];
  Map<String, ConversationSummary> conversationsByCharacter = {};
  Balance? balance;
  String? selectedCharacterId;
  ChatController? chat;
  late final BookingApi bookingApi = BookingApi(api);
  BookingController? booking;
  List<BookingSummary> activeBookings = [];
  bool showingBooking = false;

  bool bootstrapping = true;

  StreamSubscription? _events;
  Timer? _eventsRetry;

  // ------------------------------------------------------------------ 裝置識別
  /// 這台裝置的固定 ID(第一次啟動時產生),登入時送給伺服器,用來顯示「你已在 XXX 登入」
  String get deviceId {
    var id = _prefs.getString('device_id');
    if (id == null) {
      final r = Random.secure();
      id = List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
      _prefs.setString('device_id', id);
    }
    return id;
  }

  String get deviceName {
    final host = Platform.localHostname.replaceAll('.local', '');
    return host.isEmpty ? 'Mac' : host;
  }

  // ------------------------------------------------------------------ 啟動:還原登入
  Future<void> bootstrap() async {
    final saved = _prefs.getString('token');
    if (saved != null) {
      api.token = saved;
      try {
        final me = await api.get('/me');
        userId = me['id'] as String;
        username = me['username'] as String;
        nickname = me['nickname'] as String;
        await _loadHome();
        _openEventChannel();
      } on ApiException catch (e) {
        if (e.isSessionReplaced) {
          logoutReason = LogoutReason.replacedByOtherDevice;
        }
        _clearSession();
      }
    }
    bootstrapping = false;
    notifyListeners();
  }

  // ------------------------------------------------------------------ 登入 / 註冊 / 登出
  Future<void> login(String username, String password) => _auth('/auth/login', username, password);

  Future<void> register(String username, String password, String nickname) => _auth('/auth/register', username, password, nickname: nickname);

  Future<void> _auth(String path, String username, String password, {String? nickname}) async {
    final res = await api.post(path, {
      'username': username,
      'password': password,
      if (nickname != null && nickname.isNotEmpty) 'nickname': nickname,
      'device_id': deviceId,
      'device_name': deviceName,
    });
    api.token = res['token'] as String;
    await _prefs.setString('token', api.token!);
    final u = (res['user'] as Map).cast<String, dynamic>();
    userId = u['id'] as String;
    this.username = u['username'] as String;
    nickname = u['nickname'] as String;
    logoutReason = LogoutReason.none;
    replacedByDevice = null;
    await _loadHome();
    _openEventChannel();
    notifyListeners();
  }

  Future<void> logout() async {
    // 先中斷事件通道再登出:伺服器登出時也會對自己的事件通道推送 session_replaced(reason: revoked),
    // 不先關掉的話,這個事件可能搶在 HTTP 回應之前到達,被誤判成「被其他裝置踢掉」。
    _events?.cancel();
    _eventsRetry?.cancel();
    try {
      await api.post('/auth/logout');
    } catch (_) {
      /* 離線也要能登出 */
    }
    _clearSession();
    notifyListeners();
  }

  /// 刪除帳號:伺服器會非同步清除所有對話與點數資料
  Future<void> deleteAccount(String password) async {
    await api.delete('/me', {'password': password});
    _clearSession();
    notifyListeners();
  }

  void _clearSession() {
    _events?.cancel();
    _eventsRetry?.cancel();
    chat?.dispose();
    booking?.dispose();
    chat = null;
    booking = null;
    activeBookings = [];
    showingBooking = false;
    api.token = null;
    _prefs.remove('token');
    userId = null;
    characters = [];
    conversationsByCharacter = {};
    balance = null;
    selectedCharacterId = null;
  }

  // ------------------------------------------------------------------ 單一裝置:被踢偵測
  void _onAuthFailure(ApiException e) {
    if (!loggedIn) return;
    logoutReason = e.isSessionReplaced ? LogoutReason.replacedByOtherDevice : LogoutReason.expired;
    _clearSession();
    notifyListeners();
  }

  /// 保持一條 SSE 事件通道。另一台裝置登入時,伺服器會立刻推送 session_replaced,
  /// 這台裝置不用等到下一次操作才發現被踢。斷線會自動重連。
  void _openEventChannel() {
    _events?.cancel();
    _eventsRetry?.cancel();
    if (!loggedIn) return;
    _events = api
        .sse('GET', '/events')
        .listen(
          (ev) {
            if (ev.event == 'session_replaced') {
              // reason: replaced = 另一台裝置登入;revoked = 登出 / 後台強制登出 / 帳號刪除
              final replaced = ev.json['reason'] == 'replaced';
              replacedByDevice = replaced ? ev.json['device_name'] as String? : null;
              logoutReason = replaced ? LogoutReason.replacedByOtherDevice : LogoutReason.expired;
              _clearSession();
              notifyListeners();
            }
          },
          onError: (Object e) {
            // 401(token 已失效)會經由 onAuthFailure 處理;其他錯誤稍後重連
            if (e is ApiException && e.isAuthFailure) return;
            _scheduleEventReconnect();
          },
          onDone: _scheduleEventReconnect,
          cancelOnError: true,
        );
  }

  void _scheduleEventReconnect() {
    if (!loggedIn) return;
    _eventsRetry?.cancel();
    _eventsRetry = Timer(const Duration(seconds: 3), _openEventChannel);
  }

  // ------------------------------------------------------------------ 首頁資料
  Future<void> _loadHome() async {
    final results = await Future.wait([api.get('/characters'), api.get('/conversations'), api.get('/points/balance')]);
    characters = (results[0]['items'] as List).map((e) => Character.fromJson((e as Map).cast())).toList();
    conversationsByCharacter = {
      for (final c in (results[1]['items'] as List).map((e) => ConversationSummary.fromJson((e as Map).cast()))) c.characterId: c,
    };
    balance = Balance.fromJson(results[2]);
    // 訂位入口失敗不應阻斷既有聊天首頁;使用者稍後開啟或重新整理會再讀。
    activeBookings = await bookingApi.active().catchError((_) => <BookingSummary>[]);
  }

  Future<void> refreshBalance() async {
    try {
      balance = Balance.fromJson(await api.get('/points/balance'));
      notifyListeners();
    } on ApiException {
      /* 靜默 */
    }
  }

  Future<List<LedgerEntry>> loadLedger({int? beforeId}) async {
    final res = await api.get('/points/ledger', query: {'limit': 50, if (beforeId != null) 'before_id': beforeId});
    return (res['items'] as List).map((e) => LedgerEntry.fromJson((e as Map).cast())).toList();
  }

  // ------------------------------------------------------------------ 訂位代辦
  /// 在一般聊天送出前做免費意圖判斷。回傳 true 代表已經切換到訂位流程,呼叫端不可再送進 chat SSE。
  Future<bool> startBookingIfNeeded(String text) async {
    if (text.trim().isEmpty) return false;
    if (!await bookingApi.detect(text)) return false;
    final id = '${DateTime.now().microsecondsSinceEpoch}-${Random.secure().nextInt(1 << 32)}';
    final initial = await bookingApi.create(text, id);
    _showBooking(initial);
    return true;
  }

  Future<void> openBooking(String id) async {
    try {
      _showBooking(await bookingApi.get(id));
    } on ApiException catch (e) {
      lastError = e.message;
      notifyListeners();
    }
  }

  void showChat() {
    showingBooking = false;
    notifyListeners();
  }

  void _showBooking(BookingView initial) {
    booking?.dispose();
    booking = BookingController(api: bookingApi, initial: initial, onBalance: refreshBalance, onChanged: () => _refreshActiveBookings());
    showingBooking = true;
    _refreshActiveBookings();
    notifyListeners();
  }

  Future<void> _refreshActiveBookings() async {
    try {
      activeBookings = await bookingApi.active();
      if (!showingBooking) notifyListeners();
    } on ApiException {
      /* 不影響既有畫面 */
    }
  }

  // ------------------------------------------------------------------ 選角色 → 開啟對話
  Future<void> openCharacter(Character c) async {
    if (selectedCharacterId == c.id && chat != null) return;
    selectedCharacterId = c.id;
    showingBooking = false;
    chat?.dispose();
    chat = null;
    notifyListeners();
    try {
      final conv = ConversationSummary.fromJson(await api.post('/conversations', {'character_id': c.id}));
      conversationsByCharacter[c.id] = conv;
      final controller = ChatController(
        api: api,
        conversationId: conv.id,
        onBalance: (b) {
          balance = Balance(balance: b, held: 0, available: b);
          notifyListeners();
          // 伺服器回的是結算後餘額;預扣中的部分(其他進行中的回覆)稍後再校正
          Future.delayed(const Duration(seconds: 1), refreshBalance);
        },
        onPreview: (text) {
          final cur = conversationsByCharacter[c.id];
          if (cur != null) {
            conversationsByCharacter[c.id] = ConversationSummary(
              id: cur.id,
              characterId: cur.characterId,
              lastPreview: text.length > 40 ? '${text.substring(0, 40)}…' : text,
              lastMessageAt: DateTime.now(),
              latestSeq: cur.latestSeq,
            );
            notifyListeners();
          }
        },
      );
      // 在 await 期間使用者可能又切換了角色;過時的結果丟掉
      if (selectedCharacterId != c.id) {
        controller.dispose();
        return;
      }
      chat = controller;
      notifyListeners();
      await controller.load();
    } on ApiException catch (e) {
      selectedCharacterId = null;
      lastError = e.message;
      notifyListeners();
    }
  }

  String? lastError;
}
