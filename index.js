/**
 * Telegram VIP Access Bot (Background Worker - Render)
 * - User flow (private chat): Name → Email → Bookmaker Username/ID → Screenshot → Confirm → Submit
 * - Admin flow (DM): receives request + buttons ✅ Approva / ❌ Rifiuta / 💬 Chiedi info
 * - On APPROVE: user receives VIP invite link (private link is OK) + status updated
 * - On REJECT: user notified + status updated
 * - On ASK INFO: admin writes a message, bot forwards it to the user; user can reply and bot forwards back to admin
 *
 * ENV required on Render (Worker → Environment):
 * BOT_TOKEN
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * ADMIN_TELEGRAM_IDS      (comma separated, e.g. "123,456")
 * PUBLIC_CHANNEL_URL      (your private invite link, e.g. https://t.me/+S_ddlbzLIXpjNzZk)
 */

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_TELEGRAM_IDS = '',
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

// ===============================
// CONFIG (testi + link bookmakers)
// ===============================
const BOOKMAKERS = [
  { name: 'Eurobet', url: 'https://record.betpartners.it/_Klv9utJ3bqpKqXDxdQZqW2Nd7ZgqdRLk/1/' },
  { name: 'bwin', url: 'https://www.bwin.it/it/engage/lan/s/p/sports/accaboost?wm=5596580' },
  { name: 'Betsson', url: 'https://record.betsson.it/_dYA2EWAR45qw8pi7H3I6R2Nd7ZgqdRLk/1/' },
  { name: 'Starcasino', url: 'https://record.starcasino.it/_dYA2EWAR45rPSO5RLscKcGNd7ZgqdRLk/1/' }
];

const PRIZES_TEXT =
  `🎁 Premi disponibili (buoni regalo):\n` +
  `• Amazon\n` +
  `• Zalando\n` +
  `• Airbnb\n` +
  `• Apple\n` +
  `• Spotify`;

