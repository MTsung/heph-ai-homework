enum BookingStatus { collecting, awaitingConfirmation, confirmed, executing, succeeded, failed, unknown, cancelled, expired }

BookingStatus bookingStatusFrom(String value) => switch (value) {
  'awaiting_confirmation' => BookingStatus.awaitingConfirmation,
  'confirmed' => BookingStatus.confirmed,
  'executing' => BookingStatus.executing,
  'succeeded' => BookingStatus.succeeded,
  'failed' => BookingStatus.failed,
  'unknown' => BookingStatus.unknown,
  'cancelled' => BookingStatus.cancelled,
  'expired' => BookingStatus.expired,
  _ => BookingStatus.collecting,
};

extension BookingStatusText on BookingStatus {
  String get text => switch (this) {
    BookingStatus.collecting => '補資料中',
    BookingStatus.awaitingConfirmation => '等待確認',
    BookingStatus.confirmed => '已確認',
    BookingStatus.executing => '正在訂位',
    BookingStatus.succeeded => '訂位成功',
    BookingStatus.failed => '訂位失敗',
    BookingStatus.unknown => '結果不明',
    BookingStatus.cancelled => '已取消',
    BookingStatus.expired => '已過期',
  };

  bool get active => switch (this) {
    BookingStatus.collecting || BookingStatus.awaitingConfirmation || BookingStatus.confirmed || BookingStatus.executing => true,
    _ => false,
  };
}

class BookingOption {
  BookingOption({required this.channel, this.url, this.platform, this.restaurantId});

  factory BookingOption.fromJson(Map<String, dynamic> j) => BookingOption(
    channel: j['channel'] as String,
    url: j['url'] as String?,
    platform: j['platform'] as String?,
    restaurantId: j['restaurantId'] as String?,
  );

  final String channel;
  final String? url;
  final String? platform;
  final String? restaurantId;
}

class BookingRestaurant {
  BookingRestaurant({
    required this.id,
    required this.name,
    required this.address,
    this.phone,
    this.district,
    this.cuisine,
    this.rating,
    this.booking,
  });

  factory BookingRestaurant.fromJson(Map<String, dynamic> j) => BookingRestaurant(
    id: j['id'] as String,
    name: j['name'] as String,
    address: (j['address'] ?? '') as String,
    phone: j['phone'] as String?,
    district: j['district'] as String?,
    cuisine: j['cuisine'] as String?,
    rating: (j['rating'] as num?)?.toDouble(),
    booking: j['booking'] as String?,
  );

  final String id;
  final String name;
  final String address;
  final String? phone;
  final String? district;
  final String? cuisine;
  final double? rating;
  final String? booking;
}

class BookingInfoField {
  BookingInfoField({required this.key, required this.label, required this.type, this.options = const []});

  factory BookingInfoField.fromJson(Map<String, dynamic> j) => BookingInfoField(
    key: j['key'] as String,
    label: j['label'] as String,
    type: j['type'] as String,
    options: (j['options'] as List? ?? const []).cast<String>(),
  );

  final String key;
  final String label;
  final String type;
  final List<String> options;
}

class BookingPending {
  BookingPending({required this.kind, this.restaurants = const [], this.fields = const [], this.times = const []});

  factory BookingPending.fromJson(Map<String, dynamic> j) => BookingPending(
    kind: j['kind'] as String,
    restaurants: (j['options'] as List? ?? const []).whereType<Map>().map((x) => BookingRestaurant.fromJson(x.cast<String, dynamic>())).toList(),
    fields: (j['fields'] as List? ?? const []).map((x) {
      // provide_slots 的 fields 是字串(date / time / party_size),provide_info 則是物件
      if (x is String) return BookingInfoField(key: x, label: x, type: 'text');
      return BookingInfoField.fromJson((x as Map).cast<String, dynamic>());
    }).toList(),
    times: (j['options'] as List? ?? const []).whereType<String>().toList(),
  );

  final String kind;
  final List<BookingRestaurant> restaurants;
  final List<BookingInfoField> fields;
  final List<String> times;
}

class BookingPlan {
  BookingPlan({
    required this.restaurant,
    required this.date,
    required this.time,
    required this.partySize,
    required this.contact,
    required this.hash,
    required this.canConfirm,
    this.expiresAt,
    this.notes,
    this.extra = const {},
  });

  factory BookingPlan.fromJson(Map<String, dynamic> j) => BookingPlan(
    restaurant: BookingRestaurant.fromJson((j['restaurant'] as Map).cast<String, dynamic>()),
    date: j['date'] as String,
    time: j['time'] as String,
    partySize: j['party_size'] as int,
    contact: ((j['contact'] as Map?) ?? const {}).cast<String, dynamic>().map((k, v) => MapEntry(k, '$v')),
    extra: ((j['extra'] as Map?) ?? const {}).cast<String, dynamic>().map((k, v) => MapEntry(k, '$v')),
    notes: j['notes'] as String?,
    hash: j['hash'] as String,
    canConfirm: j['can_confirm'] == true,
    expiresAt: j['expires_at'] == null ? null : DateTime.tryParse(j['expires_at'] as String)?.toLocal(),
  );

  final BookingRestaurant restaurant;
  final String date;
  final String time;
  final int partySize;
  final Map<String, String> contact;
  final Map<String, String> extra;
  final String? notes;
  final String hash;
  final bool canConfirm;
  final DateTime? expiresAt;
}

class BookingResult {
  BookingResult({required this.ok, this.confirmationNo, this.code, this.message});
  factory BookingResult.fromJson(Map<String, dynamic> j) => BookingResult(
    ok: j['ok'] == true,
    confirmationNo: j['confirmation_no'] as String?,
    code: j['code'] as String?,
    message: j['message'] as String?,
  );
  final bool ok;
  final String? confirmationNo;
  final String? code;
  final String? message;
}

