import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/booking_models.dart';
import '../state/booking_controller.dart';

class BookingFlowView extends StatefulWidget {
  const BookingFlowView({super.key, required this.controller, required this.onBack});
  final BookingController controller;
  final VoidCallback onBack;

  @override
  State<BookingFlowView> createState() => _BookingViewState();
}

class _BookingViewState extends State<BookingFlowView> with WidgetsBindingObserver {
  final _text = TextEditingController();
  final _scroll = ScrollController();

  BookingController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _text.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) c.refresh();
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  Future<void> _send() async {
    final text = _text.text.trim();
    if (text.isEmpty || c.busy) return;
    _text.clear();
    await c.message(text);
    if (c.error != null && _text.text.isEmpty) _text.text = text;
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final b = c.booking;
        if (c.waiting) _scrollToEnd();
        return Column(
          children: [
            Container(
              color: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
              child: Row(
                children: [
                  IconButton(tooltip: '回到聊天', onPressed: widget.onBack, icon: const Icon(Icons.arrow_back)),
                  const SizedBox(width: 8),
                  const Icon(Icons.restaurant_menu, color: Color(0xFF6D4AFF)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('AI 訂位代辦', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                        Text(b.status.text, style: TextStyle(fontSize: 12, color: _statusColor(b.status))),
                      ],
                    ),
                  ),
                  IconButton(tooltip: '重新整理', onPressed: c.busy ? null : c.refresh, icon: const Icon(Icons.refresh)),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: ListView(
                controller: _scroll,
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                children: [
                  _StatusCard(booking: b),
                  const SizedBox(height: 12),
                  for (final event in b.events) _EventRow(event: event),
                  if (c.waiting) const _TypingBubble() else if (b.pending != null) ...[const SizedBox(height: 12), _PendingCard(controller: c)],
                ],
              ),
            ),
            if (c.error != null) _Error(text: c.error!),
            if (c.canCancel)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 4, 24, 0),
                child: Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(onPressed: c.busy ? null : c.cancel, icon: const Icon(Icons.close, size: 16), label: const Text('取消這筆訂位')),
                ),
              ),
            // 已結束的訂位只能查看,不能再修改條件
            if (b.status.active)
              _Composer(controller: _text, busy: c.busy || c.running, onSend: _send)
            else
              Container(
                width: double.infinity,
                color: Colors.white,
                padding: const EdgeInsets.fromLTRB(24, 14, 24, 18),
                child: Text('這筆訂位已結束,只能查看。要再訂一次請在聊天中說「幫我訂…」。', style: TextStyle(color: Colors.grey.shade600)),
              ),
          ],
        );
      },
    );
  }
}

Color _statusColor(BookingStatus s) => switch (s) {
  BookingStatus.succeeded => Colors.green.shade700,
  BookingStatus.failed || BookingStatus.unknown || BookingStatus.expired => Colors.red.shade700,
  BookingStatus.executing || BookingStatus.confirmed => Colors.orange.shade800,
  _ => Colors.grey.shade600,
};

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.booking});
  final BookingView booking;
  @override
  Widget build(BuildContext context) {
    final r = booking.result;
    final plan = booking.confirmedPlan ?? booking.plan;
    // 已送出過(成功 / 結果不明 / 失敗):顯示到店或打電話確認時需要的資訊
    if (booking.confirmedPlan != null && !booking.status.active) return _ResultCard(booking: booking, plan: booking.confirmedPlan!);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(booking.summary.isEmpty ? '正在整理訂位需求' : booking.summary, style: const TextStyle(fontWeight: FontWeight.w700)),
            if (plan != null) ...[
              const SizedBox(height: 8),
              Text('${plan.restaurant.name} · ${formatBookingDate(plan.date)} ${plan.time} · ${plan.partySize} 位'),
            ],
            if (booking.status == BookingStatus.executing || booking.status == BookingStatus.confirmed) ...[
              const SizedBox(height: 8),
              const Row(
                children: [
                  SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  SizedBox(width: 8),
                  Text('瀏覽器正在操作訂位網站…'),
                ],
              ),
            ],
            if (r?.ok == true) ...[
              const SizedBox(height: 8),
              Text(
                '訂位成功，代號 ${r!.confirmationNo}',
                style: TextStyle(color: Colors.green.shade700, fontWeight: FontWeight.w700),
              ),
            ],
            if (r?.ok == false) ...[const SizedBox(height: 8), Text(r!.message ?? r.code ?? '沒有訂成', style: TextStyle(color: Colors.red.shade700))],
          ],
        ),
      ),
    );
  }
}

