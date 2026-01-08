import 'dotenv/config';
import http from 'http';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_TELEGRAM_IDS = '',
  AFFILIATE_LINK = '',
  PUBLIC_CHANNEL_URL = ''
} = process.env;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env vars: BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const adminIds = ADMIN_TELEGRAM_IDS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(BOT_TOKEN);

// --- Template messaggio cashback ---
function cashbackMessage() {
  return `🔥 Cashback immediato: Depositi 10€, ricevi 10€ indietro 🔥

Come funziona:
1️⃣ Registrati su Snai tramite questo link: ${AFFILIATE_LINK || '___'}
2️⃣ Effettua un deposito di almeno 10€
3️⃣ Invia qui i seguenti dati:
• Nome e cognome
• Email usata per la registrazione
• Username / ID conto Snai
• Screenshot del deposito (importo, data e username)
• PayPal/Revolut indirizzo per ricevere il cashback

Supporto:
Se hai dubbi su verifica, tempi o cosa inviare, scrivi qui: ti risponde una persona reale.

Verifica e pagamento:
Una volta controllate le informazioni, il cashback verrà inviato.
⏱️ Entro 72 ore (PayPal / Revolut)

Regole:
– Promo valida solo se usi questo link
– Cashback solo sul primo deposito
– Una sola partecipazione per persona
– Screenshot falsi o modificati = esclusione immediata`;
}

const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Invia dati cashback', 'START_FLOW')],
  [Markup.button.callback('🆘 Supporto', 'SUPPORT')]
]);

const payoutMenu = Markup.inlineKeyboard([
  [Markup.button.callback('PayPal', 'PAYOUT_paypal'), Markup.button.callback('Revolut', 'PAYOUT_revolut')],
  [Markup.button.callback('↩️ Annulla', 'CANCEL_FLOW')]
]);

const confirmMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📩 Invia richiesta', 'SUBMIT')],
  [Markup.button.callback('✏️ Modifica', 'EDIT')],
  [Markup.button.callback('↩️ Annulla', 'CANCEL_FLOW')]
]);

// --- Stato in memoria (ok per iniziare) ---
const state = new Map(); // telegram_id -> { step, requestId }
const setState = (tid, data) => state.set(tid, { ...(state.get(tid) || {}), ...data });
const getState = (tid) => state.get(tid) || {};
const clearState = (tid) => state.delete(tid);

// --- Helpers DB ---
async function upsertUser(ctx) {
  const u = ctx.from;
  const payload = {
    telegram_id: u.id,
    username: u.username || null,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    last_seen_at: new Date().toISOString()
  };

  const { data: existing, error: e1 } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', u.id)
    .maybeSingle();

  if (e1) throw e1;

  if (existing?.id) {
    const { error: e2 } = await supabase.from('users').update(payload).eq('id', existing.id);
    if (e2) throw e2;
    return existing.id;
  }

  const { data: inserted, error: e3 } = await supabase
    .from('users')
    .insert(payload)
    .select('id')
    .single();

  if (e3) throw e3;
  return inserted.id;
}

