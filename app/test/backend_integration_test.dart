@TestOn('mac-os')
library;

import 'dart:async';
import 'dart:io';

import 'package:chat_app/api/api_client.dart';
import 'package:chat_app/models/models.dart';
import 'package:chat_app/state/chat_controller.dart';
import 'package:flutter_test/flutter_test.dart';

/// 整合測試:用 App 真正使用的 ApiClient 與 ChatController 打真實後端。
/// 需要先 `docker compose up -d`。若後端不可用,整組測試自動略過。
///   flutter test test/backend_integration_test.dart
const base = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:8080');

Future<bool> backendUp() async {
  try {
    final c = ApiClient(baseUrl: base);
    await c.get('/characters'); // 沒帶 token 會 401,但代表服務有回應
  } on ApiException catch (e) {
    return e.status == 401;
  } catch (_) {
    return false;
  }
  return true;
}

Future<void> until(bool Function() cond, {Duration timeout = const Duration(seconds: 15), String? what}) async {
  final end = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(end)) fail('逾時未達成:${what ?? ''}');
    await Future<void>.delayed(const Duration(milliseconds: 25));
  }
}

void main() {
  late bool up;
  setUpAll(() async => up = await backendUp());

  Future<(ApiClient, Character, String)> newUser({String device = 'TestMac'}) async {
    final api = ApiClient(baseUrl: base);
    final name = 'ft_${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}';
    final res = await api.post('/auth/register', {'username': name, 'password': 'secret123', 'device_id': 'test-$name', 'device_name': device});
    api.token = res['token'] as String;
    final chars = ((await api.get('/characters'))['items'] as List).map((e) => Character.fromJson((e as Map).cast())).toList();
    return (api, chars.first, name);
  }

  Future<ChatController> openChat(ApiClient api, Character c, {List<int>? balances}) async {
    final conv = await api.post('/conversations', {'character_id': c.id});
    final ctl = ChatController(api: api, conversationId: conv['id'] as String, onBalance: (b) => balances?.add(b), onPreview: (_) {});
    await ctl.load();
    return ctl;
  }

  test('載入對話:有開場白;送出訊息後逐步收到串流並完成,餘額正確', () async {
    if (!up) return markTestSkipped('後端未啟動');
    final (api, ch, _) = await newUser();
    final balances = <int>[];
    final ctl = await openChat(api, ch, balances: balances);

    expect(ctl.messages, hasLength(1));
    expect(ctl.messages.first.seq, 1);
    expect(ctl.messages.first.content, ch.greeting);

    // 記錄 AI 泡泡內容長度的變化,證明是「逐步長出來」而不是一次出現
    final lengths = <int>[];
    ctl.addListener(() {
      final ai = ctl.messages.where((m) => !m.isUser && m.status == MessageStatus.streaming).lastOrNull;
      if (ai != null && (lengths.isEmpty || lengths.last != ai.content.length)) lengths.add(ai.content.length);
    });

    await ctl.send('你好');
    await until(() => !ctl.busy, what: '回覆完成');

    expect(ctl.messages.map((m) => m.seq).toList(), [1, 2, 3]);
    expect(ctl.messages.last.status, MessageStatus.completed);
    expect(ctl.messages.last.content, isNotEmpty);
    expect(lengths.length, greaterThan(3), reason: '應該是多次逐步增加,實際:$lengths');
    expect(lengths, orderedEquals([...lengths]..sort()), reason: '長度只會增加');
    expect(balances, [200 - ch.price]);
    ctl.dispose();
  });

  test('重新開啟對話(模擬另一台裝置 / 重啟 App)看到同一份完整紀錄', () async {
    if (!up) return markTestSkipped('後端未啟動');
    final (api, ch, _) = await newUser();
    final a = await openChat(api, ch);
    await a.send('第一則');
    await until(() => !a.busy);
    final expected = a.messages.map((m) => '${m.seq}:${m.content}').toList();
    a.dispose();

    final b = await openChat(api, ch);
    expect(b.messages.map((m) => '${m.seq}:${m.content}').toList(), expected);
    b.dispose();
  });

  test('往上滑載入更早訊息:keyset 分頁不重複、不遺漏、順序正確', () async {
    if (!up) return markTestSkipped('後端未啟動');
    final (api, ch, _) = await newUser();
    final ctl = await openChat(api, ch);
    // 製造 > 30 則的歷史(每次互動 2 則)。用較短的 mock 延遲不可控,所以循序送 16 次
    for (var i = 0; i < 16; i++) {
      await ctl.send('訊息 $i');
      await until(() => !ctl.busy, timeout: const Duration(seconds: 20));
    }
    expect(ctl.messages.length, 33); // 開場白 + 16 × 2
    ctl.dispose();

    // 新的 controller 只載最新 30 則,再往上滑補齊
    final fresh = await openChat(api, ch);
    expect(fresh.messages.length, 30);
    expect(fresh.hasMoreOlder, isTrue);
    await fresh.loadOlder();
    final seqs = fresh.messages.map((m) => m.seq).toList();
    expect(seqs, List.generate(33, (i) => i + 1), reason: '應為連續的 1..33,無重複、無遺漏');
    expect(fresh.hasMoreOlder, isFalse);
    fresh.dispose();
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('點數不足:送不出去、沒有留下殘影、文字可還給輸入框', () async {
    if (!up) return markTestSkipped('後端未啟動');
    final (api, ch, _) = await newUser();
    final ctl = await openChat(api, ch);
    // 直接用 billing 的內部 API 預扣掉幾乎全部可用點數(billing 的埠沒有對外開放,透過 docker exec 呼叫)。
    // 比起真的聊 100 則,這樣快而且穩定。
    final me = await api.get('/me');
    final bal = Balance.fromJson(await api.get('/points/balance'));
    final burn = bal.available - (ch.price - 1); // 只留比單價少 1 點
    final r = await Process.run('docker', [
      'compose',
      'exec',
      '-T',
      'billing',
      'wget',
      '-qO-',
      '--header=content-type: application/json',
      '--header=x-internal-token: dev-internal-token-change-me',
      '--post-data={"ref":"it-${DateTime.now().microsecondsSinceEpoch}","user_id":"${me['id']}","amount":$burn}',
      'http://127.0.0.1:3004/internal/holds',
    ], workingDirectory: '..');
    expect(r.exitCode, 0, reason: '預扣失敗:${r.stderr}');

    final before = ctl.messages.length;
    await ctl.send('還能聊嗎');
    await until(() => ctl.sendError != null, what: '收到點數不足');
    expect(ctl.insufficientPoints, isTrue);
    expect(ctl.messages.length, before, reason: '樂觀顯示的訊息必須被移除');
    expect(ctl.busy, isFalse);
    ctl.dispose();
  });

  test('模型中途出錯 → 標示失敗 → 用同一個 client_msg_id 重試,歷史不留殘骸', () async {
    if (!up) return markTestSkipped('後端未啟動');
    final (api, ch, _) = await newUser();
    final ctl = await openChat(api, ch);
    await ctl.send('測試 [[fail]]');
    await until(() => !ctl.busy, what: '失敗結束');
    final failed = ctl.messages.last;
    expect(failed.status, MessageStatus.failed);
    expect(ctl.messages.length, 3);

    final cmid = ctl.messages.firstWhere((m) => m.isUser).clientMsgId;
    expect(cmid, isNotNull);
    await ctl.retryLast();
    await until(() => !ctl.busy, what: '重試結束');
    expect(ctl.messages.length, 3, reason: '重試沿用同一則,不新增');
    expect(ctl.messages.last.id, failed.id, reason: '同一則 AI 訊息被重新生成');
    ctl.dispose();

    final bal = Balance.fromJson(await api.get('/points/balance'));
    expect(bal.balance, 200, reason: '兩次都失敗,一點都沒扣');
    expect(bal.held, 0);
  });

  test('切換對話(中斷收看)後,回覆在伺服器端照常完成;回來時用續傳取回', () async {
    if (!up) return markTestSkipped('後端未啟動');
    final (api, ch, _) = await newUser();
    final a = await openChat(api, ch);
    await a.send('慢慢說 [[slow]]');
    await until(() => a.messages.any((m) => !m.isUser && m.content.isNotEmpty), what: '收到第一個片段');
    final aiId = a.messages.last.id;
    a.dispose(); // 模擬切換到別的對話 / 關掉視窗

    // 回覆還在生成時重新打開:應該看到進行中的訊息並自動續傳
    final b = await openChat(api, ch);
    final inflight = b.messages.where((m) => m.id == aiId).firstOrNull;
    expect(inflight, isNotNull);
    await until(() => !b.busy, timeout: const Duration(seconds: 30), what: '續傳後完成');
    final done = b.messages.firstWhere((m) => m.id == aiId);
    expect(done.status, MessageStatus.completed);
    expect(done.content, isNotEmpty);
    b.dispose();

    // 再開一次(純歷史)內容一致
    final c = await openChat(api, ch);
    expect(c.messages.firstWhere((m) => m.id == aiId).content, done.content);
    c.dispose();
    final bal = Balance.fromJson(await api.get('/points/balance'));
    expect(bal.balance, 200 - ch.price, reason: '只扣一次');
  }, timeout: const Timeout(Duration(minutes: 1)));

  test('單一裝置:另一台登入後,舊裝置請求被拒絕且回報 SESSION_REPLACED', () async {
    if (!up) return markTestSkipped('後端未啟動');
    final (apiA, _, name) = await newUser(device: 'MacBook');
    ApiException? seen;
    apiA.onAuthFailure = (e) => seen = e;
    await apiA.get('/characters'); // 目前可用

    final apiB = ApiClient(baseUrl: base);
    final r = await apiB.post('/auth/login', {'username': name, 'password': 'secret123', 'device_id': 'ipad', 'device_name': 'iPad'});
    apiB.token = r['token'] as String;
    expect(r['replaced_device'], 'MacBook');

    await expectLater(apiA.get('/characters'), throwsA(isA<ApiException>().having((e) => e.isSessionReplaced, 'isSessionReplaced', true)));
    expect(seen?.isSessionReplaced, isTrue, reason: 'onAuthFailure 會被觸發,App 據此回到登入畫面');
    await apiB.get('/characters'); // 新裝置正常
  });

  test('事件通道:另一台登入時,舊裝置立刻收到 session_replaced(不用等下一次操作)', () async {
    if (!up) return markTestSkipped('後端未啟動');
    final (apiA, _, name) = await newUser(device: 'MacBook');
    final events = <String>[];
    final sub = apiA.sse('GET', '/events').listen((e) => events.add(e.event));
    await until(() => events.contains('ready'), what: '事件通道連上');

    final apiB = ApiClient(baseUrl: base);
    await apiB.post('/auth/login', {'username': name, 'password': 'secret123', 'device_id': 'x', 'device_name': 'iPad'});
    await until(() => events.contains('session_replaced'), timeout: const Duration(seconds: 3), what: '立即收到踢出通知');
    await sub.cancel();
  });
}
