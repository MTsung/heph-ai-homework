import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/booking_api.dart';
import '../models/booking_models.dart';

/// 一筆訂位需求的客戶端狀態。booking 是 JSON request/response,沒有專屬 SSE;
/// 確認後才以短輪詢取得 browser-worker 的進度與最終結果。
class BookingController extends ChangeNotifier {
  BookingController({required BookingApi api, required BookingView initial, required this.onBalance, required this.onChanged})
    : _api = api,
      booking = initial {
    _pollIfNeeded();
  }

  final BookingApi _api;
  BookingView booking;
  final Future<void> Function() onBalance;
  final VoidCallback onChanged;

  bool busy = false;

  /// 使用者觸發的操作正在等後端回應(輪詢重新整理不算),畫面用來顯示「處理中」氣泡
  bool waiting = false;
  String? error;
  Timer? _poll;
  bool _disposed = false;

  bool get running => booking.status == BookingStatus.confirmed || booking.status == BookingStatus.executing;
  bool get canCancel => booking.status == BookingStatus.collecting || booking.status == BookingStatus.awaitingConfirmation;

  /// 重新讀取(也是執行中每 2 秒的輪詢)。狀態沒變就不通知側邊欄重讀分組,避免輪詢時多打列表 API。
  Future<void> refresh() async {
    await _perform(() async => _replace(await _api.get(booking.id)), refreshPoints: false, quiet: true);
  }

  Future<void> message(String text) async {
    await _perform(() async => _replace(await _api.message(booking.id, text, _id())));
  }

  Future<void> chooseRestaurant(String id) async {
    await _perform(() async => _replace(await _api.slots(booking.id, {'restaurant_id': id, 'client_msg_id': _id()})));
  }

  Future<void> chooseTime(String time) async {
    await _perform(() async => _replace(await _api.slots(booking.id, {'time': time, 'client_msg_id': _id()})));
  }

  Future<void> submitSlots({
    String? date,
    String? time,
    int? partySize,
    Map<String, String>? contact,
    Map<String, String>? extra,
    String? notes,
  }) async {
    await _perform(
      () async => _replace(
        await _api.slots(booking.id, {
          if (date != null) 'date': date,
          if (time != null) 'time': time,
          if (partySize != null) 'party_size': partySize,
          if (contact != null) 'contact': contact,
          if (extra != null) 'extra': extra,
          if (notes != null && notes.isNotEmpty) 'notes': notes,
          'client_msg_id': _id(),
        }),
      ),
    );
  }

  Future<void> confirm() async {
    final plan = booking.plan;
    if (plan == null || !plan.canConfirm) return;
    await _perform(() async => _replace(await _api.confirm(booking.id, plan.hash)));
  }

  Future<void> cancel() async {
    await _perform(() async => _replace(await _api.cancel(booking.id)), refreshPoints: false);
  }

  Future<void> _perform(Future<void> Function() action, {bool refreshPoints = true, bool quiet = false}) async {
    if (busy) return;
    busy = true;
    waiting = !quiet;
    error = null;
    notifyListeners();
    final before = booking.status;
    try {
      await action();
      final changed = booking.status != before;
      // 輪詢時從「執行中」變成結果(成功會扣點)也要更新點數
      if (refreshPoints || (quiet && changed)) await onBalance();
      if (!quiet || changed) onChanged();
    } on ApiException catch (e) {
      error = switch (e.code) {
        'INSUFFICIENT_POINTS' => '點數不足，無法處理這筆訂位。',
        'SERVER_BUSY' => '目前同時處理訂位的人數已滿，請稍後再試。',
        'PLAN_EXPIRED' => '方案已過期，請重新建立訂位需求。',
        'PLAN_CHANGED' => '方案已更新，請確認最新內容。',
        'TURN_IN_PROGRESS' => '上一個操作仍在處理，請稍後再試。',
        _ => e.message,
      };
    } finally {
      busy = false;
      waiting = false;
      if (!_disposed) notifyListeners();
    }
  }

  void _replace(BookingView next) {
    booking = next;
    _pollIfNeeded();
  }

  void _pollIfNeeded() {
    _poll?.cancel();
    if (!running || _disposed) return;
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => refresh());
  }

  static final _random = Random.secure();
  static String _id() {
    final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    super.dispose();
  }
}