/// 已送出訂位的結果卡:訂位編號、時間人數、店家聯絡方式、用哪個姓名 / 電話訂的
class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.booking, required this.plan});
  final BookingView booking;
  final BookingPlan plan;

  @override
  Widget build(BuildContext context) {
    final r = booking.result;
    final (Color color, IconData icon, String headline) = switch (booking.status) {
      BookingStatus.succeeded => (Colors.green.shade700, Icons.event_available, '訂位成功'),
      BookingStatus.unknown => (Colors.red.shade700, Icons.help_outline, '結果不明'),
      BookingStatus.failed => (Colors.red.shade700, Icons.event_busy, '沒有訂成'),
      _ => (Colors.grey.shade700, Icons.info_outline, booking.status.text),
    };
    final rs = plan.restaurant;
    final contact = [plan.contact['name'], plan.contact['phone'], plan.contact['email']].whereType<String>().where((v) => v.isNotEmpty).join(' / ');
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, color: color),
                const SizedBox(width: 8),
                Text(
                  headline,
                  style: TextStyle(color: color, fontWeight: FontWeight.w800, fontSize: 16),
                ),
              ],
            ),
            if (booking.status == BookingStatus.succeeded && r?.confirmationNo != null) ...[
              const SizedBox(height: 10),
              _Line(label: '訂位編號', value: r!.confirmationNo!, copyable: true),
            ],
            if (booking.status == BookingStatus.unknown) ...[
              const SizedBox(height: 8),
              Text(
                rs.phone == null ? '系統沒能確認有沒有訂成,請直接聯絡店家確認。為避免重複訂位,系統不會自動重送。' : '系統沒能確認有沒有訂成,請撥 ${rs.phone} 向店家確認。為避免重複訂位,系統不會自動重送。',
                style: TextStyle(color: Colors.red.shade700, height: 1.4),
              ),
            ],
            if (booking.status == BookingStatus.failed && r?.message != null) ...[
              const SizedBox(height: 8),
              Text(r!.message!, style: TextStyle(color: Colors.red.shade700, height: 1.4)),
            ],
            const SizedBox(height: 10),
            _Line(label: '餐廳', value: rs.name),
            _Line(label: '時間', value: '${formatBookingDate(plan.date)} ${plan.time} · ${plan.partySize} 位'),
            if (rs.address.isNotEmpty) _Line(label: '地址', value: rs.address),
            if (rs.phone != null) _Line(label: '店家電話', value: rs.phone!, copyable: true),
            if (contact.isNotEmpty) _Line(label: '訂位人', value: contact),
            for (final e in plan.extra.entries) _Line(label: _extraLabel(e.key), value: e.value),
            if (plan.notes != null && plan.notes!.isNotEmpty) _Line(label: '備註', value: plan.notes!),
          ],
        ),
      ),
    );
  }
}

String _extraLabel(String key) => switch (key) {
  'title' => '稱謂',
  'purpose' => '用餐目的',
  'seat_pref' => '座位偏好',
  _ => key,
};

class _Line extends StatelessWidget {
  const _Line({required this.label, required this.value, this.copyable = false});
  final String label;
  final String value;
  final bool copyable;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 72,
          child: Text(label, style: TextStyle(color: Colors.grey.shade600, height: 1.6)),
        ),
        Expanded(child: SelectableText(value, style: const TextStyle(height: 1.6))),
        if (copyable)
          IconButton(
            tooltip: '複製',
            visualDensity: VisualDensity.compact,
            iconSize: 16,
            onPressed: () {
              Clipboard.setData(ClipboardData(text: value));
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已複製$label')));
            },
            icon: const Icon(Icons.copy),
          ),
      ],
    ),
  );
}

class _EventRow extends StatelessWidget {
  const _EventRow({required this.event});
  final BookingEvent event;
  @override
  Widget build(BuildContext context) {
    final user = event.type == 'user';
    final status = event.type == 'status';
    if (status)
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: Text(event.text, style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
        ),
      );
    return Align(
      alignment: user ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 540),
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: user ? const Color(0xFF6D4AFF) : Colors.white,
          borderRadius: BorderRadius.circular(14),
          border: user ? null : Border.all(color: const Color(0xFFE4E7EC)),
        ),
        child: Text(event.text, style: TextStyle(color: user ? Colors.white : null, height: 1.45)),
      ),
    );
  }
}

