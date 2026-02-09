/**
 * Telegram VIP Access Bot (Background Worker - Render)
 *
 * ENV (Render -> Worker -> Environment):
 *  BOT_TOKEN
 *  SUPABASE_URL
 *  SUPABASE_SERVICE_ROLE_KEY
 *  ADMIN_TELEGRAM_IDS     es: "123,456"
 *  PUBLIC_CHANNEL_URL     es: https://t.me/+xxxx  (fallback static link)
 *  VIP_CHANNEL_ID         es: -1001234567890      (to generate one-time invite links)
 *
 * NOTE DB (hai già creato):
 * - public.user_invites: owner_full_name, owner_telegram_id
 * - public.referral_events + indici
 *
 * Se vuoi ANCHE salvare in user_invites:
 * - username tg del proprietario del codice
 * - lista (cache) dei nomi portati
 *
 * esegui anche:
 *
 * alter table public.user_invites
 *   add column if not exists owner_username text,
 *   add column if not exists referrals_names_cache text;
 */

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_TELEGRAM_IDS = '',
  PUBLIC_CHANNEL_URL = '',
  VIP_CHANNEL_ID = ''
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
// TESTI
// ===============================
const PRIZES_LIST = ['Amazon', 'Zalando', 'Airbnb', 'Apple', 'Spotify'];

const OPERATORS = [
  {
    key: 'EUROBET',
    label: 'Eurobet',
    link: 'https://record.betpartners.it/_Klv9utJ3bqpKqXDxdQZqW2Nd7ZgqdRLk/1/'
  },
  {
    key: 'BWIN',
    label: 'bwin',
    link: 'https://www.bwin.it/it/engage/lan/s/p/sports/accaboost?wm=5596580'
  },
  {
    key: 'BETSSON',
    label: 'Betsson',
    link: 'https://record.betsson.it/_dYA2EWAR45qw8pi7H3I6R2Nd7ZgqdRLk/1/'
  },
  {
    key: 'STARCASINO',
    label: 'Starcasino',
    link: 'https://record.starcasino.it/_dYA2EWAR45rPSO5RLscKcGNd7ZgqdRLk/1/'
  }
];

function introMessage() {
  return `🔥 Richiesta accesso VIP + Premi 🔥

🔍 Cosa facciamo nel VIP
• Scansioniamo tutti i bookmakers ogni giorno per trovare errori di quota dei bookmakers
• Postiamo schedine singole e doppie pronte 
• Migliori bonus sport e casino 

🎁 Invita amici = guadagni buoni regalo
Amazon • Zalando • Airbnb • Apple • Spotify
10€ per ogni persona che porti.
5 amici = 50€ in buoni regalo.

🏁COME PARTECIPARE
1️⃣ Registrati da UNO dei link sotto
• Eurobet: https://record.betpartners.it/_Klv9utJ3bqpKqXDxdQZqW2Nd7ZgqdRLk/1/
• bwin: https://www.bwin.it/it/engage/lan/s/p/sports/accaboost?wm=5596580
• Betsson: https://record.betsson.it/_dYA2EWAR45qw8pi7H3I6R2Nd7ZgqdRLk/1/
• Starcasino: https://record.starcasino.it/_dYA2EWAR45rPSO5RLscKcGNd7ZgqdRLk/1/
2️⃣ Effettua un deposito di almeno 10 euro
3️⃣ Clicca qui sotto INVIA RICHIESTA per mandare i dati del deposito appena effettuato

⏱️ Verifica: entro 72 ore.
✅ Se la richiesta viene approvata, riceverai il link per entrare nel canale VIP.`;
}


function inviteExplanationText(inviteCode) {
  return (
    `🎟️ Il tuo Codice Invito: **${inviteCode}**\n\n` +
    `✅ Portando persone nel canale tramite il tuo codice, puoi ottenere premi.\n\n` +
    `🎁 Premio: **40€** in buoni regalo (a scelta tra: ${PRIZES_LIST.join(', ')}).\n\n` +
    `📌 Regola:\n` +
    `- Ogni **4** persone registrate usando il tuo codice → **1 premio**\n` +
    `- 3 persone → 0 premi\n` +
    `- 4-7 persone → 1 premio\n` +
    `- 8-11 persone → 2 premi, ecc.\n\n` +
    `Quando raggiungi almeno 4, nel bot trovi “🎁 Premi Invito” per richiedere il buono che vuoi.`
  );
}

function operatorLabelFromKey(key) {
  const op = OPERATORS.find((o) => o.key === key);
  return op?.label || key;
}

// ===============================
// UI
// ===============================