function introMessage() {
  const links = BOOKMAKERS.map((b) => `• ${b.name}: ${b.url}`).join('\n');

  return (
    `🔥 Accesso VIP + Premi 🔥\n\n` +
    `Per partecipare:\n` +
    `1️⃣ Registrati su UNO di questi link:\n${links}\n\n` +
    `2️⃣ Effettua un deposito (seguendo le regole della promo/link)\n` +
    `3️⃣ Invia qui i dati richiesti + screenshot del deposito\n\n` +
    `${PRIZES_TEXT}\n\n` +
    `⏱️ Verifica entro 72 ore.\n` +
    `✅ Se approvato, riceverai il link per entrare nel canale VIP.\n\n` +
    `Regole:\n` +
    `– Valido solo se usi uno dei link sopra\n` +
    `– Una sola partecipazione per persona\n` +
    `– Screenshot falsi o modificati = esclusione immediata`
  );
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
// stateUser: telegram_user_id -> { step, requestId }
const stateUser = new Map();
const setUserState = (tid, data) => stateUser.set(tid, { ...(stateUser.get(tid) || {}), ...data });
const getUserState = (tid) => stateUser.get(tid) || {};
const clearUserState = (tid) => stateUser.delete(tid);

// stateAdmin: admin_id -> { mode: 'ASK_INFO', requestId }
const stateAdmin = new Map();
const setAdminState = (aid, data) => stateAdmin.set(aid, { ...(stateAdmin.get(aid) || {}), ...data });
const getAdminState = (aid) => stateAdmin.get(aid) || {};
const clearAdminState = (aid) => stateAdmin.delete(aid);

// ===============================
// Helpers
// ===============================
function isAdmin(ctx) {
  return adminIds.includes(Number(ctx.from?.id));
}

function safeText(s) {
  // We will NOT use Markdown to avoid parse errors with usernames/underscores.
  // This is just a small sanitization.
  return String(s ?? '').replace(/\u0000/g, '');
}

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
    .insert({ user_id: userId, campaign, status: 'DRAFT' })
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

async function getUserTelegramIdByUserId(userId) {
  const { data, error } = await supabase.from('users').select('telegram_id').eq('id', userId).single();
  if (error) throw error;
  return data.telegram_id;
}

async function setStatus(requestId, status, admin_note = null) {
  const patch = { status };
  if (admin_note !== null) patch.admin_note = admin_note;

  if (status === 'SUBMITTED') patch.submitted_at = new Date().toISOString();
  if (status === 'APPROVED') patch.approved_at = new Date().toISOString();
  if (status === 'REJECTED') patch.rejected_at = new Date().toISOString();

  await updateRequest(requestId, patch);
}

async function notifyAdminsNewRequest(ctxUser, req) {
  const tgUsername = ctxUser.from.username ? `@${ctxUser.from.username}` : 'n/a';

  const adminText =
    `🧾 Nuova richiesta VIP\n` +
    `ID: ${req.id}\n` +
    `User TG: ${tgUsername} (${ctxUser.from.id})\n` +
    `Nome: ${safeText(req.full_name) || '-'}\n` +
    `Email: ${safeText(req.email) || '-'}\n` +
    `Username bookmaker: ${safeText(req.username) || '-'}\n` +
    `Screenshot: ${req.screenshot_file_id ? '✅ presente' : '❌ mancante'}\n\n` +
    `${PRIZES_TEXT}`;

  const adminKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approva', `ADMIN_APPROVE_${req.id}`),
      Markup.button.callback('❌ Rifiuta', `ADMIN_REJECT_${req.id}`)
    ],
    [Markup.button.callback('💬 Chiedi info', `ADMIN_ASK_${req.id}`)]
  ]);

  for (const aid of adminIds) {
    try {
      await bot.telegram.sendMessage(aid, adminText, { reply_markup: adminKeyboard.reply_markup });

      // Se c'è screenshot, invialo anche come media (molto più comodo per l'admin)
      async function notifyAdminsNewRequest(ctxUser, req) {
        const tgUsername = ctxUser.from.username ? `@${ctxUser.from.username}` : 'n/a';
      
        const adminText =
          `🧾 Nuova richiesta VIP\n` +
          `ID: ${req.id}\n` +
          `User TG: ${tgUsername} (${ctxUser.from.id})\n` +
          `Nome: ${safeText(req.full_name) || '-'}\n` +
          `Email: ${safeText(req.email) || '-'}\n` +
          `Username bookmaker: ${safeText(req.username) || '-'}\n` +
          `Screenshot: ${req.screenshot_file_id ? '✅ presente' : '❌ mancante'}\n\n` +
          `${PRIZES_TEXT}`;
      
        const adminKeyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Approva', `ADMIN_APPROVE_${req.id}`),
            Markup.button.callback('❌ Rifiuta', `ADMIN_REJECT_${req.id}`)
          ],
          [Markup.button.callback('💬 Chiedi info', `ADMIN_ASK_${req.id}`)]
        ]);
      
        for (const aid of adminIds) {
          try {
            // 1) Messaggio testuale con bottoni
            await bot.telegram.sendMessage(aid, adminText, {
              reply_markup: adminKeyboard.reply_markup
            });
      
            // 2) Media: invia SEMPRE se presente, senza fidarsi troppo del mime
            if (req.screenshot_file_id) {
              const caption = `📎 Screenshot deposito — ID richiesta ${req.id}`;
      
              try {
                // Prova come foto (funziona se file_id è di una photo)
                await bot.telegram.sendPhoto(aid, req.screenshot_file_id, { caption });
              } catch (e1) {
                // Se non è una foto (es. PDF/doc), prova come documento
                try {
                  await bot.telegram.sendDocument(aid, req.screenshot_file_id, { caption });
                } catch (e2) {
                  console.error('Admin screenshot send failed (photo+document):', e1, e2);
                  await bot.telegram.sendMessage(
                    aid,
                    `⚠️ Non sono riuscito a inviare lo screenshot automaticamente (ID richiesta ${req.id}).`
                  );
                }
              }
            }
          } catch (e) {
            console.error('Admin notify failed:', e);
          }
        }
      }
      
    } catch (e) {
      console.error('Admin notify failed:', e);
    }
  }
}

// ===============================
// START
// ===============================
bot.start(async (ctx) => {
  try {
    await upsertUser(ctx);
    await ctx.reply(introMessage(), mainMenu);
  } catch (e) {
    console.error(e);
    await ctx.reply('Errore temporaneo. Riprova tra poco.');
  }
});

// ===============================
// User actions
// ===============================
bot.action('START_FLOW', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = await upsertUser(ctx);
    const requestId = await createDraftRequest(userId, 'vip_access');

    setUserState(ctx.from.id, { step: 'FULL_NAME', requestId });
    await ctx.reply('Perfetto ✅\n\nInserisci Nome e Cognome:');
  } catch (e) {
    console.error(e);
    await ctx.reply('Errore. Riprova tra poco.');
  }
});

bot.action('SUPPORT', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Scrivimi pure qui il tuo problema: ti risponderà un operatore appena possibile.');
});

