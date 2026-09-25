// 光房子創意縮網址服務
//   GET  /               → 轉到官網
//   GET  /short          → 公開建立頁
//   GET  /admin          → 管理頁（由 nginx 限制內網/VPN + Basic Auth）
//   POST /api/links      → 建立短網址（公開頁與 Telegram bot 共用這支）
//   /api/admin/*         → 管理用 API（同樣由 nginx 擋在前面）
//   GET  /:code          → 跳轉（必須註冊在最後，否則會吃掉上面的路徑）
require('dotenv').config({ quiet: true });
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const mysql = require('mysql2/promise');
const TelegramBot = require('node-telegram-bot-api');

const PORT = Number(process.env.PORT || 3006);
const SITE = process.env.SITE_ORIGIN || 'https://lhc.tw';
// 公開建立的頻率上限（每 IP 每小時）。0 = 不限制。
// 這不是權限限制，是避免有人用腳本灌爆資料表。
const CREATE_LIMIT = Number(process.env.CREATE_RATE_LIMIT ?? 30);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: 'lhc_short',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// 只負責單向發通知。polling 必須是 false —— 與 tg-bot 共用同一支 bot，
// 兩邊都開 polling 會互搶訊息。
const bot = new TelegramBot(process.env.TG_BOT_TOKEN, { polling: false });

// 有人從公開頁建立短網址時通知誰。未設定則不發送。
const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID || '';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 公開頁被使用時通知管理者。純粹是知會，失敗不能影響建立流程，
// 所以不 await、只記 log。
function notifyNewLink({ code, url, shortUrl, note, ip, maxClicks, expiresAt }) {
  if (!NOTIFY_CHAT_ID) return;
  const lines = [
    '🆕 <b>有人建立了新的短網址</b>',
    '',
    `📍 ${esc(shortUrl)}`,
    `🎯 ${esc(url)}`,
  ];
  if (note) lines.push(`📝 ${esc(note)}`);
  lines.push(`📊 ${maxClicks > 0 ? `限 ${maxClicks} 次` : '不限次數'}`);
  if (expiresAt) lines.push(`⏰ ${new Date(expiresAt).toLocaleString('zh-TW', { hour12: false })} 到期`);
  lines.push(`🌐 來源 IP：<code>${esc(ip || '未知')}</code>`);

  bot.sendMessage(NOTIFY_CHAT_ID, lines.join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }).catch((err) => console.error('新增通知發送失敗:', err.message));
}

// ---------- 短碼規則 ----------

// 這些路徑是服務自己要用的，不能被拿去當短碼
const RESERVED = new Set([
  'short', 'admin', 'api', 'assets', 'static', 'favicon', 'robots',
  'new', 'login', 'logout', 'health',
]);
const CODE_RE = /^[A-Za-z0-9_-]{3,10}$/;

function randomCode() {
  return crypto.randomBytes(3).toString('hex').slice(0, 5);
}

// ---------- 網址處理 ----------

// 沒有協定就補 https://。原本的 /short 指令沒做這件事，
// 導致資料庫裡存了 "google.com" 這種值 —— express 的 res.redirect 會把它
// 當成相對路徑，使用者被帶到 lhc.tw/google.com 然後看到 404。
function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: '請輸入網址' };

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;

  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { error: '網址格式不正確' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: '只接受 http 或 https 的網址' };
  }
  // 需要有像樣的主機名，擋掉 "g_maps" 這類根本不是網址的輸入
  if (!u.hostname.includes('.') || u.hostname.endsWith('.')) {
    return { error: '網址的網域看起來不正確' };
  }
  // 指回自己會變成無窮迴圈
  const self = new URL(SITE).hostname;
  if (u.hostname === self) return { error: '不能縮短本服務自己的網址' };

  return { url: u.toString() };
}

// ---------- 建立頻率限制 ----------

