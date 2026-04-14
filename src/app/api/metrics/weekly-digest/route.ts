import { NextRequest, NextResponse } from 'next/server';
import { generateWeeklyDigest, formatDigestMarkdown } from '@/lib/weekly-digest';

/**
 * GET /api/metrics/weekly-digest
 * Returns { digest: WeeklyDigest, markdown: string }
 */
export async function GET() {
  try {
    const digest = await generateWeeklyDigest();
    const markdown = formatDigestMarkdown(digest);
    return NextResponse.json({ digest, markdown });
  } catch (e: any) {
    console.error('[weekly-digest] GET error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST /api/metrics/weekly-digest
 * Body: { action: "send" }
 * Generates the digest and optionally sends to Telegram.
 * Returns { ok: true, digest, telegramSent: boolean }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body;

    const digest = await generateWeeklyDigest();
    const markdown = formatDigestMarkdown(digest);

    let telegramSent = false;

    if (action === 'send') {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId   = process.env.TELEGRAM_CHAT_ID || process.env.NOTIFY_CHAT_ID;

      if (botToken && chatId) {
        try {
          const tgRes = await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: markdown,
                parse_mode: 'Markdown',
              }),
            }
          );
          telegramSent = tgRes.ok;
          if (!tgRes.ok) {
            const errBody = await tgRes.text();
            console.error('[weekly-digest] Telegram send failed:', errBody);
          }
        } catch (tgErr) {
          console.error('[weekly-digest] Telegram fetch error:', tgErr);
        }
      } else {
        console.warn('[weekly-digest] No TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID — skipping send');
      }
    }

    return NextResponse.json({ ok: true, digest, markdown, telegramSent });
  } catch (e: any) {
    console.error('[weekly-digest] POST error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