// Pre-approvazione: SOLO richiesta + supporto (supporto solo qui)
const mainMenuPreApproval = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Invia richiesta', 'START_FLOW')],
  [Markup.button.callback('🆘 Supporto', 'SUPPORT')]
]);

// Post-approvazione: SOLO “Premi Invito”
const postApprovalMenu = Markup.inlineKeyboard([[Markup.button.callback('🎁 Premi Invito', 'REF_STATUS')]]);

const confirmMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📩 Invia', 'SUBMIT')],
  [Markup.button.callback('✏️ Modifica', 'EDIT')],
  [Markup.button.callback('↩️ Annulla', 'CANCEL_FLOW')]
]);

const skipInviteMenu = Markup.inlineKeyboard([[Markup.button.callback('⏭️ Salta (non ho un codice)', 'SKIP_INVITE')]]);

function prizesKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Amazon', 'PRIZE_Amazon'), Markup.button.callback('Zalando', 'PRIZE_Zalando')],
    [Markup.button.callback('Airbnb', 'PRIZE_Airbnb'), Markup.button.callback('Apple', 'PRIZE_Apple')],
    [Markup.button.callback('Spotify', 'PRIZE_Spotify')],
    [Markup.button.callback('↩️ Indietro', 'REF_STATUS')]
  ]);
}

function operatorsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Eurobet', 'OP_EUROBET'), Markup.button.callback('bwin', 'OP_BWIN')],
    [Markup.button.callback('Betsson', 'OP_BETSSON'), Markup.button.callback('Starcasino', 'OP_STARCASINO')]
  ]);
}

// ===============================
// STATE
// ===============================
const stateUser = new Map(); // telegram_user_id -> { step, requestId, userDbId }
const setUserState = (tid, data) => stateUser.set(tid, { ...(stateUser.get(tid) || {}), ...data });
const getUserState = (tid) => stateUser.get(tid) || {};
const clearUserState = (tid) => stateUser.delete(tid);

const stateAdmin = new Map(); // admin_id -> { mode:'ASK_INFO'|'SUPPORT_REPLY', requestId?, userTelegramId?, supportUserTelegramId? }
const setAdminState = (aid, data) => stateAdmin.set(aid, { ...(stateAdmin.get(aid) || {}), ...data });
const getAdminState = (aid) => stateAdmin.get(aid) || {};
const clearAdminState = (aid) => stateAdmin.delete(aid);

const pendingReplies = new Map(); // userTelegramId -> { adminId, requestId }
const pendingSupport = new Map(); // userTelegramId -> true

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

function getVipChannelId() {
  if (!VIP_CHANNEL_ID) return null;
  const n = Number(VIP_CHANNEL_ID);
  if (!Number.isFinite(n)) return null;
  return n;
}

function makeRandomCode(len = 8) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // senza O/0/I/1
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function ymKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
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

  const { data: existing, error: e1 } = await supabase.from('users').select('id').eq('telegram_id', u.id).maybeSingle();
  if (e1) throw e1;

  let userId = null;

  if (existing?.id) {
    const { error: e2 } = await supabase.from('users').update(payload).eq('id', existing.id);
    if (e2) throw e2;
    userId = existing.id;
  } else {
    const { data: inserted, error: e3 } = await supabase.from('users').insert(payload).select('id').single();
    if (e3) throw e3;
    userId = inserted.id;
  }

  // assicura che l'utente abbia SEMPRE un codice invito
  await ensureInviteCode(userId);

  // ✅ aggiorna owner_* su user_invites solo se colonne esistono
  try {
    const inv = await getInviteRowByUserId(userId);
    const patch = {};

    if ('owner_telegram_id' in inv) patch.owner_telegram_id = u.id;
    if ('owner_username' in inv) patch.owner_username = u.username || null;

    if (Object.keys(patch).length) {
      const { error: upErr } = await supabase.from('user_invites').update(patch).eq('user_id', userId);
      if (upErr) throw upErr;
    }
  } catch (e) {
    // non blocchiamo il flusso se mancano colonne
    console.error('upsertUser owner_* update failed:', errToString(e));
  }

  return userId;
}

async function ensureInviteCode(userId) {
  const { data: row, error } = await supabase.from('user_invites').select('id, code').eq('user_id', userId).maybeSingle();
  if (error) throw error;

  if (row?.code) return row.code;

  // genera e inserisci un codice unico
  for (let i = 0; i < 8; i++) {
    const code = `VIP-${makeRandomCode(8)}`;
    const { data: inserted, error: insErr } = await supabase
      .from('user_invites')
      .insert({ user_id: userId, code })
      .select('code')
      .single();

    if (!insErr && inserted?.code) return inserted.code;

    // se collisione su unique(code) -> riprova
    const msg = String(insErr?.message || '');
    if (!msg.toLowerCase().includes('duplicate') && !msg.toLowerCase().includes('unique')) {
      throw insErr;
    }
  }

  throw new Error('Impossibile generare un codice invito unico. Riprova.');
}

