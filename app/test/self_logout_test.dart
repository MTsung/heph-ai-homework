@TestOn('mac-os')
library;

import 'package:chat_app/api/api_client.dart';
import 'package:chat_app/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 回歸測試:使用者「自己」按登出時,不應該被當成「被其他裝置踢掉」。
/// 伺服器登出時會對自己的事件通道也推送 session_replaced(reason: revoked)。
const base = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:8080');

void main() {
  test('自己登出:logoutReason 必須維持 none,不顯示「已在其他裝置登入」', () async {
    SharedPreferences.setMockInitialValues({});
    final api = ApiClient(baseUrl: base);
    try {
      await api.get('/characters');
    } on ApiException catch (e) {
      if (e.status != 401) return markTestSkipped('後端未啟動');
    } catch (_) {
      return markTestSkipped('後端未啟動');
    }

    final state = AppState(api: api, prefs: await SharedPreferences.getInstance());
    final name = 'lo_${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}';
    await state.register(name, 'secret123', '');
    expect(state.loggedIn, isTrue);
    await Future<void>.delayed(const Duration(milliseconds: 300)); // 讓事件通道連上

    await state.logout();
    await Future<void>.delayed(const Duration(milliseconds: 500)); // 留時間給遲到的事件

    expect(state.loggedIn, isFalse);
    expect(state.logoutReason, LogoutReason.none, reason: '自己登出不是被踢');
    expect(state.replacedByDevice, isNull);
  });
}
