/**
 * Telegram VIP Access Bot (Background Worker - Render)
 *
 * USER:
 *  - VIP request flow
 *  - Support flow (ticket): user sends message -> admin receives -> admin replies -> user receives
 *
 * ADMIN:
 *  - Approve/Reject/Ask info
 *  - Support replies
 *
 * ENV on Render (Worker → Environment):
 *  BOT_TOKEN
 *  SUPABASE_URL
 *  SUPABASE_SERVICE_ROLE_KEY
 *  ADMIN_TELEGRAM_IDS        (comma separated)
 *  PUBLIC_CHANNEL_ID         (numeric chat_id like -100...)
 */

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_TELEGRAM_IDS = '',
  PUBLIC_CHANNEL_ID = ''
} = process.env;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env vars: BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const adminIds = ADMIN_TELEGRAM_IDS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((v) => Number(v))
  .filter((n) => Number.isFinite(n));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(BOT_TOKEN);

// ===============================
// TESTO INTRO (IDENTICO AL TUO)
// ===============================
function introMessage() {
  return `🔥 Richiesta accesso VIP + Premi 🔥

Per partecipare:
1️⃣ Registrati su UNO di questi link:
• Eurobet: https://record.betpartners.it/_Klv9utJ3bqpKqXDxdQZqW2Nd7ZgqdRLk/1/
• bwin: https://www.bwin.it/it/engage/lan/s/p/sports/accaboost?wm=5596580
• Betsson: https://record.betsson.it/_dYA2EWAR45qw8pi7H3I6R2Nd7ZgqdRLk/1/
• Starcasino: https://record.starcasino.it/_dYA2EWAR45rPSO5RLscKcGNd7ZgqdRLk/1/

2️⃣ Effettua un deposito (seguendo le regole della promo/link)
3️⃣ Invia qui i dati richiesti + screenshot deposito

🎁 Premi disponibili (buoni regalo):
• Amazon
• Zalando
• Airbnb
• Apple
• Spotify

⏱️ Verifica: entro 72 ore.
✅ Se la richiesta viene approvata, riceverai il link per entrare nel canale VIP.

Regole:
– Valido solo se usi uno dei link sopra
– Una sola partecipazione per persona
– Screenshot falsi o modificati = esclusione immediata`;
}

// ===============================
// UI
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
// STATE
// ===============================
const stateUser = new Map(); // telegram_user_id -> { step, requestId }
const setUserState = (tid, data) => stateUser.set(tid, { ...(stateUser.get(tid) || {}), ...data });
const getUserState = (tid) => stateUser.get(tid) || {};
const clearUserState = (tid) => stateUser.delete(tid);

const stateAdmin = new Map(); // admin_id -> { mode: 'ASK_INFO', requestId, userTelegramId }
const setAdminState = (aid, data) => stateAdmin.set(aid, { ...(stateAdmin.get(aid) || {}), ...data });
const getAdminState = (aid) => stateAdmin.get(aid) || {};
const clearAdminState = (aid) => stateAdmin.delete(aid);

const pendingReplies = new Map(); // userTelegramId -> { adminId, requestId }

// SUPPORT routing
const pendingSupport = new Map(); // userTelegramId -> true (user is writing support)
const supportThreads = new Map(); // userTelegramId -> { adminId } (last admin who handled support)

// ===============================
// HELPERS
// ===============================
function isAdmin(ctx) {
  return adminIds.includes(Number(ctx.from?.id));
}

function safeText(s) {
  return String(s ?? '').replace(/\u0000/g, '');
}

function errToString(e) {
  try {
    const desc = e?.response?.description;
    const code = e?.response?.error_code;
    if (desc || code) return `${code || ''} ${desc || ''}`.trim();
    return e?.message || 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}

// ===============================
// DB HELPERS
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
  const n = Number(data.telegram_id);
  return Number.isFinite(n) ? n : data.telegram_id;
}

async function setStatus(requestId, status, admin_note = null) {
  const patch = { status };
  if (admin_note !== null) patch.admin_note = admin_note;
  if (status === 'SUBMITTED') patch.submitted_at = new Date().toISOString();
  await updateRequest(requestId, patch);
}