bot.action('CANCEL_FLOW', async (ctx) => {
  await ctx.answerCbQuery();
  clearUserState(ctx.from.id);
  await ctx.reply('Operazione annullata. Se vuoi ripartire, premi “✅ Invia richiesta”.', mainMenu);
});

bot.action('EDIT', async (ctx) => {
  await ctx.answerCbQuery();
  const st = getUserState(ctx.from.id);
  if (!st.requestId) return ctx.reply('Sessione scaduta. Riparti dal menu.', mainMenu);

  setUserState(ctx.from.id, { step: 'FULL_NAME' });
  await ctx.reply('Ok, reinserisci Nome e Cognome:');
});

bot.action('SUBMIT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const st = getUserState(ctx.from.id);
    if (!st.requestId) return ctx.reply('Sessione scaduta. Riparti dal menu.', mainMenu);

    await setStatus(st.requestId, 'SUBMITTED');
    const req = await getRequest(st.requestId);

    await notifyAdminsNewRequest(ctx, req);

    clearUserState(ctx.from.id);
    await ctx.reply('✅ Richiesta inviata! Ti aggiorniamo dopo la verifica (entro 72 ore).');
  } catch (e) {
    console.error(e);
    await ctx.reply('Errore durante invio. Riprova.');
  }
});

// ===============================
// Admin actions
// ===============================
bot.action(/ADMIN_APPROVE_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

    const requestId = Number(ctx.match[1]);
    const req = await getRequest(requestId);

    await setStatus(requestId, 'APPROVED');

    const userTelegramId = await getUserTelegramIdByUserId(req.user_id);

    if (!PUBLIC_CHANNEL_URL) {
      await ctx.reply('⚠️ PUBLIC_CHANNEL_URL non configurato (Render → Environment).');
      return;
    }

    await bot.telegram.sendMessage(
      userTelegramId,
      `✅ Richiesta approvata!\n\nQui sotto trovi il link per entrare nel canale VIP (anche se è privato va benissimo):\n${PUBLIC_CHANNEL_URL}\n\n` +
      `⚠️ Nota: su Telegram non posso “inserirti automaticamente”, devi cliccare il link ed entrare.`
    );

    // togli bottoni dal messaggio admin (se possibile)
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(`✅ Approvato (ID ${requestId}). Link inviato all’utente.`);
  } catch (e) {
    console.error(e);
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
      '❌ Richiesta rifiutata.\nSe pensi sia un errore, rispondi qui e ti chiediamo le info mancanti.'
    );

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(`❌ Rifiutato (ID ${requestId}). Notifica inviata all’utente.`);
  } catch (e) {
    console.error(e);
    await ctx.reply('Errore durante rifiuto.');
  }
});

bot.action(/ADMIN_ASK_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

    const requestId = Number(ctx.match[1]);
    const req = await getRequest(requestId);
    const userTelegramId = await getUserTelegramIdByUserId(req.user_id);

    // salva stato: la prossima cosa che scrive l'admin verrà inoltrata all'utente
    setAdminState(ctx.from.id, { mode: 'ASK_INFO', requestId, userTelegramId });

    await ctx.reply(
      `💬 Ok. Scrivi ora il messaggio per l’utente (ID richiesta ${requestId}).\n` +
      `Esempio: “Ciao, puoi mandarmi lo screenshot completo con data visibile?”\n\n` +
      `Per annullare: scrivi /annulla`
    );
  } catch (e) {
    console.error(e);
    await ctx.reply('Errore.');
  }
});