async function createDraftRequest(userId, campaign) {
  const { data, error } = await supabase
    .from('cashback_requests')
    .insert({ user_id: userId, campaign })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function updateRequest(id, patch) {
  const { error } = await supabase.from('cashback_requests').update(patch).eq('id', id);
  if (error) throw error;
}

async function getRequest(id) {
  const { data, error } = await supabase.from('cashback_requests').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

// --- START con deep link ---
bot.start(async (ctx) => {
  try {
    await upsertUser(ctx);
    const payload = (ctx.startPayload || '').trim(); // es: cashback_snai

    if (payload === 'cashback_snai') {
      await ctx.reply(cashbackMessage(), mainMenu);
    } else {
      await ctx.reply(
        `Ciao! 👋\nApri il link dal canale per partecipare al cashback.\n${
          PUBLIC_CHANNEL_URL ? `Canale: ${PUBLIC_CHANNEL_URL}` : ''
        }`
      );
    }
  } catch (err) {
    console.error(err);
    await ctx.reply('Errore temporaneo. Riprova tra poco.');
  }
});

// --- Pulsanti ---
bot.action('START_FLOW', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = await upsertUser(ctx);
    const requestId = await createDraftRequest(userId, 'cashback_snai');

    setState(ctx.from.id, { step: 'FULL_NAME', requestId });
    await ctx.reply('Perfetto ✅\n\nInserisci *Nome e Cognome*:', { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(err);
    await ctx.reply('Errore. Riprova tra poco.');
  }
});

bot.action('SUPPORT', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Scrivimi pure qui il tuo problema: ti risponderà un operatore appena possibile.');
});

bot.action(/PAYOUT_(.+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const method = ctx.match[1];
    const st = getState(ctx.from.id);
    if (!st.requestId) return ctx.reply('Sessione scaduta. Premi “Invia dati cashback” per ripartire.');

    await updateRequest(st.requestId, { payout_method: method });
    setState(ctx.from.id, { step: 'PAYOUT_ADDRESS' });

    await ctx.reply(`Ok. Ora inserisci l’indirizzo ${method.toUpperCase()} (email o ID):`);
  } catch (err) {
    console.error(err);
    await ctx.reply('Errore. Riprova.');
  }
});

bot.action('CANCEL_FLOW', async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.from.id);
  await ctx.reply('Operazione annullata. Se vuoi ripartire, premi “✅ Invia dati cashback”.', mainMenu);
});

bot.action('EDIT', async (ctx) => {
  await ctx.answerCbQuery();
  const st = getState(ctx.from.id);
  if (!st.requestId) return ctx.reply('Sessione scaduta. Riparti dal menu.', mainMenu);
  setState(ctx.from.id, { step: 'FULL_NAME' });
  await ctx.reply('Ok, reinserisci *Nome e Cognome*:', { parse_mode: 'Markdown' });
});

bot.action('SUBMIT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const st = getState(ctx.from.id);
    if (!st.requestId) return ctx.reply('Sessione scaduta. Riparti dal menu.', mainMenu);

    await updateRequest(st.requestId, { status: 'SUBMITTED', submitted_at: new Date().toISOString() });
    const req = await getRequest(st.requestId);

    const adminText =
      `🧾 *Nuova richiesta cashback*\n` +
      `ID: ${req.id}\n` +
      `User: @${ctx.from.username || 'n/a'} (${ctx.from.id})\n` +
      `Nome: ${req.full_name || '-'}\n` +
      `Email: ${req.email || '-'}\n` +
      `Username: ${req.username || '-'}\n` +
      `Deposito: ${req.deposit_amount ?? '-'}\n` +
      `Pagamento: ${req.payout_method || '-'} → ${req.payout_address || '-'}\n` +
      `Screenshot: ${req.screenshot_file_id ? '✅ presente' : '❌ mancante'}`;

    for (const aid of adminIds) {
      try {
        await bot.telegram.sendMessage(aid, adminText, { parse_mode: 'Markdown' });
      } catch {}
    }

    clearState(ctx.from.id);
    await ctx.reply('✅ Richiesta inviata! Ti aggiorniamo dopo la verifica (entro 72 ore).');
  } catch (err) {
    console.error(err);
    await ctx.reply('Errore durante invio. Riprova.');
  }
});