// ===============================
// ADMIN NOTIFY (VIP REQUEST + SCREENSHOT)
// ===============================
async function notifyAdminsNewRequest(ctxUser, req) {
  const tgUsername = ctxUser.from.username ? `@${ctxUser.from.username}` : 'n/a';

  const adminText =
    `🧾 Nuova richiesta VIP\n` +
    `ID: ${req.id}\n` +
    `User TG: ${tgUsername} (${ctxUser.from.id})\n` +
    `Nome: ${safeText(req.full_name) || '-'}\n` +
    `Email: ${safeText(req.email) || '-'}\n` +
    `Username bookmaker: ${safeText(req.username) || '-'}\n` +
    `Screenshot: ${req.screenshot_file_id ? '✅ presente' : '❌ mancante'}`;

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

      if (req.screenshot_file_id) {
        const caption = `📎 Screenshot deposito — ID richiesta ${req.id}`;
        try {
          await bot.telegram.sendPhoto(aid, req.screenshot_file_id, { caption });
        } catch {
          await bot.telegram.sendDocument(aid, req.screenshot_file_id, { caption });
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
// USER ACTIONS
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
  pendingSupport.set(ctx.from.id, true);
  await ctx.reply('🆘 Supporto\nScrivi qui il tuo problema (puoi inviare anche foto o file).');
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
// ADMIN ACTIONS
// ===============================
bot.action(/ADMIN_APPROVE_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

  const requestId = Number(ctx.match[1]);

  try {
    const req = await getRequest(requestId);
    await setStatus(requestId, 'APPROVED');

    const userTelegramId = await getUserTelegramIdByUserId(req.user_id);

    if (!PUBLIC_CHANNEL_ID) {
      return ctx.reply('⚠️ PUBLIC_CHANNEL_ID non configurato (Render → Environment).');
    }

    const channelIdNum = Number(PUBLIC_CHANNEL_ID);
    const channelId = Number.isFinite(channelIdNum) ? channelIdNum : PUBLIC_CHANNEL_ID;

    const invite = await bot.telegram.createChatInviteLink(channelId, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 60 * 60 * 24
    });

    await bot.telegram.sendMessage(
      userTelegramId,
      `✅ Richiesta approvata!\n\n🔐 Link personale (1 accesso):\n${invite.invite_link}\n\n⏳ Scade tra 24 ore.`
    );

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(`✅ Approvato (ID ${requestId}). Link personale inviato all’utente.`);
  } catch (e) {
    console.error('APPROVE ERROR:', e);
    await ctx.reply(`❌ Errore approvazione (ID ${requestId}): ${errToString(e)}`);
  }
});

bot.action(/ADMIN_REJECT_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

  const requestId = Number(ctx.match[1]);

  try {
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
    console.error('REJECT ERROR:', e);
    await ctx.reply(`❌ Errore rifiuto (ID ${requestId}): ${errToString(e)}`);
  }
});

bot.action(/ADMIN_ASK_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

  const requestId = Number(ctx.match[1]);

  try {
    const req = await getRequest(requestId);
    const userTelegramId = await getUserTelegramIdByUserId(req.user_id);

    setAdminState(ctx.from.id, { mode: 'ASK_INFO', requestId, userTelegramId });

    await ctx.reply(
      `💬 Ok. Scrivi ora il messaggio per l’utente (ID richiesta ${requestId}).\nPer annullare: /annulla`
    );
  } catch (e) {
    console.error('ASK ERROR:', e);
    await ctx.reply(`❌ Errore: ${errToString(e)}`);
  }
});

