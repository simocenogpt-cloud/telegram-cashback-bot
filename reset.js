import 'dotenv/config';
import { Telegraf } from 'telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN);

async function main() {
  // 1) Togli eventuale webhook (se qualcuno lo ha impostato)
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });

  // 2) Prova anche a "svuotare" gli update
  // (in pratica drop_pending_updates sopra fa già il lavoro)
  console.log('✅ Webhook removed + pending updates dropped');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ reset failed:', e);
  process.exit(1);
});