/// 後端處理中的提示氣泡(轉圈 + 文字),避免使用者以為沒反應
class _TypingBubble extends StatelessWidget {
  const _TypingBubble();
  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerLeft,
    child: Container(
      margin: const EdgeInsets.symmetric(vertical: 5),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFE4E7EC)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
          const SizedBox(width: 10),
          Text('處理中，請稍候…', style: TextStyle(color: Colors.grey.shade700)),
        ],
      ),
    ),
  );
}

class _PendingCard extends StatelessWidget {
  const _PendingCard({required this.controller});
  final BookingController controller;
  @override
  Widget build(BuildContext context) {
    final p = controller.booking.pending!;
    return Card(
      margin: EdgeInsets.zero,
      color: const Color(0xFFFFFBFE),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: switch (p.kind) {
          'choose_restaurant' => _RestaurantChoices(controller: controller, items: p.restaurants),
          'choose_time' => _TimeChoices(controller: controller, times: p.times),
          'provide_slots' => _SlotsForm(controller: controller, fields: p.fields.map((f) => f.key).toList()),
          'provide_info' => _InfoForm(controller: controller, fields: p.fields),
          'confirm_plan' => _ConfirmPlan(controller: controller),
          _ => const Text('請直接在下方輸入餐廳名稱，或告訴我地區、料理、日期、時間與人數。'),
        },
      ),
    );
  }
}

class _RestaurantChoices extends StatelessWidget {
  const _RestaurantChoices({required this.controller, required this.items});
  final BookingController controller;
  final List<BookingRestaurant> items;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text('選擇餐廳', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      for (final r in items)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: OutlinedButton(
            onPressed: controller.busy ? null : () => controller.chooseRestaurant(r.id),
            style: OutlinedButton.styleFrom(alignment: Alignment.centerLeft, padding: const EdgeInsets.all(12)),
            child: Row(
              children: [
                const Icon(Icons.storefront_outlined),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(r.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                      Text(
                        [r.cuisine, r.district, r.address, r.rating == null ? null : '★ ${r.rating}'].whereType<String>().join(' · '),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right),
              ],
            ),
          ),
        ),
    ],
  );
}

class _TimeChoices extends StatelessWidget {
  const _TimeChoices({required this.controller, required this.times});
  final BookingController controller;
  final List<String> times;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text('選擇可訂時段', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final time in times) OutlinedButton(onPressed: controller.busy ? null : () => controller.chooseTime(time), child: Text(time)),
        ],
      ),
    ],
  );
}

/// 補齊訂位條件:後端一次只問一項(人數 → 日期),全部用選的,不用打字。
/// 時段由後端查店家後以 choose_time 回傳。
class _SlotsForm extends StatelessWidget {
  const _SlotsForm({required this.controller, required this.fields});
  final BookingController controller;
  final List<String> fields;

  static const _maxParty = 8;
  static const _weekdays = ['一', '二', '三', '四', '五', '六', '日'];

  static String _ymd(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final today = DateTime.now();
    final days = [for (var i = 0; i < 14; i++) DateTime(today.year, today.month, today.day + i)];
    final busy = controller.busy;
    final askParty = fields.contains('party_size');
    final askDate = fields.contains('date');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(askParty ? '選擇人數' : '選擇日期', style: const TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        if (askParty)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (var n = 1; n <= _maxParty; n++)
                OutlinedButton(
                  onPressed: busy ? null : () => controller.submitSlots(partySize: n),
                  child: Text('$n 位'),
                ),
            ],
          )
        else if (askDate) ...[
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final d in days)
                OutlinedButton(
                  onPressed: busy ? null : () => controller.submitSlots(date: _ymd(d)),
                  child: Text('${d.month}/${d.day}（${_weekdays[d.weekday - 1]}）'),
                ),
            ],
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: busy
                ? null
                : () async {
                    final picked = await showDatePicker(
                      context: context,
                      initialDate: days.first,
                      firstDate: days.first,
                      lastDate: DateTime(today.year, today.month, today.day + 180),
                    );
                    if (picked != null) await controller.submitSlots(date: _ymd(picked));
                  },
            icon: const Icon(Icons.calendar_month_outlined),
            label: const Text('選其他日期'),
          ),
        ] else
          const Text('請在下方輸入訂位條件，或按右上角重新整理。'),
      ],
    );
  }
}

class _InfoForm extends StatefulWidget {
  const _InfoForm({required this.controller, required this.fields});
  final BookingController controller;
  final List<BookingInfoField> fields;
  @override
  State<_InfoForm> createState() => _InfoFormState();
}