async function getInviteRowByUserId(userId) {
  const { data, error } = await supabase.from('user_invites').select('*').eq('user_id', userId).single();
  if (error) throw error;
  return data;
}

async function getInviteRowByCode(code) {
  const { data, error } = await supabase.from('user_invites').select('*').eq('code', code).maybeSingle();
  if (error) throw error;
  return data;
}

// ✅ NUOVO: check esistenza codice invito (lato utente)
async function validateInviteCodeExists(code) {
  const normalized = safeText(code || '').trim().toUpperCase();
  if (!normalized) return false;

  try {
    const row = await getInviteRowByCode(normalized);
    return !!row?.id;
  } catch (e) {
    console.error('validateInviteCodeExists failed:', errToString(e));
    return false;
  }
}

async function rotateMonthlyCountersIfNeeded(inviteRow) {
  // logica: se updated_at è di un mese precedente, allora:
  // - referrals_prev_month = referrals_month (valore vecchio)
  // - referrals_month = 0
  // (così il primo incremento del nuovo mese fa lo "switch")
  const updatedAt = inviteRow.updated_at || inviteRow.created_at;
  if (!updatedAt) return { rotated: false };

  const lastKey = ymKey(new Date(updatedAt));
  const nowKey = ymKey(new Date());

  if (lastKey === nowKey) return { rotated: false };

  const patch = {};
  if ('referrals_prev_month' in inviteRow && 'referrals_month' in inviteRow) {
    patch.referrals_prev_month = Number(inviteRow.referrals_month || 0);
    patch.referrals_month = 0;
  } else {
    // se non hai colonne, non facciamo nulla
    return { rotated: false };
  }

  const { error } = await supabase.from('user_invites').update(patch).eq('user_id', inviteRow.user_id);
  if (error) throw error;

  // aggiorna la riga in memoria per il calcolo successivo
  inviteRow.referrals_prev_month = patch.referrals_prev_month;
  inviteRow.referrals_month = patch.referrals_month;

  return { rotated: true };
}

async function incrementReferrals(inviterUserId, amount = 1) {
  const current = await getInviteRowByUserId(inviterUserId);

  // ✅ reset mensile automatico (al primo evento del nuovo mese)
  try {
    await rotateMonthlyCountersIfNeeded(current);
  } catch (e) {
    console.error('rotateMonthlyCountersIfNeeded failed:', errToString(e));
  }

  const next = Number(current.referrals_count || 0) + amount;

  // ✅ nuovi campi (se presenti in tabella)
  const nextTotal = Number(current.referrals_total || 0) + amount;
  const nextMonth = Number(current.referrals_month || 0) + amount;

  const patch = { referrals_count: next };

  if ('referrals_total' in current) patch.referrals_total = nextTotal;
  if ('referrals_month' in current) patch.referrals_month = nextMonth;

  const { error } = await supabase.from('user_invites').update(patch).eq('user_id', inviterUserId);
  if (error) throw error;

  return next;
}

