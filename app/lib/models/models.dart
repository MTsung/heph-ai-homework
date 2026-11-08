class Character {
  Character({
    required this.id,
    required this.slug,
    required this.name,
    required this.tagline,
    required this.avatar,
    required this.greeting,
    required this.price,
  });

  factory Character.fromJson(Map<String, dynamic> j) => Character(
        id: j['id'] as String,
        slug: j['slug'] as String,
        name: j['name'] as String,
        tagline: (j['tagline'] ?? '') as String,
        avatar: (j['avatar'] ?? '🙂') as String,
        greeting: (j['greeting'] ?? '') as String,
        price: (j['price'] ?? 0) as int,
      );

  final String id;
  final String slug;
  final String name;
  final String tagline;
  final String avatar;
  final String greeting;
  final int price;
}

class ConversationSummary {
  ConversationSummary({
    required this.id,
    required this.characterId,
    required this.lastPreview,
    required this.lastMessageAt,
    required this.latestSeq,
  });

  factory ConversationSummary.fromJson(Map<String, dynamic> j) => ConversationSummary(
        id: j['id'] as String,
        characterId: j['character_id'] as String,
        lastPreview: (j['last_preview'] ?? '') as String,
        lastMessageAt: DateTime.parse(j['last_message_at'] as String).toLocal(),
        latestSeq: (j['latest_seq'] ?? 0) as int,
      );

  final String id;
  final String characterId;
  final String lastPreview;
  final DateTime lastMessageAt;
  final int latestSeq;
}

enum MessageStatus { completed, streaming, failed, sending }

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.seq,
    required this.role,
    required this.content,
    required this.status,
    required this.createdAt,
    this.clientMsgId,
    this.errorCode,
    this.errorText,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: j['id'] as String,
        seq: j['seq'] as int,
        role: j['role'] as String,
        content: (j['content'] ?? '') as String,
        status: _status(j['status'] as String),
        createdAt: DateTime.parse(j['created_at'] as String).toLocal(),
        clientMsgId: j['client_msg_id'] as String?,
        errorCode: j['error_code'] as String?,
      );

  static MessageStatus _status(String s) => switch (s) {
        'streaming' => MessageStatus.streaming,
        'failed' => MessageStatus.failed,
        _ => MessageStatus.completed,
      };

  final String id;

  /// 對話內嚴格遞增、無空洞的序號;排序與去重都以它為準(尚未有伺服器序號的本地訊息為 -1)
  int seq;
  final String role;
  String content;
  MessageStatus status;
  final DateTime createdAt;
  String? clientMsgId;
  String? errorCode;
  String? errorText;

  bool get isUser => role == 'user';

  /// 失敗時顯示給使用者的文字。
  /// 即時串流時伺服器會附上 message(errorText);但從歷史重新載入時 API 只有 error_code,
  /// 所以以 error_code 為準做對應,即時與歷史兩條路徑看到的訊息才會一致。
  String get failureText => switch (errorCode) {
        'LLM_UNAVAILABLE' => '目前系統有問題,請稍後再試',
        'LLM_BLOCKED' => '這則訊息我沒辦法回應,換個說法試試吧',
        'LLM_RATE_LIMITED' => '目前使用的人太多,請稍後再試',
        'FIRST_TOKEN_TIMEOUT' || 'GENERATION_TIMEOUT' => '回覆逾時,請重試',
        _ => errorText ?? '回覆中斷,請重試',
      };

  /// 重試同樣的內容仍會失敗的錯誤(內容被模型的安全機制擋下),不顯示重試按鈕
  bool get canRetry => errorCode != 'LLM_BLOCKED';
}

class LedgerEntry {
  LedgerEntry({
    required this.id,
    required this.type,
    required this.amount,
    required this.balanceAfter,
    required this.note,
    required this.createdAt,
  });

  factory LedgerEntry.fromJson(Map<String, dynamic> j) => LedgerEntry(
        id: j['id'] as int,
        type: j['type'] as String,
        amount: j['amount'] as int,
        balanceAfter: j['balance_after'] as int,
        note: (j['note'] ?? '') as String,
        createdAt: DateTime.parse(j['created_at'] as String).toLocal(),
      );

  final int id;
  final String type;
  final int amount;
  final int balanceAfter;
  final String note;
  final DateTime createdAt;
}

class Balance {
  const Balance({required this.balance, required this.held, required this.available});

  factory Balance.fromJson(Map<String, dynamic> j) =>
      Balance(balance: j['balance'] as int, held: j['held'] as int, available: j['available'] as int);

  final int balance;
  final int held;
  final int available;
}