class _InfoFormState extends State<_InfoForm> {
  final values = <String, TextEditingController>{};
  @override
  void initState() {
    super.initState();
    for (final f in widget.fields) {
      values[f.key] = TextEditingController();
    }
  }

  @override
  void dispose() {
    for (final c in values.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text('這家店需要以下資料', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      for (final f in widget.fields)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: f.type == 'select'
              ? DropdownButtonFormField<String>(
                  value: values[f.key]!.text.isEmpty ? null : values[f.key]!.text,
                  decoration: InputDecoration(labelText: f.label),
                  items: [for (final o in f.options) DropdownMenuItem(value: o, child: Text(o))],
                  onChanged: (v) => setState(() => values[f.key]!.text = v ?? ''),
                )
              : TextField(
                  controller: values[f.key],
                  keyboardType: f.type == 'email'
                      ? TextInputType.emailAddress
                      : f.type == 'tel'
                      ? TextInputType.phone
                      : TextInputType.text,
                  decoration: InputDecoration(labelText: f.label),
                ),
        ),
      FilledButton(
        onPressed: widget.controller.busy
            ? null
            : () {
                final contact = <String, String>{};
                final extra = <String, String>{};
                for (final f in widget.fields) {
                  final v = values[f.key]!.text.trim();
                  if (f.key.startsWith('contact.'))
                    contact[f.key.substring(8)] = v;
                  else if (f.key.startsWith('extra.'))
                    extra[f.key.substring(6)] = v;
                }
                widget.controller.submitSlots(contact: contact, extra: extra);
              },
        child: const Text('繼續'),
      ),
    ],
  );
}

class _ConfirmPlan extends StatelessWidget {
  const _ConfirmPlan({required this.controller});
  final BookingController controller;
  @override
  Widget build(BuildContext context) {
    final p = controller.booking.plan;
    if (p == null) return const SizedBox.shrink();
    final mins = p.expiresAt?.difference(DateTime.now()).inMinutes;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('請確認訂位方案', style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Text(
          '${p.restaurant.name}\n${p.restaurant.address}\n${p.date} ${p.time} · ${p.partySize} 位\n聯絡：${p.contact.values.join(' / ')}${p.extra.isEmpty ? '' : '\n${p.extra.entries.map((e) => '${e.key}：${e.value}').join('、')}'}${p.notes == null ? '' : '\n備註：${p.notes}'}',
          style: const TextStyle(height: 1.5),
        ),
        if (mins != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('方案約剩 ${mins < 0 ? 0 : mins} 分鐘有效', style: TextStyle(color: Colors.orange.shade800, fontSize: 12)),
          ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: controller.busy || !p.canConfirm ? null : controller.confirm,
          icon: const Icon(Icons.check),
          label: const Text('確認，開始訂位'),
        ),
      ],
    );
  }
}

class _Error extends StatelessWidget {
  const _Error({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    color: const Color(0xFFFEECEC),
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
    child: Text(text, style: TextStyle(color: Colors.red.shade800)),
  );
}

class _Composer extends StatelessWidget {
  const _Composer({required this.controller, required this.busy, required this.onSend});
  final TextEditingController controller;
  final bool busy;
  final VoidCallback onSend;
  @override
  Widget build(BuildContext context) => Container(
    color: Colors.white,
    padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Focus(
            onKeyEvent: (_, event) {
              final enter = event.logicalKey == LogicalKeyboardKey.enter || event.logicalKey == LogicalKeyboardKey.numpadEnter;
              if (!enter || event is! KeyDownEvent || HardwareKeyboard.instance.isShiftPressed) return KeyEventResult.ignored;
              final composing = controller.value.composing;
              if (composing.isValid && !composing.isCollapsed) return KeyEventResult.ignored;
              if (!busy) onSend();
              return KeyEventResult.handled;
            },
            child: TextField(
              controller: controller,
              minLines: 1,
              maxLines: 4,
              enabled: !busy,
              decoration: InputDecoration(hintText: busy ? '正在處理訂位…' : '補充或修改條件，例如：改成晚上 8 點'),
            ),
          ),
        ),
        const SizedBox(width: 10),
        FilledButton(
          onPressed: busy ? null : onSend,
          style: FilledButton.styleFrom(minimumSize: const Size(52, 48)),
          child: const Icon(Icons.arrow_upward),
        ),
      ],
    ),
  );
}
