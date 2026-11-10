import 'package:flutter/material.dart';

import '../models/booking_models.dart';

/// 側邊欄與訂位紀錄共用的一列:店名、用餐時間與人數、狀態(成功時附訂位編號)。
class BookingTile extends StatelessWidget {
  const BookingTile({super.key, required this.booking, required this.onTap, this.selected = false});

  final BookingSummary booking;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final b = booking;
    final title = b.restaurantName ?? (b.summary.isEmpty ? '訂位代辦' : b.summary);
    final when = b.restaurantName == null ? '' : b.whenText;
    return Material(
      color: selected ? const Color(0xFFEFEAFF) : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
          child: Row(
            children: [
              Container(
                width: 42,
                height: 42,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: bookingStatusTint(b.status), borderRadius: BorderRadius.circular(13)),
                child: Icon(bookingStatusIcon(b.status), color: bookingStatusColor(b.status)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                    if (when.isNotEmpty) ...[
                      const SizedBox(height: 1),
                      Text(when, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: Colors.grey.shade700, fontSize: 12)),
                    ],
                    const SizedBox(height: 1),
                    Text(
                      bookingStatusLine(b),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: bookingStatusColor(b.status), fontSize: 12),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 狀態那一行:成功顯示訂位編號,結果不明提醒要向店家確認
String bookingStatusLine(BookingSummary b) => switch (b.status) {
  BookingStatus.succeeded when b.result?.confirmationNo != null => '訂位成功 · ${b.result!.confirmationNo}',
  BookingStatus.unknown => '結果不明 · 請向店家確認',
  BookingStatus.awaitingConfirmation => '方案待你確認',
  _ => b.status.text,
};

Color bookingStatusColor(BookingStatus status) => switch (status) {
  BookingStatus.succeeded => Colors.green.shade700,
  BookingStatus.failed || BookingStatus.unknown => Colors.red.shade700,
  BookingStatus.awaitingConfirmation || BookingStatus.confirmed || BookingStatus.executing => Colors.orange.shade800,
  _ => Colors.grey.shade600,
};

Color bookingStatusTint(BookingStatus status) => switch (status) {
  BookingStatus.succeeded => const Color(0xFFE7F6EC),
  BookingStatus.failed || BookingStatus.unknown => const Color(0xFFFDECEC),
  BookingStatus.cancelled || BookingStatus.expired => const Color(0xFFF1F2F4),
  _ => const Color(0xFFFFF1E5),
};

IconData bookingStatusIcon(BookingStatus status) => switch (status) {
  BookingStatus.succeeded => Icons.event_available,
  BookingStatus.unknown => Icons.help_outline,
  BookingStatus.failed => Icons.event_busy,
  BookingStatus.cancelled || BookingStatus.expired => Icons.block,
  _ => Icons.restaurant_menu,
};