// ===============================
// Message router (USER + ADMIN)
// ===============================
bot.on(['text', 'photo', 'document'], async (ctx) => {
  const tid = ctx.from.id;

  // 1) ADMIN typing a message after "Chiedi info"
  if (isAdmin(ctx)) {
    const astate = getAdminState(tid);

    // annulla
    if (ctx.message?.text && ctx.message.text.trim().toLowerCase() === '/annulla') {
      clearAdminState(tid);
      return ctx.reply('✅ Operazione annullata.');
    }

    if (astate?.mode === 'ASK_INFO' && astate.userTelegramId) {
      const txt = ctx.message?.text ? ctx.message.text.trim() : '';
      if (!txt) return ctx.reply('Scrivi un messaggio testuale (non foto/file) oppure /annulla.');

      try {
        await bot.telegram.sendMessage(
          astate.userTelegramId,
          `ℹ️ Messaggio dall’admin:\n${txt}\n\nRispondi qui in chat al bot.`
        );

        // salva una traccia minima nel DB (opzionale)
        await updateRequest(astate.requestId, { admin_note: `Admin asked info: ${txt}` }).catch(() => {});

        clearAdminState(tid);
        return ctx.reply('✅ Messaggio inviato all’utente.');
      } catch (e) {
        console.error(e);
        clearAdminState(tid);
        return ctx.reply('❌ Non sono riuscito a inviare il messaggio all’utente.');
      }
    }

    // se l'admin scrive a caso senza essere in ASK_INFO, ignoriamo
    return;
  }

  // 2) USER flow steps
  const st = getUserState(tid);
  if (!st.step || !st.requestId) return;

  try {
    if (st.step === 'FULL_NAME') {
      const fullName = (ctx.message.text || '').trim();
      if (fullName.length < 3) return ctx.reply('Nome non valido. Reinserisci Nome e Cognome:');
      await updateRequest(st.requestId, { full_name: fullName });
      setUserState(tid, { step: 'EMAIL' });
      return ctx.reply('Inserisci Email usata per la registrazione:');
    }

    if (st.step === 'EMAIL') {
      const email = (ctx.message.text || '').trim();
      if (!email.includes('@')) return ctx.reply('Email non valida. Reinserisci:');
      await updateRequest(st.requestId, { email });
      setUserState(tid, { step: 'USERNAME' });
      return ctx.reply('Inserisci Username / ID usato sul bookmaker (quello del conto):');
    }

    if (st.step === 'USERNAME') {
      const uname = (ctx.message.text || '').trim();
      if (uname.length < 2) return ctx.reply('Valore non valido. Reinserisci Username/ID:');
      await updateRequest(st.requestId, { username: uname });
      setUserState(tid, { step: 'SCREENSHOT' });
      return ctx.reply('Ora invia lo screenshot del deposito (foto o file).');
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
        return ctx.reply('Per favore invia una foto o un file (screenshot).');
      }

      await updateRequest(st.requestId, { screenshot_file_id: fileId, screenshot_mime: mime });

      const req = await getRequest(st.requestId);
      const summary =
        `📋 Riepilogo richiesta\n` +
        `Nome: ${safeText(req.full_name)}\n` +
        `Email: ${safeText(req.email)}\n` +
        `Username bookmaker: ${safeText(req.username)}\n` +
        `Screenshot: ${req.screenshot_file_id ? '✅' : '❌'}\n\n` +
        `Se è tutto corretto, premi “📩 Invia”.`;

      setUserState(tid, { step: 'CONFIRM' });
      return ctx.reply(summary, confirmMenu);
    }

    if (st.step === 'CONFIRM') {
      return ctx.reply('Usa i pulsanti sotto per inviare/modificare.', confirmMenu);
    }
  } catch (e) {
    console.error(e);
    await ctx.reply('Errore durante la compilazione. Riprova dal menu.', mainMenu);
    clearUserState(tid);
  }
});

// ===============================
// Forward USER replies to ADMIN (when admin asked info)
// ===============================
// Se l’utente risponde dopo una richiesta info, inoltriamo agli admin.
// (Semplice: qualunque messaggio dell’utente, se la sua ultima richiesta è SUBMITTED/APPROVED/REJECTED, lo mandiamo come “reply”.)
bot.on('text', async (ctx, next) => {
  if (isAdmin(ctx)) return next();

  // se l’utente NON è in flow (nessuno step), allora è probabilmente una risposta post-verifica
  const st = getUserState(ctx.from.id);
  if (st?.step) return next();

  try {
    // prende l’ultima richiesta dell’utente (se vuoi limitarlo meglio, dimmelo e lo rendiamo “per requestId”)
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('telegram_id', ctx.from.id)
      .single();

    if (error) return next();

    const userId = data.id;

    const { data: lastReq, error: e2 } = await supabase
      .from('cashback_requests')
      .select('id,status')
      .eq('user_id', userId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (e2 || !lastReq?.id) return next();

    const txt = (ctx.message.text || '').trim();
    if (!txt) return next();

    for (const aid of adminIds) {
      try {
        await bot.telegram.sendMessage(
          aid,
          `💬 Risposta utente\nID richiesta: ${lastReq.id}\nUser: @${ctx.from.username || 'n/a'} (${ctx.from.id})\n\n${txt}`
        );
      } catch (e) {
        console.error('Forward reply to admin failed:', e);
      }
    }
  } catch (e) {
    console.error(e);
  }

  return next();
});

// ===============================
// Avvio bot (Background Worker)
// ===============================
async function start() {
  try {
    // Consigliato: rimuove eventuale webhook e pulisce update pendenti
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