async function decrementReferralsBy4(userId) {
  const current = await getInviteRowByUserId(userId);
  const count = Number(current.referrals_count || 0);
  if (count < 4) return { ok: false, count };

  const next = count - 4;
  const { error } = await supabase.from('user_invites').update({ referrals_count: next }).eq('user_id', userId);
  if (error) throw error;

  return { ok: true, count: next };
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

async function getUserById(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, telegram_id, first_name, last_name, username')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

function buildFullNameFromUserRow(u) {
  const fn = safeText(u.first_name || '').trim();
  const ln = safeText(u.last_name || '').trim();
  const full = `${fn} ${ln}`.trim();
  return full || null;
}

async function setStatus(requestId, status, admin_note = null) {
  const patch = { status };
  if (admin_note !== null) patch.admin_note = admin_note;
  if (status === 'SUBMITTED') patch.submitted_at = new Date().toISOString();
  await updateRequest(requestId, patch);
}

async function isVipApproved(userId) {
  const { data, error } = await supabase
    .from('cashback_requests')
    .select('id')
    .eq('user_id', userId)
    .eq('campaign', 'vip_access')
    .eq('status', 'APPROVED')
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Blocco “utente già approvato su stesso operatore”
 * (per evitare che ripresenti lo stesso account sullo stesso operatore).
 */
async function hasApprovedForOperator(userId, operatorLabel) {
  const { data, error } = await supabase
    .from('cashback_requests')
    .select('id')
    .eq('user_id', userId)
    .eq('campaign', 'vip_access')
    .eq('status', 'APPROVED')
    .eq('operator', operatorLabel)
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Sicurezza inviti:
 * - conta SOLO quando admin APPROVA
 * - stesso invitato può usare stesso codice su operatori diversi
 * - ma NON può essere contato 2 volte sullo stesso operatore
 *
 * Richiede tabella: public.referral_events con unique(inviter_user_id, invited_user_id, operator)
 */
async function applyInviteReferralIfAny(req) {
  const codeRaw = safeText(req.invite_code || '').trim();
  if (!codeRaw) return { applied: false, reason: 'no_code' };

  const code = codeRaw.toUpperCase();

  const inviter = await getInviteRowByCode(code);
  if (!inviter?.user_id) return { applied: false, reason: 'code_not_found' };

  // no self-referral
  if (Number(inviter.user_id) === Number(req.user_id)) return { applied: false, reason: 'self_ref' };

  const operator = safeText(req.operator || '').trim();
  if (!operator) return { applied: false, reason: 'no_operator' };

  // invitato (utente che ha usato il codice)
  const invitedUser = await getUserById(req.user_id);
  const invitedTelegramId = Number(invitedUser.telegram_id) || null;
  const invitedFullName = safeText(req.full_name || buildFullNameFromUserRow(invitedUser) || '').trim() || null;

  // ✅ registra evento referral (se già esiste per stesso operatore => non incrementa)
  const { data: ev, error: evErr } = await supabase
    .from('referral_events')
    .insert({
      inviter_user_id: inviter.user_id,
      invited_user_id: req.user_id,
      invited_full_name: invitedFullName,
      invited_telegram_id: invitedTelegramId,
      operator,
      request_id: req.id
    })
    .select('id')
    .single();

  if (evErr) {
    const msg = String(evErr.message || '').toLowerCase();
    if (msg.includes('duplicate') || msg.includes('unique')) {
      return { applied: false, reason: 'already_counted_same_operator' };
    }
    throw evErr;
  }

  // ✅ incrementa contatori SOLO se evento creato
  await incrementReferrals(inviter.user_id, 1);

  // ✅ aggiorna anche la cache nomi su user_invites (se colonna esiste)
  try {
    const invRow = await getInviteRowByUserId(inviter.user_id);
    if ('referrals_names_cache' in invRow) {
      const current = safeText(invRow.referrals_names_cache || '').trim();
      const nameToAdd = safeText(invitedFullName || '').trim();
      if (nameToAdd) {
        const list = current ? current.split(',').map((x) => x.trim()).filter(Boolean) : [];
        if (!list.some((x) => x.toLowerCase() === nameToAdd.toLowerCase())) {
          list.push(nameToAdd);
          const next = list.join(', ');
          const { error: eUp } = await supabase
            .from('user_invites')
            .update({ referrals_names_cache: next })
            .eq('user_id', inviter.user_id);
          if (eUp) throw eUp;
        }
      }
    }
  } catch (e) {
    console.error('referrals_names_cache update failed:', errToString(e));
  }

  // flag su request (debug)
  const note = safeText(req.admin_note || '');
  const newNote = (note ? note + '\n' : '') + `[INVITE_COUNTED] code=${code} op=${operator} ev=${ev.id}`;
  await updateRequest(req.id, { admin_note: newNote });

  return { applied: true, inviter_user_id: inviter.user_id, code, operator };
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
    `Operatore scelto: ${safeText(req.operator) || '-'}\n` +
    `ID operatore: ${safeText(req.operator_user_id) || '-'}\n` +
    `Codice invito inserito: ${safeText(req.invite_code) || '-'}\n` +
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
// SUPPORT
// ===============================
async function notifyAdminsSupportTicket(ctxUser) {
  const uname = ctxUser.from.username ? `@${ctxUser.from.username}` : 'n/a';
  const userTid = ctxUser.from.id;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('💬 Rispondi', `ADMIN_SUPPORT_REPLY_${userTid}`)]]);

  const header =
    `🆘 SUPPORTO\n` +
    `User: ${uname} (${userTid})\n` +
    `Premi “💬 Rispondi” per inviare una risposta a questo utente.`;

  for (const aid of adminIds) {
    try {
      await bot.telegram.sendMessage(aid, header, { reply_markup: keyboard.reply_markup });
    } catch (e) {
      console.error('Support header failed:', e);
    }
  }
}

// ===============================
// START
// ===============================
bot.start(async (ctx) => {
  try {
    await upsertUser(ctx);
    // Supporto SOLO qui
    await ctx.reply(introMessage(), mainMenuPreApproval);
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
    const userDbId = await upsertUser(ctx);
    const requestId = await createDraftRequest(userDbId, 'vip_access');

    setUserState(ctx.from.id, { step: 'FULL_NAME', requestId, userDbId });
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

// REF_STATUS: disponibile SOLO se approvato
bot.action('REF_STATUS', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const userDbId = await upsertUser(ctx);

    const approved = await isVipApproved(userDbId);
    if (!approved) {
      return ctx.reply('🔒 Funzione disponibile solo dopo l’approvazione dell’accesso VIP.');
    }

    const row = await getInviteRowByUserId(userDbId);
    const count = Number(row.referrals_count || 0);
    const available = Math.floor(count / 4);

    const txt =
      `🎟️ Il tuo Codice Invito: **${row.code}**\n\n` +
      `👥 Persone portate: **${count}**\n` +
      `🎁 Premi disponibili ora: **${available}**\n\n` +
      `📌 Ogni 4 persone = 1 premio da **40€** (Amazon, Zalando, Airbnb, Apple, Spotify).\n\n` +
      (available > 0
        ? `✅ Puoi richiedere un premio adesso: premi “🎁 Richiedi premio”.`
        : `❌ Non hai ancora abbastanza persone (ti servono almeno 4).`);

    const kb =
      available > 0
        ? Markup.inlineKeyboard([[Markup.button.callback('🎁 Richiedi premio', 'CLAIM_REWARD')]])
        : Markup.inlineKeyboard([]);

    const merged = Markup.inlineKeyboard([
      ...(kb.reply_markup.inline_keyboard || []),
      ...postApprovalMenu.reply_markup.inline_keyboard
    ]);

    await ctx.reply(txt, { reply_markup: merged.reply_markup, parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ Errore: ${errToString(e)}`);
  }
});

bot.action('CLAIM_REWARD', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const userDbId = await upsertUser(ctx);

    const approved = await isVipApproved(userDbId);
    if (!approved) {
      return ctx.reply('🔒 Funzione disponibile solo dopo l’approvazione dell’accesso VIP.');
    }

    const row = await getInviteRowByUserId(userDbId);
    const count = Number(row.referrals_count || 0);
    const available = Math.floor(count / 4);

    if (available <= 0) {
      return ctx.reply('❌ Non hai ancora 4 persone portate. Quando arrivi a 4 potrai richiedere un premio.', {
        reply_markup: postApprovalMenu.reply_markup
      });
    }

    const merged = Markup.inlineKeyboard([
      ...(prizesKeyboard().reply_markup.inline_keyboard || []),
      ...postApprovalMenu.reply_markup.inline_keyboard
    ]);

    await ctx.reply(
      `🎁 Scegli quale buono vuoi richiedere (valore **40€**).\n\n` + `Premi disponibili adesso: **${available}**`,
      { reply_markup: merged.reply_markup, parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ Errore: ${errToString(e)}`);
  }
});

bot.action(/PRIZE_(.+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const prize = String(ctx.match[1] || '').trim();
    if (!PRIZES_LIST.includes(prize)) return ctx.reply('Premio non valido.');

    const userDbId = await upsertUser(ctx);

    const approved = await isVipApproved(userDbId);
    if (!approved) {
      return ctx.reply('🔒 Funzione disponibile solo dopo l’approvazione dell’accesso VIP.');
    }

    const row = await getInviteRowByUserId(userDbId);
    const count = Number(row.referrals_count || 0);
    if (count < 4) return ctx.reply('❌ Non hai ancora 4 persone portate. Non puoi richiedere premi.');

    // scala 4 dal contatore (premi disponibili)
    const dec = await decrementReferralsBy4(userDbId);
    if (!dec.ok) return ctx.reply('❌ Non hai abbastanza persone (minimo 4).');

    // registra richiesta premio
    const { data: redemption, error: insErr } = await supabase
      .from('invite_redemptions')
      .insert({
        user_id: userDbId,
        prize_type: prize,
        note: 'Richiesta premio da bot',
        status: 'PENDING'
      })
      .select('id')
      .single();
    if (insErr) throw insErr;

    // notifica admin + bottone "Premio inviato"
    const adminKb = Markup.inlineKeyboard([[Markup.button.callback('✅ Premio inviato', `ADMIN_REWARD_SENT_${redemption.id}`)]]);

    for (const aid of adminIds) {
      try {
        await bot.telegram.sendMessage(
          aid,
          `🎁 RICHIESTA PREMIO INVITI\n` +
            `Premio: ${prize} (40€)\n` +
            `User TG: @${ctx.from.username || 'n/a'} (${ctx.from.id})\n` +
            `Codice invito: ${row.code}\n` +
            `Contatore rimasto (dopo scala -4): ${dec.count}\n` +
            `ID redemption: ${redemption.id}`,
          { reply_markup: adminKb.reply_markup }
        );
      } catch {}
    }

    const availableNow = Math.floor(dec.count / 4);

    await ctx.reply(
      `✅ Richiesta inviata!\n\n` +
        `🎁 Premio scelto: **${prize}** (40€)\n` +
        `⏱️ Ti contatteremo qui appena pronto.\n\n` +
        `👥 Persone portate ora: **${dec.count}**\n` +
        `🎁 Premi disponibili ora: **${availableNow}**`,
      { parse_mode: 'Markdown', reply_markup: postApprovalMenu.reply_markup }
    );
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ Errore: ${errToString(e)}`);
  }
});

// ✅ admin: segna premio inviato
bot.action(/ADMIN_REWARD_SENT_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

  const redemptionId = Number(ctx.match[1]);
  if (!Number.isFinite(redemptionId)) return ctx.reply('ID redemption non valido.');

  try {
    const { data: red, error: e1 } = await supabase
      .from('invite_redemptions')
      .update({ status: 'SENT', sent_at: new Date().toISOString() })
      .eq('id', redemptionId)
      .select('id,user_id,prize_type')
      .single();
    if (e1) throw e1;

    // notifica utente
    const userTelegramId = await getUserTelegramIdByUserId(red.user_id);
    await bot.telegram.sendMessage(
      userTelegramId,
      `🎁 Premio inviato!\n\n` + `Premio: ${safeText(red.prize_type)} (40€)\n` + `Grazie! ✅`,
      { reply_markup: postApprovalMenu.reply_markup }
    );

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(`✅ Segnato come inviato (redemption ${redemptionId}). Notifica inviata all’utente.`);
  } catch (e) {
    console.error('ADMIN_REWARD_SENT error:', e);
    await ctx.reply(`❌ Errore: ${errToString(e)}`);
  }
});

bot.action('CANCEL_FLOW', async (ctx) => {
  await ctx.answerCbQuery();
  clearUserState(ctx.from.id);
  await ctx.reply('Operazione annullata. Se vuoi ripartire, premi “✅ Invia richiesta”.');
});

bot.action('EDIT', async (ctx) => {
  await ctx.answerCbQuery();
  const st = getUserState(ctx.from.id);
  if (!st.requestId) return ctx.reply('Sessione scaduta. Riparti dal menu.');

  setUserState(ctx.from.id, { step: 'FULL_NAME' });
  await ctx.reply('Ok, reinserisci Nome e Cognome:');
});

bot.action('SKIP_INVITE', async (ctx) => {
  await ctx.answerCbQuery();
  const st = getUserState(ctx.from.id);
  if (!st?.requestId) return ctx.reply('Sessione scaduta. Riparti dal menu.');

  await updateRequest(st.requestId, { invite_code: null });
  setUserState(ctx.from.id, { step: 'SCREENSHOT' });
  await ctx.reply('Ok 👍\nOra invia lo screenshot del deposito (foto o file).');
});

// scelta operatore (con blocco se già approvato su quell’operatore)
bot.action(/OP_(EUROBET|BWIN|BETSSON|STARCASINO)/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const st = getUserState(ctx.from.id);
    if (!st?.requestId) return ctx.reply('Sessione scaduta. Riparti dal menu.');

    const key = String(ctx.match[1] || '').trim();
    const label = operatorLabelFromKey(key);

    // ✅ BLOCCO: se utente è già APPROVATO con lo stesso operatore, non può rifarlo
    const userDbId = st.userDbId || (await upsertUser(ctx));
    const already = await hasApprovedForOperator(userDbId, label);
    if (already) {
      return ctx.reply(
        `❌ Risulti già approvato su *${label}*.\n\n` +
          `Per sicurezza non puoi usare di nuovo lo stesso operatore.\n` +
          `Scegli uno degli altri operatori.`,
        { parse_mode: 'Markdown', reply_markup: operatorsKeyboard().reply_markup }
      );
    }

    await updateRequest(st.requestId, { operator: label });
    setUserState(ctx.from.id, { step: 'OPERATOR_ID', userDbId });

    await ctx.reply(
      `✅ Operatore selezionato: *${label}*\n\nOra inserisci il tuo *ID operatore* (quello del conto sul bookmaker):`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ Errore: ${errToString(e)}`);
  }
});

bot.action('SUBMIT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const st = getUserState(ctx.from.id);
    if (!st.requestId) return ctx.reply('Sessione scaduta. Riparti dal menu.');

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
// ADMIN ACTIONS (VIP)
// ===============================
bot.action(/ADMIN_APPROVE_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

  const requestId = Number(ctx.match[1]);

  try {
    const req = await getRequest(requestId);

    await setStatus(requestId, 'APPROVED');

    const userTelegramId = await getUserTelegramIdByUserId(req.user_id);

    // link canale
    let inviteLink = PUBLIC_CHANNEL_URL;
    const vipChatId = getVipChannelId();
    if (vipChatId) {
      const invite = await bot.telegram.createChatInviteLink(vipChatId, {
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 60 * 60 * 24
      });
      inviteLink = invite.invite_link;
    }
    if (!inviteLink) {
      return ctx.reply('⚠️ Manca PUBLIC_CHANNEL_URL e/o VIP_CHANNEL_ID (Render → Environment).');
    }

    // codice invito utente
    const userInvite = await ensureInviteCode(req.user_id);

    // ✅ CONFERMA: i contatori referral aumentano SOLO QUI (APPROVAZIONE ADMIN)
    const res = await applyInviteReferralIfAny(req).catch((e) => {
      console.error('applyInviteReferralIfAny error:', e);
      return { applied: false, reason: 'error' };
    });

    if (res?.reason === 'already_counted_same_operator') {
      await ctx.reply('⚠️ Nota: referral NON contato (utente già contato su questo operatore per questo inviter).');
    }

    await bot.telegram.sendMessage(
      userTelegramId,
      `✅ Richiesta approvata!\n\n` +
        `🔐 Link per entrare nel canale VIP:\n${inviteLink}\n\n` +
        (vipChatId ? `⏳ Valido 24 ore e per 1 solo accesso.\n\n` : `⚠️ Link statico (non monouso).\n\n`) +
        inviteExplanationText(userInvite),
      { parse_mode: 'Markdown', reply_markup: postApprovalMenu.reply_markup }
    );

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(`✅ Approvato (ID ${requestId}). Link + codice invito inviati all’utente.`);
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
      `💬 Scrivi ora il messaggio per l’utente (ID richiesta ${requestId}).\n` +
        `Poi la PRIMA risposta dell’utente verrà inoltrata qui.\n\n` +
        `Per annullare: /annulla`
    );
  } catch (e) {
    console.error('ASK ERROR:', e);
    await ctx.reply(`❌ Errore: ${errToString(e)}`);
  }
});

// ===============================
// ADMIN ACTIONS (SUPPORT)
// ===============================
bot.action(/ADMIN_SUPPORT_REPLY_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Non autorizzato.');

  const userTid = Number(ctx.match[1]);
  if (!Number.isFinite(userTid)) return ctx.reply('ID utente non valido.');

  setAdminState(ctx.from.id, { mode: 'SUPPORT_REPLY', supportUserTelegramId: userTid });

  await ctx.reply(
    `🆘 Supporto — Risposta per user (${userTid})\nScrivi qui la risposta (testo/foto/file).\nPer annullare: /annulla`,
    {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Scrivi la risposta da inviare all’utente...'
      }
    }
  );
});