// --- Gestione step (testo/foto/file) ---
bot.on(['text', 'photo', 'document'], async (ctx) => {
  const tid = ctx.from.id;
  const st = getState(tid);
  if (!st.step || !st.requestId) return;

  try {
    if (st.step === 'FULL_NAME') {
      const fullName = (ctx.message.text || '').trim();
      if (fullName.length < 3) return ctx.reply('Nome non valido. Reinserisci Nome e Cognome:');
      await updateRequest(st.requestId, { full_name: fullName });
      setState(tid, { step: 'EMAIL' });
      return ctx.reply('Inserisci *Email* usata per la registrazione:', { parse_mode: 'Markdown' });
    }

    if (st.step === 'EMAIL') {
      const email = (ctx.message.text || '').trim();
      if (!email.includes('@')) return ctx.reply('Email non valida. Reinserisci:');
      await updateRequest(st.requestId, { email });
      setState(tid, { step: 'USERNAME' });
      return ctx.reply('Inserisci *Username / ID Snai*:', { parse_mode: 'Markdown' });
    }

    if (st.step === 'USERNAME') {
      const uname = (ctx.message.text || '').trim();
      if (uname.length < 2) return ctx.reply('Valore non valido. Reinserisci Username/ID:');
      await updateRequest(st.requestId, { username: uname });
      setState(tid, { step: 'DEPOSIT' });
      return ctx.reply('Inserisci importo deposito (solo numero, es. 10):');
    }

    if (st.step === 'DEPOSIT') {
      const raw = (ctx.message.text || '').trim().replace(',', '.');
      const val = Number(raw);
      if (!Number.isFinite(val) || val <= 0) return ctx.reply('Importo non valido. Inserisci ad esempio 10:');
      await updateRequest(st.requestId, { deposit_amount: val });
      setState(tid, { step: 'SCREENSHOT' });
      return ctx.reply('Ora invia *lo screenshot del deposito* (foto o file).', { parse_mode: 'Markdown' });
    }

    if (st.step === 'SCREENSHOT') {
      let fileId = null;
      let mime = null;

      if (ctx.message.photo?.length) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        mime = 'image';
      } else if (ctx.message.document?.file_id) {
        fileId = ctx.message.document.file_id;
        mime = ctx.message.document.mime_type || 'document';
      } else {
        return ctx.reply('Per favore invia una *foto* o un *file* (screenshot).', { parse_mode: 'Markdown' });
      }

      await updateRequest(st.requestId, { screenshot_file_id: fileId, screenshot_mime: mime });
      setState(tid, { step: 'PAYOUT_METHOD' });
      return ctx.reply('Scegli il metodo di pagamento:', payoutMenu);
    }

    if (st.step === 'PAYOUT_ADDRESS') {
      const addr = (ctx.message.text || '').trim();
      if (addr.length < 3) return ctx.reply('Indirizzo non valido. Reinserisci:');
      await updateRequest(st.requestId, { payout_address: addr });

      const req = await getRequest(st.requestId);
      const summary =
        `📋 *Riepilogo richiesta*\n` +
        `Nome: ${req.full_name}\n` +
        `Email: ${req.email}\n` +
        `Username: ${req.username}\n` +
        `Deposito: ${req.deposit_amount}\n` +
        `Pagamento: ${req.payout_method?.toUpperCase()} → ${req.payout_address}\n` +
        `Screenshot: ${req.screenshot_file_id ? '✅' : '❌'}\n\n` +
        `Se è tutto corretto, premi “📩 Invia richiesta”.`;

      setState(tid, { step: 'CONFIRM' });
      return ctx.reply(summary, { parse_mode: 'Markdown', ...confirmMenu });
    }

    if (st.step === 'CONFIRM') {
      return ctx.reply('Usa i pulsanti sotto per inviare/modificare.', confirmMenu);
    }
  } catch (err) {
    console.error(err);
    await ctx.reply('Errore durante la compilazione. Riprova dal menu.', mainMenu);
    clearState(tid);
  }
});

/**
 * Mini server HTTP per Render (Web Service gratuito).
 * Render richiede una porta aperta per considerare il servizio "healthy".
 */
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
  })
  .listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
  });

(async () => {
  await bot.launch({ dropPendingUpdates: true });
  console.log('Bot started');
})();

bot.catch((err) => console.error('BOT ERROR:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
