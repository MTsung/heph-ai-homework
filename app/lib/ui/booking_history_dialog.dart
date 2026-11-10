import 'package:flutter/material.dart';

import '../models/booking_models.dart';
import '../state/app_state.dart';
import 'booking_tile.dart';

/// 訂位紀錄:所有已結束的訂位(成功 / 失敗 / 結果不明 / 取消 / 過期),依結束時間新到舊、可翻頁。
/// 點一筆會關閉視窗並打開該筆的詳情。
Future<void> showBookingHistory(BuildContext context, AppState state, {String? result}) {
  return showDialog(
    context: context,
    builder: (_) => Dialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560, maxHeight: 680),
        child: _BookingHistory(state: state, initialResult: result),
      ),
    ),
  );
}

const _filters = <(String?, String)>[
  (null, '全部'),
  ('succeeded', '成功'),
  ('unknown', '結果不明'),
  ('failed', '失敗'),
  ('cancelled', '已取消'),
  ('expired', '已過期'),
];

class _BookingHistory extends StatefulWidget {
  const _BookingHistory({required this.state, this.initialResult});
  final AppState state;
  final String? initialResult;

  @override
  State<_BookingHistory> createState() => _BookingHistoryState();
}

class _BookingHistoryState extends State<_BookingHistory> {
  final List<BookingSummary> _items = [];
  late String? _result = widget.initialResult;
  bool _includeDrafts = false;
  String? _next;
  bool _loading = false;
  String? _error;
  int _generation = 0; // 換篩選時丟棄還在路上的舊回應

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    _items.clear();
    _next = null;
    await _load();
  }

  Future<void> _load() async {
    final gen = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.state.loadBookingHistory(result: _result, includeDrafts: _includeDrafts, before: _next);
      if (gen != _generation) return;
      _items.addAll(page.items);
      _next = page.nextBefore;
    } catch (_) {
      if (gen == _generation) _error = '載入失敗';
    } finally {
      if (mounted && gen == _generation) setState(() => _loading = false);
    }
  }

  void _setFilter(String? result) {
    if (_result == result) return;
    _result = result;
    _reload();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 12, 4),
          child: Row(
            children: [
              const Text('訂位紀錄', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              const Spacer(),
              IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final (value, label) in _filters)
                ChoiceChip(label: Text(label), selected: _result == value, onSelected: (_) => _setFilter(value)),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 20, 0),
          child: CheckboxListTile(
            value: _includeDrafts,
            dense: true,
            controlAffinity: ListTileControlAffinity.leading,
            contentPadding: EdgeInsets.zero,
            title: Text('包含沒確認就取消 / 過期的草稿', style: TextStyle(fontSize: 13, color: Colors.grey.shade700)),
            onChanged: (v) {
              _includeDrafts = v ?? false;
              _reload();
            },
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: _items.isEmpty && _loading
              ? const Center(child: CircularProgressIndicator())
              : _items.isEmpty
              ? Center(child: Text(_error ?? '沒有符合的訂位'))
              : ListView.builder(
                  itemCount: _items.length + (_next != null || _error != null ? 1 : 0),
                  itemBuilder: (_, i) {
                    if (i < _items.length) {
                      final b = _items[i];
                      return BookingTile(
                        booking: b,
                        onTap: () {
                          Navigator.pop(context);
                          widget.state.openBooking(b.id);
                        },
                      );
                    }
                    return Padding(
                      padding: const EdgeInsets.all(12),
                      child: Center(
                        child: _loading
                            ? const CircularProgressIndicator()
                            : TextButton(onPressed: _load, child: Text(_error == null ? '載入更多' : '$_error,重試')),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }
}