class BookingEvent {
  BookingEvent({required this.id, required this.type, required this.text, required this.at});
  factory BookingEvent.fromJson(Map<String, dynamic> j) =>
      BookingEvent(id: j['id'] as int, type: j['type'] as String, text: (j['text'] ?? '') as String, at: DateTime.parse(j['at'] as String).toLocal());
  final int id;
  final String type;
  final String text;
  final DateTime at;
}

class BookingSummary {
  BookingSummary({
    required this.id,
    required this.status,
    required this.summary,
    required this.updatedAt,
    this.expiresAt,
    this.result,
    this.restaurantName,
    this.restaurantPhone,
    this.restaurantAddress,
    this.date,
    this.time,
    this.partySize,
  });
  factory BookingSummary.fromJson(Map<String, dynamic> j) {
    final restaurant = (j['restaurant'] as Map?)?.cast<String, dynamic>();
    return BookingSummary(
      id: j['id'] as String,
      status: bookingStatusFrom(j['status'] as String),
      summary: (j['summary'] ?? '') as String,
      updatedAt: DateTime.parse(j['updated_at'] as String).toLocal(),
      expiresAt: j['expires_at'] == null ? null : DateTime.tryParse(j['expires_at'] as String)?.toLocal(),
      result: j['result'] is Map ? BookingResult.fromJson((j['result'] as Map).cast<String, dynamic>()) : null,
      restaurantName: restaurant?['name'] as String?,
      restaurantPhone: restaurant?['phone'] as String?,
      restaurantAddress: restaurant?['address'] as String?,
      date: j['date'] as String?,
      time: j['time'] as String?,
      partySize: j['party_size'] as int?,
    );
  }
  final String id;
  final BookingStatus status;
  final String summary;
  final DateTime updatedAt;
  final DateTime? expiresAt;
  final BookingResult? result;
  final String? restaurantName;
  final String? restaurantPhone;
  final String? restaurantAddress;

  /// YYYY-MM-DD(已確認的方案優先,其次是目前的方案 / 條件)
  final String? date;

  /// HH:MM
  final String? time;
  final int? partySize;

  /// 「11/27(五) 10:30 · 2 位」;資料不齊時省略缺的部分
  String get whenText => [if (date != null) formatBookingDate(date!), ?time, if (partySize != null) '$partySize 位'].join(' · ');
}

/// 列表分組(對應後端 GET /bookings?view=)
enum BookingListView { attention, upcoming, inProgress, history }

extension BookingListViewQuery on BookingListView {
  String get query => switch (this) {
    BookingListView.attention => 'attention',
    BookingListView.upcoming => 'upcoming',
    BookingListView.inProgress => 'in_progress',
    BookingListView.history => 'history',
  };
}

class BookingPage {
  BookingPage({required this.items, this.nextBefore});
  final List<BookingSummary> items;

  /// 下一頁的游標(只有 history 有);null = 沒有更多
  final String? nextBefore;
}

const _weekdays = ['一', '二', '三', '四', '五', '六', '日'];

/// YYYY-MM-DD → 11/27(五)。用餐日期是店家所在地(台灣)的日期,不做時區換算
String formatBookingDate(String ymd) {
  final d = DateTime.tryParse(ymd);
  if (d == null) return ymd;
  return '${d.month}/${d.day}(${_weekdays[d.weekday - 1]})';
}

class BookingView extends BookingSummary {
  BookingView({
    required super.id,
    required super.status,
    required super.summary,
    required super.updatedAt,
    super.expiresAt,
    super.result,
    super.restaurantName,
    super.restaurantPhone,
    super.restaurantAddress,
    super.date,
    super.time,
    super.partySize,
    this.pending,
    this.plan,
    this.confirmedPlan,
    this.events = const [],
  });
  factory BookingView.fromJson(Map<String, dynamic> j) {
    final plan = j['plan'] is Map ? BookingPlan.fromJson((j['plan'] as Map).cast<String, dynamic>()) : null;
    final confirmed = j['confirmed_plan'] is Map ? BookingPlan.fromJson((j['confirmed_plan'] as Map).cast<String, dynamic>()) : null;
    final shown = confirmed ?? plan;
    return BookingView(
      id: j['id'] as String,
      status: bookingStatusFrom(j['status'] as String),
      summary: (j['summary'] ?? '') as String,
      updatedAt: DateTime.parse(j['updated_at'] as String).toLocal(),
      expiresAt: j['plan'] is Map && (j['plan'] as Map)['expires_at'] != null
          ? DateTime.tryParse((j['plan'] as Map)['expires_at'] as String)?.toLocal()
          : null,
      restaurantName: shown?.restaurant.name,
      restaurantPhone: shown?.restaurant.phone,
      restaurantAddress: shown?.restaurant.address,
      date: shown?.date,
      time: shown?.time,
      partySize: shown?.partySize,
      pending: j['pending'] is Map ? BookingPending.fromJson((j['pending'] as Map).cast<String, dynamic>()) : null,
      plan: plan,
      confirmedPlan: confirmed,
      result: j['result'] is Map ? BookingResult.fromJson((j['result'] as Map).cast<String, dynamic>()) : null,
      events: (j['events'] as List? ?? const []).whereType<Map>().map((x) => BookingEvent.fromJson(x.cast<String, dynamic>())).toList(),
    );
  }
  final BookingPending? pending;
  final BookingPlan? plan;
  final BookingPlan? confirmedPlan;
  final List<BookingEvent> events;
}
