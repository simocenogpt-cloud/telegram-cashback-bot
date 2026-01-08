import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_TELEGRAM_IDS = '',
  PUBLIC_CHANNEL_URL = '' // link invito canale VIP (anche privato)
} = process.env;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env vars: BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const adminIds = ADMIN_TELEGRAM_IDS.split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(BOT_TOKEN);

// ===============================
// CONFIG (testi + link bookmakers)
// ===============================
const BOOKMAKERS = [
  { name: 'Eurobet', url: 'https://record.betpartners.it/_Klv9utJ3bqpKqXDxdQZqW2Nd7ZgqdRLk/1/' },
  { name: 'bwin', url: 'https://www.bwin.it/it/engage/lan/s/p/sports/accaboost?wm=5596580' },
  { name: 'Betsson', url: 'https://record.betsson.it/_dYA2EWAR45qw8pi7H3I6R2Nd7ZgqdRLk/1/' },
  { name: 'Starcasino', url: 'https://record.starcasino.it/_dYA2EWAR45rPSO5RLscKcGNd7ZgqdRLk/1/' }
];

const PRIZES_TEXT = `🎁 Premi disponibili (buoni regalo):
• Amazon
• Zalando
• Airbnb
• Apple
• Spotify`;

// Escape HTML (per evitare errori parse + sicurezza)
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cashbackMessage() {
  const links = BOOKMAKERS.map(b => `• ${b.name}: ${b.url}`).join('\n');

  return `🔥 Richiesta accesso VIP + Premi 🔥

Per partecipare:
1️⃣ Registrati su UNO di questi link:
${links}

2️⃣ Effettua un deposito (seguendo le regole della promo/link)
3️⃣ Invia qui i dati richiesti + screenshot deposito

${PRIZES_TEXT}

⏱️ Verifica: entro 72 ore.
✅ Se la richiesta viene approvata, riceverai il link per entrare nel canale VIP.

Regole:
– Valido solo se usi uno dei link sopra
– Una sola partecipazione per persona
– Screenshot falsi o modificati = esclusione immediata`;
}

// ===============================
// UI (pulsanti)
// ===============================
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Invia richiesta', 'START_FLOW')],
  [Markup.button.callback('🆘 Supporto', 'SUPPORT')]
]);

const confirmMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📩 Invia', 'SUBMIT')],
  [Markup.button.callback('✏️ Modifica', 'EDIT')],
  [Markup.button.callback('↩️ Annulla', 'CANCEL_FLOW')]
]);

// ===============================
// Stato in memoria
// ===============================
const state = new Map(); // telegram_id -> { step, requestId }
const setState = (tid, data) => state.set(tid, { ...(state.get(tid) || {}), ...data });
const getState = (tid) => state.get(tid) || {};
const clearState = (tid) => state.delete(tid);

// ===============================
// DB helpers
// ===============================
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

  const { data: inserted, error: e3 } = await supabase.from('users').insert(payload).select('id').single();
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

async function setStatus(id, status, admin_note = null) {
  const patch = { status };
  if (admin_note !== null) patch.admin_note = admin_note;
  if (status === 'SUBMITTED') patch.submitted_at = new Date().toISOString();
  await updateRequest(id, patch);
}

async function getUserTelegramIdByUserId(userId) {
  const { data: userRow, error } = await supabase
    .from('users')
    .select('telegram_id')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return userRow.telegram_id;
}

// ===============================
// START
// ===============================
bot.start(async (ctx) => {
  try {
    await upsertUser(ctx);
    await ctx.reply(cashbackMessage(), mainMenu);
  } catch (err) {
    console.error(err);
    await ctx.reply('Errore temporaneo. Riprova tra poco.');
  }
});

