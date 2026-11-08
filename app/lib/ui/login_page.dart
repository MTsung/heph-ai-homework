import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../state/app_state.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.state});

  final AppState state;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _user = TextEditingController();
  final _pass = TextEditingController();
  final _nick = TextEditingController();
  bool _register = false;
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_register) {
        await widget.state.register(_user.text.trim(), _pass.text, _nick.text.trim());
      } else {
        await widget.state.login(_user.text.trim(), _pass.text);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 因為被踢或過期而回到這個畫面時,說明原因
  Widget? _notice(AppState s) {
    final (color, icon, text) = switch (s.logoutReason) {
      LogoutReason.replacedByOtherDevice => (
          Colors.orange,
          Icons.devices_other,
          s.replacedByDevice != null ? '你的帳號已在「${s.replacedByDevice}」登入,這台裝置已登出。' : '你的帳號已在其他裝置登入,這台裝置已登出。'
        ),
      LogoutReason.expired => (Colors.blueGrey, Icons.lock_clock, '登入已過期,請重新登入。'),
      LogoutReason.none => (Colors.transparent, Icons.info, ''),
    };
    if (s.logoutReason == LogoutReason.none) return null;
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(children: [
        Icon(icon, color: color),
        const SizedBox(width: 10),
        Expanded(child: Text(text)),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final notice = _notice(widget.state);
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 400),
          child: Card(
            elevation: 0,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Chat APP', textAlign: TextAlign.center, style: TextStyle(fontSize: 34, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text('你的 AI 陪伴', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade600)),
                  const SizedBox(height: 24),
                  if (notice != null) notice,
                  TextField(
                    controller: _user,
                    autofocus: true,
                    decoration: const InputDecoration(labelText: '帳號', helperText: '3–32 個英數字或底線'),
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 12),
                  if (_register) ...[
                    TextField(controller: _nick, decoration: const InputDecoration(labelText: '暱稱(選填)')),
                    const SizedBox(height: 12),
                  ],
                  TextField(
                    controller: _pass,
                    obscureText: true,
                    decoration: const InputDecoration(labelText: '密碼', helperText: '至少 6 碼'),
                    onSubmitted: (_) => _submit(),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
                    child: _busy
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : Text(_register ? '註冊並開始' : '登入'),
                  ),
                  TextButton(
                    onPressed: () => setState(() {
                      _register = !_register;
                      _error = null;
                    }),
                    child: Text(_register ? '已有帳號?登入' : '還沒有帳號?註冊'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