// ===============================
// ROUTER (ADMIN + USER)
// ===============================
bot.on(['text', 'photo', 'document'], async (ctx) => {
  const tid = ctx.from.id;

  // ===== ADMIN routing =====
  if (isAdmin(ctx)) {
    const astate = getAdminState(tid);

    if (ctx.message?.text && ctx.message.text.trim().toLowerCase() === '/annulla') {
      clearAdminState(tid);
      return ctx.reply('✅ Operazione annullata.');
    }

    // Admin reply to SUPPORT
    if (astate?.mode === 'SUPPORT_REPLY' && astate.supportUserTelegramId) {
      const target = astate.supportUserTelegramId;
      try {
        if (ctx.message.text) {
          const txt = ctx.message.text.trim();
          if (!txt) return ctx.reply('Scrivi un testo (o invia foto/file), oppure /annulla.');
          await bot.telegram.sendMessage(target, `🆘 Supporto (admin):\n${txt}`);
        } else if (ctx.message.photo?.length) {
          const fid = ctx.message.photo[ctx.message.photo.length - 1].file_id;
          await bot.telegram.sendPhoto(target, fid, { caption: '🆘 Supporto (admin)' });
        } else if (ctx.message.document?.file_id) {
          await bot.telegram.sendDocument(target, ctx.message.document.file_id, { caption: '🆘 Supporto (admin)' });
        }

        clearAdminState(tid);
        return ctx.reply('✅ Risposta supporto inviata all’utente.');
      } catch (e) {
        console.error('Support reply send error:', e);
        clearAdminState(tid);
        return ctx.reply(`❌ Errore invio supporto: ${errToString(e)}`);
      }
    }

    // Admin "Chiedi info"
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

  // ===== USER: support ticket message =====
  if (pendingSupport.get(tid)) {
    pendingSupport.delete(tid);

    await notifyAdminsSupportTicket(ctx);

    for (const aid of adminIds) {
      try {
        if (ctx.message.text) {
          await bot.telegram.sendMessage(aid, `Messaggio supporto:\n${ctx.message.text.trim()}`);
        } else if (ctx.message.photo?.length) {
          const fid = ctx.message.photo[ctx.message.photo.length - 1].file_id;
          await bot.telegram.sendPhoto(aid, fid, { caption: 'Allegato supporto (foto)' });
        } else if (ctx.message.document?.file_id) {
          await bot.telegram.sendDocument(aid, ctx.message.document.file_id, { caption: 'Allegato supporto (file)' });
        }
      } catch (e) {
        console.error('Support content forward failed:', e);
      }
    }

    await ctx.reply('✅ Richiesta supporto inviata. Ti risponderemo qui appena possibile.');
    return;
  }

  // ===== USER: pending reply to "Chiedi info" =====
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
  }

  // ===== USER: VIP flow =====
  if (!st.step || !st.requestId) return;

  try {
    const requireText = async (msg) => {
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      return true;
    };

    if (st.step === 'FULL_NAME') {
      if (!ctx.message.text) return requireText('❗️Inserisci *solo testo*: Nome e Cognome (niente foto/file).');
      const fullName = ctx.message.text.trim();
      if (fullName.length < 3) return ctx.reply('Nome non valido. Reinserisci Nome e Cognome:');

      await updateRequest(st.requestId, { full_name: fullName });

      // ✅ salva nome anche in user_invites (owner_full_name) se colonna esiste
      try {
        const inv = await getInviteRowByUserId(st.userDbId);
        if ('owner_full_name' in inv) {
          const { error: eUp } = await supabase
            .from('user_invites')
            .update({ owner_full_name: fullName })
            .eq('user_id', st.userDbId);
          if (eUp) throw eUp;
        }
      } catch (e) {
        console.error('owner_full_name update failed:', errToString(e));
      }

      setUserState(tid, { step: 'OPERATOR' });
      return ctx.reply('Seleziona l’operatore scelto:', operatorsKeyboard());
    }

    if (st.step === 'OPERATOR_ID') {
      if (!ctx.message.text) return requireText('❗️Inserisci *solo testo*: il tuo ID operatore (niente foto/file).');
      const opId = ctx.message.text.trim();
      if (opId.length < 2) return ctx.reply('Valore non valido. Reinserisci il tuo ID operatore:');

      await updateRequest(st.requestId, { operator_user_id: opId });

      setUserState(tid, { step: 'INVITE_CODE' });
      return ctx.reply(
        '🎟️ Hai un *Codice Invito*?\n\nSe ce l’hai, scrivilo adesso.\nAltrimenti premi “Salta”.',
        { parse_mode: 'Markdown', reply_markup: skipInviteMenu.reply_markup }
      );
    }

    if (st.step === 'INVITE_CODE') {
      if (!ctx.message.text) return requireText('❗️Inserisci *solo testo*: Codice Invito, oppure premi “Salta”.');
      const code = ctx.message.text.trim();
      if (code.length < 4) {
        return ctx.reply('Codice troppo corto. Reinserisci oppure premi “Salta”.', {
          reply_markup: skipInviteMenu.reply_markup
        });
      }

      // ✅ NUOVO CONTROLLO: verifica che il codice esista davvero
      const normalized = code.toUpperCase();
      const exists = await validateInviteCodeExists(normalized);
      if (!exists) {
        return ctx.reply('❌ Codice invito errato. Controlla che sia corretto.', {
          reply_markup: skipInviteMenu.reply_markup
        });
      }

      await updateRequest(st.requestId, { invite_code: normalized });
      setUserState(tid, { step: 'SCREENSHOT' });
      return ctx.reply('Perfetto ✅\nOra invia lo screenshot del deposito (foto o file).');
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
        return ctx.reply('❗️In questo step devi inviare *uno screenshot* (foto o file).', { parse_mode: 'Markdown' });
      }

      await updateRequest(st.requestId, { screenshot_file_id: fileId, screenshot_mime: mime });

      const req = await getRequest(st.requestId);
      const summary =
        `📋 Riepilogo richiesta\n` +
        `Nome: ${safeText(req.full_name)}\n` +
        `Operatore scelto: ${safeText(req.operator) || '-'}\n` +
        `ID operatore: ${safeText(req.operator_user_id) || '-'}\n` +
        `Codice invito: ${safeText(req.invite_code) || '-'}\n` +
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
    await ctx.reply('Errore durante la compilazione. Riprova dal menu.');
    clearUserState(tid);
  }
});

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
