import 'package:chat_app/api/api_client.dart';
import 'package:chat_app/models/models.dart';
import 'package:chat_app/state/app_state.dart';
import 'package:chat_app/state/chat_controller.dart';
import 'package:chat_app/ui/chat_view.dart';
import 'package:chat_app/ui/login_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Widget 測試:不需要後端,驗證畫面在各種狀態下能正確建構、沒有版面溢出。
/// (Flutter 的 RenderFlex overflow 會在測試中以例外形式出現。)
void main() {
  Future<AppState> makeState() async {
    SharedPreferences.setMockInitialValues({});
    return AppState(
      api: ApiClient(baseUrl: 'http://localhost:0'),
      prefs: await SharedPreferences.getInstance(),
    );
  }

  Future<void> pumpAtDesktop(WidgetTester t, Widget w) async {
    t.view.physicalSize = const Size(1100, 760);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(MaterialApp(home: w));
    await t.pump();
  }

  testWidgets('登入畫面:預設是登入模式,可切換成註冊', (t) async {
    final s = await makeState();
    await pumpAtDesktop(t, LoginPage(state: s));
    expect(find.text('登入'), findsWidgets);
    expect(find.text('暱稱(選填)'), findsNothing);
    await t.tap(find.text('還沒有帳號?註冊'));
    await t.pump();
    expect(find.text('暱稱(選填)'), findsOneWidget);
    expect(find.text('註冊並開始'), findsOneWidget);
  });

  testWidgets('被其他裝置踢出後,登入畫面顯示原因與裝置名稱', (t) async {
    final s = await makeState();
    s.logoutReason = LogoutReason.replacedByOtherDevice;
    s.replacedByDevice = 'iPad';
    await pumpAtDesktop(t, LoginPage(state: s));
    expect(find.textContaining('已在「iPad」登入'), findsOneWidget);
  });

  testWidgets('登入過期顯示對應提示', (t) async {
    final s = await makeState();
    s.logoutReason = LogoutReason.expired;
    await pumpAtDesktop(t, LoginPage(state: s));
    expect(find.textContaining('登入已過期'), findsOneWidget);
  });

  final character = Character(id: 'c1', slug: 'xi', name: '小曦', tagline: '溫柔的傾聽者', avatar: '🌅', greeting: '嗨', price: 2);

  ChatController controllerWith(List<ChatMessage> msgs) {
    final c = ChatController(
      api: ApiClient(baseUrl: 'http://localhost:0'),
      conversationId: 'conv',
      onBalance: (_) {},
      onPreview: (_) {},
    );
    c.messages.addAll(msgs);
    c.loading = false;
    return c;
  }

  ChatMessage msg(int seq, String role, String text, {MessageStatus status = MessageStatus.completed}) =>
      ChatMessage(id: 'm$seq', seq: seq, role: role, content: text, status: status, createdAt: DateTime(2026, 11, 7, 12, seq));

  testWidgets('聊天畫面:依 seq 排序顯示,AI 回覆中顯示游標,輸入框停用送出', (t) async {
    final c = controllerWith([msg(1, 'assistant', '嗨,我是小曦'), msg(2, 'user', '今天好累'), msg(3, 'assistant', '聽起來你', status: MessageStatus.streaming)]);
    await pumpAtDesktop(
      t,
      Scaffold(
        body: ChatView(character: character, controller: c),
      ),
    );
    expect(find.textContaining('今天好累'), findsOneWidget);
    expect(find.textContaining('▍', findRichText: true), findsOneWidget, reason: '串流中應有閃爍游標');
    expect(find.text('AI 回覆中…'), findsOneWidget);
    expect(t.takeException(), isNull);
  });

  testWidgets('失敗的回覆顯示重試按鈕,點數不足提示顯示在輸入框上方', (t) async {
    final c = controllerWith([
      msg(1, 'assistant', '嗨'),
      msg(2, 'user', '你好'),
      msg(3, 'assistant', '半截的回', status: MessageStatus.failed)..errorText = '回覆中斷',
    ]);
    c.sendError = '點數不足,無法繼續對話';
    c.insufficientPoints = true;
    await pumpAtDesktop(
      t,
      Scaffold(
        body: ChatView(character: character, controller: c),
      ),
    );
    expect(find.textContaining('重試'), findsOneWidget);
    expect(find.text('點數不足,無法繼續對話'), findsOneWidget);
    expect(t.takeException(), isNull);
  });

  testWidgets('所有模型都壞掉:歷史載入的失敗訊息也顯示「目前系統有問題」(不是通用的回覆中斷),且可重試', (t) async {
    // 模擬從歷史重新載入:只有 error_code,沒有即時事件才有的 errorText
    final c = controllerWith([
      msg(1, 'assistant', '嗨'),
      msg(2, 'user', '你好'),
      msg(3, 'assistant', '', status: MessageStatus.failed)..errorCode = 'LLM_UNAVAILABLE',
    ]);
    await pumpAtDesktop(
      t,
      Scaffold(
        body: ChatView(character: character, controller: c),
      ),
    );
    expect(find.text('目前系統有問題,請稍後再試'), findsOneWidget);
    expect(find.textContaining('重試'), findsOneWidget);
  });

  testWidgets('內容被安全機制擋下:顯示說明,且不提供重試(重試同樣內容仍會被擋)', (t) async {
    final c = controllerWith([
      msg(1, 'assistant', '嗨'),
      msg(2, 'user', '某則會被擋的內容'),
      msg(3, 'assistant', '', status: MessageStatus.failed)..errorCode = 'LLM_BLOCKED',
    ]);
    await pumpAtDesktop(
      t,
      Scaffold(
        body: ChatView(character: character, controller: c),
      ),
    );
    expect(find.textContaining('沒辦法回應'), findsOneWidget);
    expect(find.textContaining('重試'), findsNothing);
  });

  testWidgets('輸入法選字中按 Enter 不會送出;選字結束後才會送出', (t) async {
    final c = controllerWith([msg(1, 'assistant', '嗨')]);
    var sent = 0;
    final spy = _SpyController(c, () => sent++);
    await pumpAtDesktop(
      t,
      Scaffold(
        body: ChatView(character: character, controller: spy),
      ),
    );

    final field = find.byType(TextField);
    await t.tap(field);
    // 模擬注音/拼音輸入法:文字「ㄋ」尚在組字(composing 範圍有效)
    final tf = t.widget<TextField>(field);
    tf.controller!.value = const TextEditingValue(text: '你好ㄋ', selection: TextSelection.collapsed(offset: 3), composing: TextRange(start: 2, end: 3));
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(sent, 0, reason: '選字中的 Enter 是確認選字,不該送出');

    // 選字完成(composing 清除)後再按 Enter → 送出
    tf.controller!.value = const TextEditingValue(text: '你好嗎', selection: TextSelection.collapsed(offset: 3));
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(sent, 1);
  });

  testWidgets('輸入框接近字數上限時才顯示計數', (t) async {
    final c = controllerWith([msg(1, 'assistant', '嗨')]);
    await pumpAtDesktop(
      t,
      Scaffold(
        body: ChatView(character: character, controller: c),
      ),
    );
    expect(find.textContaining('/ $kMaxMessageChars'), findsNothing);
    await t.enterText(find.byType(TextField), 'a' * (kMaxMessageChars * 8 ~/ 10));
    await t.pump();
    expect(find.text('${kMaxMessageChars * 8 ~/ 10} / $kMaxMessageChars'), findsOneWidget);
  });

  testWidgets('長訊息與大量訊息不會造成版面溢出', (t) async {
    final long = '很長的一段話,' * 80;
    final c = controllerWith([for (var i = 1; i <= 60; i++) msg(i, i.isOdd ? 'assistant' : 'user', i % 7 == 0 ? long : '訊息 $i')]);
    await pumpAtDesktop(
      t,
      Scaffold(
        body: ChatView(character: character, controller: c),
      ),
    );
    expect(t.takeException(), isNull);
  });
}

/// 記錄 send() 被呼叫次數的 ChatController(不真的打網路)
class _SpyController extends ChatController {
  _SpyController(ChatController base, this.onSendCalled)
    : super(api: base.api, conversationId: base.conversationId, onBalance: (_) {}, onPreview: (_) {}) {
    messages.addAll(base.messages);
    loading = false;
  }

  final void Function() onSendCalled;

  @override
  Future<void> send(String text, {String? clientMsgId}) async => onSendCalled();
}