// ===============================
// ROUTER (ADMIN + USER + SUPPORT)
// ===============================
bot.on(['text', 'photo', 'document'], async (ctx) => {
  const tid = ctx.from.id;

  // ===== ADMIN: invia messaggio dopo "Chiedi info" =====
  if (isAdmin(ctx)) {
    const astate = getAdminState(tid);

    if (ctx.message?.text && ctx.message.text.trim().toLowerCase() === '/annulla') {
      clearAdminState(tid);
      return ctx.reply('✅ Operazione annullata.');
    }

    // ADMIN replying to a SUPPORT ticket: MUST reply to the bot message that had "🆘 SUPPORTO"
    // We'll also allow manual command: /support <userId> <message>
    if (ctx.message?.text?.startsWith('/support ')) {
      const parts = ctx.message.text.split(' ');
      const userId = Number(parts[1]);
      const msg = parts.slice(2).join(' ').trim();
      if (!userId || !msg) return ctx.reply('Uso: /support <userId> <messaggio>');
      try {
        await bot.telegram.sendMessage(userId, `🆘 Supporto (admin):\n${msg}`);
        supportThreads.set(userId, { adminId: tid });
        return ctx.reply('✅ Risposta supporto inviata.');
      } catch (e) {
        return ctx.reply(`❌ Errore invio supporto: ${errToString(e)}`);
      }
    }

    if (astate?.mode === 'ASK_INFO' && astate.userTelegramId) {
      const txt = (ctx.message?.text || '').trim();
      if (!txt) return ctx.reply('Scrivi un messaggio testuale (non foto/file) oppure /annulla.');

      try {
        await bot.telegram.sendMessage(
          astate.userTelegramId,
          `ℹ️ Messaggio dall’admin:\n${txt}\n\nRispondi qui in chat al bot.`
        );

        pendingReplies.set(astate.userTelegramId, { adminId: tid, requestId: astate.requestId });
        await updateRequest(astate.requestId, { admin_note: `Admin asked info: ${txt}` }).catch(() => {});

        clearAdminState(tid);
        return ctx.reply('✅ Messaggio inviato. Ora attendo la risposta dell’utente.');
      } catch (e) {
        console.error(e);
        clearAdminState(tid);
        return ctx.reply(`❌ Non sono riuscito a inviare il messaggio: ${errToString(e)}`);
      }
    }

    return;
  }

  // ===== USER: SUPPORT message (after pressing Support) =====
  if (pendingSupport.get(tid)) {
    pendingSupport.delete(tid);

    const uname = ctx.from.username ? `@${ctx.from.username}` : 'n/a';
    const header = `🆘 SUPPORTO\nUser: ${uname} (${ctx.from.id})\nScrivi una risposta facendo reply qui, oppure usa:\n/support ${ctx.from.id} <messaggio>`;

    for (const aid of adminIds) {
      try {
        await bot.telegram.sendMessage(aid, header);

        if (ctx.message.text) {
          await bot.telegram.sendMessage(aid, `Messaggio:\n${ctx.message.text.trim()}`);
        } else if (ctx.message.photo?.length) {
          const fid = ctx.message.photo[ctx.message.photo.length - 1].file_id;
          await bot.telegram.sendPhoto(aid, fid, { caption: 'Allegato supporto (foto)' });
        } else if (ctx.message.document?.file_id) {
          await bot.telegram.sendDocument(aid, ctx.message.document.file_id, { caption: 'Allegato supporto (file)' });
        }

        // memorizza “thread” supporto: quel user è gestito da quell’admin (ultimo)
        supportThreads.set(ctx.from.id, { adminId: aid });
      } catch (e) {
        console.error('Support notify failed:', e);
      }
    }

    await ctx.reply('✅ Richiesta supporto inviata. Ti risponderemo qui appena possibile.');
    return;
  }

  // ===== USER: if pending ASK_INFO reply, forward to the right admin =====
  const st = getUserState(tid);
  if (!st?.step) {
    const pending = pendingReplies.get(tid);
    if (pending?.adminId) {
      const adminId = pending.adminId;
      const requestId = pending.requestId;

      try {
        if (ctx.message.text) {
          const txt = ctx.message.text.trim();
          if (txt) {
            await bot.telegram.sendMessage(
              adminId,
              `💬 Risposta utente (ID richiesta ${requestId})\nUser: @${ctx.from.username || 'n/a'} (${ctx.from.id})\n\n${txt}`
            );
          }
        } else if (ctx.message.photo?.length) {
          const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
          await bot.telegram.sendPhoto(adminId, fileId, {
            caption: `📸 Foto dall’utente (ID richiesta ${requestId}) — @${ctx.from.username || 'n/a'} (${ctx.from.id})`
          });
        } else if (ctx.message.document?.file_id) {
          await bot.telegram.sendDocument(adminId, ctx.message.document.file_id, {
            caption: `📎 File dall’utente (ID richiesta ${requestId}) — @${ctx.from.username || 'n/a'} (${ctx.from.id})`
          });
        }

        await ctx.reply('✅ Messaggio ricevuto. Lo abbiamo inoltrato all’admin.');
        pendingReplies.delete(tid);
      } catch (e) {
        console.error('Forward to admin failed:', e);
        await ctx.reply('❌ Errore: non sono riuscito a inoltrare la risposta all’admin. Riprova.');
      }

      return;
    }

    // ===== USER: if admin answered via /support, user can just write and we forward to admin in that support thread (optional) =====
    // (Se vuoi anche il “supporto chat continua”, possiamo abilitarlo. Per ora lo lasciamo semplice.)
  }

  // ===== USER: VIP flow standard =====
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
        `Screenshot: ✅\n\n` +
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
// ADMIN REPLY TO SUPPORT (simple method)
// Admin just uses: /support <userId> <message>
// ===============================

// ===============================
// START BOT
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
