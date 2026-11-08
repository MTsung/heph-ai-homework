import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api/api_client.dart';
import 'state/app_state.dart';
import 'ui/home_page.dart';
import 'ui/login_page.dart';

/// 後端 gateway 位址。可在執行時覆寫:
///   flutter run -d macos --dart-define=API_BASE_URL=http://192.168.1.10:8080
const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:8080');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final state = AppState(
    api: ApiClient(baseUrl: apiBaseUrl),
    prefs: prefs,
  );
  runApp(ChatApp(state: state));
  state.bootstrap();
}

class ChatApp extends StatelessWidget {
  const ChatApp({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    const brand = Color(0xFF6D4AFF);
    return MaterialApp(
      title: 'Chat APP',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: brand, brightness: Brightness.light),
        fontFamilyFallback: const ['PingFang TC', 'Noto Sans TC'],
        scaffoldBackgroundColor: const Color(0xFFF7F7FB),
        inputDecorationTheme: InputDecorationTheme(
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
          filled: true,
          fillColor: Colors.white,
        ),
      ),
      home: ListenableBuilder(
        listenable: state,
        builder: (context, _) {
          if (state.bootstrapping) {
            return const Scaffold(body: Center(child: CircularProgressIndicator()));
          }
          return state.loggedIn ? HomePage(state: state) : LoginPage(state: state);
        },
      ),
    );
  }
}
