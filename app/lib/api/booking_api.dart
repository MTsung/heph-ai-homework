import '../models/booking_models.dart';
import 'api_client.dart';

class BookingApi {
  BookingApi(this._client);
  final ApiClient _client;

  Future<bool> detect(String text) async => (await _client.post('/bookings/detect', {'text': text}))['is_booking'] == true;
  Future<BookingView> create(String text, String clientRequestId) async =>
      BookingView.fromJson(await _client.post('/bookings', {'text': text, 'client_request_id': clientRequestId}));

  /// 依分組列出訂位。history 可依結果篩選(succeeded / failed / unknown / cancelled / expired)並以 [before] 翻頁。
  Future<BookingPage> list(BookingListView view, {int limit = 30, String? result, bool includeDrafts = false, String? before}) async {
    final json = await _client.get(
      '/bookings',
      query: {'view': view.query, 'limit': limit, 'result': ?result, if (includeDrafts) 'include_drafts': 'true', 'before': ?before},
    );
    return BookingPage(
      items: (json['items'] as List).map((x) => BookingSummary.fromJson((x as Map).cast<String, dynamic>())).toList(),
      nextBefore: json['next_before'] as String?,
    );
  }

  Future<BookingView> get(String id) async => BookingView.fromJson(await _client.get('/bookings/$id'));
  Future<BookingView> message(String id, String text, String clientMsgId) async =>
      BookingView.fromJson(await _client.post('/bookings/$id/messages', {'text': text, 'client_msg_id': clientMsgId}));
  Future<BookingView> slots(String id, Map<String, dynamic> body) async => BookingView.fromJson(await _client.patch('/bookings/$id/slots', body));
  Future<BookingView> confirm(String id, String hash) async => BookingView.fromJson(await _client.post('/bookings/$id/confirm', {'plan_hash': hash}));
  Future<BookingView> cancel(String id) async => BookingView.fromJson(await _client.post('/bookings/$id/cancel'));
}