// ===============================
// Pulsanti utente
// ===============================
bot.action('START_FLOW', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = await upsertUser(ctx);
    const requestId = await createDraftRequest(userId, 'vip_access');

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

bot.action('CANCEL_FLOW', async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.from.id);
  await ctx.reply('Operazione annullata. Se vuoi ripartire, premi “✅ Invia richiesta”.', mainMenu);
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

    await setStatus(st.requestId, 'SUBMITTED');
    const req = await getRequest(st.requestId);

    // Notifica admin con tasti Approva/Rifiuta (HTML + escape)
    const tgUser = ctx.from.username ? `@${ctx.from.username}` : 'n/a';

    const adminTextHtml =
      `🧾 <b>Nuova richiesta VIP</b>\n` +
      `ID: <b>${esc(req.id)}</b>\n` +
      `User TG: <b>${esc(tgUser)}</b> (${esc(ctx.from.id)})\n` +
      `Nome: <b>${esc(req.full_name || '-')}</b>\n` +
      `Email: <b>${esc(req.email || '-')}</b>\n` +
      `Username bookmaker: <b>${esc(req.username || '-')}</b>\n` +
      `Screenshot: <b>${req.screenshot_file_id ? '✅ presente' : '❌ mancante'}</b>\n\n` +
      `${esc(PRIZES_TEXT)}`;

    const adminKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Approva', `ADMIN_APPROVE_${req.id}`),
        Markup.button.callback('❌ Rifiuta', `ADMIN_REJECT_${req.id}`)
      ]
    ]);

    for (const aid of adminIds) {
      try {
        await bot.telegram.sendMessage(aid, adminTextHtml, {
          parse_mode: 'HTML',
          ...adminKeyboard
        });
      } catch (e) {
        console.error('Admin notify failed:', e);
      }
    }

    clearState(ctx.from.id);
    await ctx.reply('✅ Richiesta inviata! Ti aggiorniamo dopo la verifica (entro 72 ore).');
  } catch (err) {
    console.error(err);
    await ctx.reply('Errore durante invio. Riprova.');
  }
});

// ===============================
// Admin Approva / Rifiuta
// ===============================
function isAdmin(ctx) {
  return adminIds.includes(Number(ctx.from?.id));
}

bot.action(/ADMIN_APPROVE_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

    const requestId = Number(ctx.match[1]);
    const req = await getRequest(requestId);

    await setStatus(requestId, 'APPROVED');

    if (!PUBLIC_CHANNEL_URL) {
      await ctx.reply('⚠️ PUBLIC_CHANNEL_URL non configurato su Render (Environment).');
      return;
    }

    const userTelegramId = await getUserTelegramIdByUserId(req.user_id);

    await bot.telegram.sendMessage(
      userTelegramId,
      `✅ Richiesta approvata!\n\nEcco il link per entrare nel canale VIP:\n${PUBLIC_CHANNEL_URL}`
    );

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(`✅ Approvato (ID ${requestId}). Link inviato all’utente.`);
  } catch (err) {
    console.error(err);
    await ctx.reply('Errore durante approvazione.');
  }
});

bot.action(/ADMIN_REJECT_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

    const requestId = Number(ctx.match[1]);
    const req = await getRequest(requestId);

    await setStatus(requestId, 'REJECTED', 'Rifiutata da admin');

    const userTelegramId = await getUserTelegramIdByUserId(req.user_id);

    await bot.telegram.sendMessage(
      userTelegramId,
      '❌ Richiesta rifiutata. Se pensi sia un errore, rispondi qui per supporto.'
    );

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(`❌ Rifiutato (ID ${requestId}). Notifica inviata all’utente.`);
  } catch (err) {
    console.error(err);
    await ctx.reply('Errore durante rifiuto.');
  }
});

// ===============================
// Flusso: testo/foto/file
// ===============================
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
      return ctx.reply('Inserisci *Username / ID* usato sul bookmaker (quello del conto):', { parse_mode: 'Markdown' });
    }

    if (st.step === 'USERNAME') {
      const uname = (ctx.message.text || '').trim();
      if (uname.length < 2) return ctx.reply('Valore non valido. Reinserisci Username/ID:');
      await updateRequest(st.requestId, { username: uname });
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

      const req = await getRequest(st.requestId);
      const summary =
        `📋 *Riepilogo richiesta*\n` +
        `Nome: ${req.full_name}\n` +
        `Email: ${req.email}\n` +
        `Username bookmaker: ${req.username}\n` +
        `Screenshot: ${req.screenshot_file_id ? '✅' : '❌'}\n\n` +
        `Se è tutto corretto, premi “📩 Invia”.`;

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

// ===============================
// Avvio bot (Background Worker)
// ===============================
async function start() {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    console.log('Bot started');
  } catch (e) {
    console.error('FATAL start error:', e);
    process.exit(1);
  }
}

start();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