const attempts = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  if (CREATE_LIMIT <= 0) return false;
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= CREATE_LIMIT) {
    attempts.set(ip, recent);
    return true;
  }
  recent.push(now);
  attempts.set(ip, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of attempts) {
    const keep = list.filter((t) => now - t < 3600_000);
    if (keep.length) attempts.set(ip, keep);
    else attempts.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---------- 共用的建立邏輯 ----------

async function createLink({ url, code, maxClicks, notify, note, expiresAt, source, tgId, ip }) {
  const norm = normalizeUrl(url);
  if (norm.error) return { error: norm.error, status: 400 };

  let wanted = String(code || '').trim();
  if (wanted) {
    if (!CODE_RE.test(wanted)) {
      return { error: '自訂短碼只能用英數字、底線或連字號，長度 3–10', status: 400 };
    }
    if (RESERVED.has(wanted.toLowerCase())) {
      return { error: `「${wanted}」是保留字，請換一個`, status: 400 };
    }
  }

  const clicks = Number.isFinite(Number(maxClicks)) ? Math.max(0, Math.trunc(Number(maxClicks))) : 0;
  let expires = null;
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) return { error: '到期時間格式不正確', status: 400 };
    expires = d;
  }

  // 自訂短碼只試一次；隨機短碼撞到既有的就重抽
  for (let i = 0; i < (wanted ? 1 : 8); i++) {
    const candidate = wanted || randomCode();
    try {
      const [r] = await pool.query(
        `INSERT INTO short_links
           (short_code, original_url, creator_tg_id, source, creator_ip, note,
            max_clicks, notify_on_first_click, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [candidate, norm.url, tgId ?? null, source, ip || null, note || null,
          clicks, notify ? 1 : 0, expires],
      );
      return { id: r.insertId, code: candidate, url: norm.url, shortUrl: `${SITE}/${candidate}` };
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        if (wanted) return { error: `短碼「${wanted}」已經有人用了`, status: 409 };
        continue;
      }
      throw e;
    }
  }
  return { error: '短碼產生失敗，請再試一次', status: 500 };
}

// ---------- app ----------

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// 靜態資源放在 /_assets，不會與短碼路徑相撞
app.use('/_assets', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/short', (req, res) => res.sendFile(path.join(__dirname, 'public', 'short.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/links', async (req, res) => {
  const ip = req.ip;
  if (rateLimited(ip)) {
    return res.status(429).json({ error: '建立次數過多，請稍後再試' });
  }
  try {
    const out = await createLink({
      url: req.body.url,
      code: req.body.code,
      maxClicks: req.body.maxClicks,
      notify: false,            // 公開頁沒有收通知的對象
      note: req.body.note,
      expiresAt: req.body.expiresAt,
      source: 'web',
      tgId: null,
      ip,
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);

    // Telegram 用 /short 建立時 bot 自己會回報，不需要再通知一次
    notifyNewLink({
      code: out.code,
      url: out.url,
      shortUrl: out.shortUrl,
      note: req.body.note,
      ip,
      maxClicks: Number(req.body.maxClicks) || 0,
      expiresAt: req.body.expiresAt,
    });
  } catch (e) {
    console.error('建立短網址失敗:', e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// 給 tg-bot 呼叫。只綁在 127.0.0.1，nginx 不會轉發 /api/internal。
app.post('/api/internal/links', async (req, res) => {
  try {
    const out = await createLink({
      url: req.body.url,
      code: req.body.code,
      maxClicks: req.body.maxClicks,
      notify: req.body.notify,
      note: req.body.note,
      expiresAt: req.body.expiresAt,
      source: 'telegram',
      tgId: req.body.tgId,
      ip: null,
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);
  } catch (e) {
    console.error('建立短網址失敗(tg):', e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ---------- 管理 API（nginx 已在前面擋掉外部來源）----------

app.get('/api/admin/links', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, short_code, original_url, source, creator_tg_id, creator_ip, note,
              max_clicks, current_clicks, notify_on_first_click, is_notified,
              is_disabled, expires_at, created_at, updated_at
         FROM short_links ORDER BY id DESC`,
    );
    res.json({ links: rows, site: SITE });
  } catch (e) {
    console.error('讀取清單失敗:', e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.patch('/api/admin/links/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 不正確' });

  const sets = [];
  const vals = [];
  const b = req.body;

  if (b.original_url !== undefined) {
    const norm = normalizeUrl(b.original_url);
    if (norm.error) return res.status(400).json({ error: norm.error });
    sets.push('original_url = ?'); vals.push(norm.url);
  }
  if (b.short_code !== undefined) {
    const code = String(b.short_code).trim();
    if (!CODE_RE.test(code)) return res.status(400).json({ error: '短碼格式不正確（英數字/底線/連字號，3–10 字）' });
    if (RESERVED.has(code.toLowerCase())) return res.status(400).json({ error: `「${code}」是保留字` });
    sets.push('short_code = ?'); vals.push(code);
  }
  if (b.note !== undefined) { sets.push('note = ?'); vals.push(b.note || null); }
  if (b.max_clicks !== undefined) {
    sets.push('max_clicks = ?'); vals.push(Math.max(0, Math.trunc(Number(b.max_clicks) || 0)));
  }
  if (b.current_clicks !== undefined) {
    sets.push('current_clicks = ?'); vals.push(Math.max(0, Math.trunc(Number(b.current_clicks) || 0)));
  }
  if (b.is_disabled !== undefined) { sets.push('is_disabled = ?'); vals.push(b.is_disabled ? 1 : 0); }
  if (b.notify_on_first_click !== undefined) {
    sets.push('notify_on_first_click = ?'); vals.push(b.notify_on_first_click ? 1 : 0);
  }
  if (b.is_notified !== undefined) { sets.push('is_notified = ?'); vals.push(b.is_notified ? 1 : 0); }
  if (b.expires_at !== undefined) {
    if (!b.expires_at) { sets.push('expires_at = NULL'); }
    else {
      const d = new Date(b.expires_at);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: '到期時間格式不正確' });
      sets.push('expires_at = ?'); vals.push(d);
    }
  }
  if (!sets.length) return res.status(400).json({ error: '沒有要修改的欄位' });

  try {
    vals.push(id);
    const [r] = await pool.query(`UPDATE short_links SET ${sets.join(', ')} WHERE id = ?`, vals);
    if (!r.affectedRows) return res.status(404).json({ error: '找不到這筆連結' });
    const [[row]] = await pool.query('SELECT * FROM short_links WHERE id = ?', [id]);
    res.json({ link: row });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '這個短碼已經有人用了' });
    console.error('修改失敗:', e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/admin/links/bulk-delete', async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? req.body.ids.map(Number).filter(Number.isInteger)
    : [];
  if (!ids.length) return res.status(400).json({ error: '沒有選取任何連結' });
  try {
    const [r] = await pool.query('DELETE FROM short_links WHERE id IN (?)', [ids]);
    res.json({ deleted: r.affectedRows });
  } catch (e) {
    console.error('批次刪除失敗:', e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.delete('/api/admin/links/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 不正確' });
  try {
    const [r] = await pool.query('DELETE FROM short_links WHERE id = ?', [id]);
    if (!r.affectedRows) return res.status(404).json({ error: '找不到這筆連結' });
    res.json({ ok: true });
  } catch (e) {
    console.error('刪除失敗:', e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ---------- 跳轉 ----------

app.get('/', (req, res) => res.redirect(301, 'https://lighthousecc.tw'));

function stopPage(title, msg) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="icon" href="/_assets/brand/mark.png"><style>
:root{--navy:#042f5e;--yellow:#ffe56d;--bg:#f3f5f8;--card:#fff;--text:#1c2430;--muted:#6b7686;--border:#d9dee6}
@media(prefers-color-scheme:dark){:root{--bg:#0b1420;--card:#14202f;--text:#e6e9ee;--muted:#97a1b0;--border:#27364a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
padding:40px 16px;background:var(--bg);color:var(--text);
font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:36px 28px;
max-width:420px;width:100%;text-align:center}
.logo{width:100%;max-width:230px;aspect-ratio:4/1;margin:0 auto 22px;
background:url("/_assets/brand/lockup.png") center/contain no-repeat}
@media(prefers-color-scheme:dark){.logo{background-image:url("/_assets/brand/lockup-dark.png")}}
h1{margin:0 0 10px;font-size:21px}p{margin:0;color:var(--muted);font-size:15px;line-height:1.7}
a{display:inline-block;margin-top:24px;padding:9px 18px;border:1px solid var(--border);border-radius:999px;
color:var(--muted);text-decoration:none;font-size:13px}
</style></head><body><div class="card">
<div class="logo" role="img" aria-label="光房子創意"></div>
<h1>${title}</h1><p>${msg}</p>
<a href="https://lighthousecc.tw">前往光房子創意官網 →</a>
</div></body></html>`;
}

app.get('/:code', async (req, res) => {
  const code = req.params.code;
  if (code.includes('.')) return res.status(404).end();

  try {
    const [rows] = await pool.query('SELECT * FROM short_links WHERE short_code = ?', [code]);
    if (!rows.length) {
      return res.status(404).send(stopPage('連結無效', '這個短網址不存在，請確認網址是否輸入正確。'));
    }
    const link = rows[0];

    if (link.is_disabled) {
      return res.status(403).send(stopPage('連結已停用', '這個連結已被管理者關閉。'));
    }
    if (link.expires_at && new Date(link.expires_at) <= new Date()) {
      return res.status(403).send(stopPage('連結已過期', '這個連結已超過有效期限。'));
    }

    // 次數上限與累加合併成一個原子操作。
    // 原本是先 SELECT 檢查再 UPDATE，同時湧入的請求會讓實際點擊數超過上限。
    const [upd] = await pool.query(
      `UPDATE short_links SET current_clicks = current_clicks + 1
        WHERE id = ? AND (max_clicks = 0 OR current_clicks < max_clicks)`,
      [link.id],
    );
    if (!upd.affectedRows) {
      return res.status(403).send(stopPage('連結已失效', '這個連結已達到可開啟的次數上限。'));
    }

    if (link.notify_on_first_click && !link.is_notified && link.creator_tg_id) {
      await pool.query('UPDATE short_links SET is_notified = TRUE WHERE id = ?', [link.id]);
      bot.sendMessage(
        link.creator_tg_id,
        `🔥 <b>連結首開通知！</b>\n\n您的短網址 <code>lhc.tw/${code}</code> 剛剛被點開了！\n🎯 目標：${link.original_url}`,
        { parse_mode: 'HTML' },
      ).catch((err) => console.error('通知發送失敗:', err.message));
    }

    res.redirect(link.original_url);
  } catch (err) {
    console.error('跳轉發生錯誤:', err);
    res.status(500).send(stopPage('伺服器錯誤', '請稍後再試一次。'));
  }
});

app.listen(PORT, () => {
  console.log(`🚀 縮網址服務已啟動於 http://localhost:${PORT}`);
  console.log(`   公開建立頁 ${SITE}/short ・管理頁 ${SITE}/admin`);
  console.log(`   建立頻率上限：${CREATE_LIMIT > 0 ? `${CREATE_LIMIT} 次/小時/IP` : '未限制'}`);
});
