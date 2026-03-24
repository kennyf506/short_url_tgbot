require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const crypto = require('crypto'); // 產生隨機短碼必須引入 crypto

console.log('啟動縮網址機器人中...');

// ==========================================
// 🔗 1. 初始化資料庫連線 (指向 lhc_short)
// ==========================================
const shortpool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'lhc_short', 
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==========================================
// 🤖 2. 初始化 Telegram 機器人
// ==========================================
const bot = new TelegramBot(process.env.SHORT_BOT_TOKEN, { polling: true });
console.log('✅ 縮網址機器人已成功啟動！');

// ==========================================
// 🔐 3. 權限檢查小幫手
// ==========================================
// 從 .env 讀取授權名單並轉換為數字陣列
const allowedIds = process.env.ALLOWED_TG_IDS 
    ? process.env.ALLOWED_TG_IDS.split(',').map(id => parseInt(id.trim(), 10)) 
    : [];

function checkAuth(msg) {
    const tgId = msg.from.id;
    if (allowedIds.includes(tgId)) {
        return true;
    } else {
        bot.sendMessage(msg.chat.id, '⛔ <b>權限不足</b>\n您沒有使用此縮網址機器人的權限。', { parse_mode: 'HTML' });
        return false;
    }
}

// ==========================================
// 🔗 4. 縮網址指令 (/short [url] [max_clicks] [on])
// ==========================================
bot.onText(/\/short\s+(\S+)(?:\s+(\d+))?(?:\s+(on|off))?/, async (msg, match) => {
    if (!checkAuth(msg)) return;
    
    const chatId = msg.chat.id;
    const tgId = msg.from.id;

    const originalUrl = match[1];
    const maxClicks = match[2] ? parseInt(match[2], 10) : 0; 
    
    // 預設為 false，只有明確打上 'on' 才會變成 true
    const notifySetting = (match[3] === 'on');

    // 產生 5 位數隨機短碼 (例如: 8f4a2)
    const shortCode = crypto.randomBytes(3).toString('hex').slice(0, 5);
    const shortUrl = `https://lhc.tw/${shortCode}`; // 加上 https:// 讓 TG 可以直接點擊

    let conn;
    try {
        conn = await shortpool.getConnection();
        await conn.query(
            `INSERT INTO short_links (short_code, original_url, creator_tg_id, max_clicks, notify_on_first_click) 
             VALUES (?, ?, ?, ?, ?)`,
            [shortCode, originalUrl, tgId, maxClicks, notifySetting]
        );

        let response = `🔗 <b>縮網址產生成功！</b>\n\n`;
        response += `📍 短網址：<code>${shortUrl}</code>\n`;
        response += `🎯 目標：${originalUrl}\n`;
        response += `📊 限制：${maxClicks === 0 ? '無限次' : maxClicks + ' 次'}\n`;
        response += `🔔 首次點擊通知：${notifySetting ? '✅ 開啟' : '❌ 關閉'}`;

        bot.sendMessage(chatId, response, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (err) {
        console.error('縮網址建立失敗:', err);
        bot.sendMessage(chatId, '❌ 建立縮網址時發生錯誤。');
    } finally {
        if (conn) conn.release();
    }
});

// ==========================================
// 📊 5. 查詢縮網址點擊次數 (/count [短網址或代碼])
// ==========================================
bot.onText(/\/count\s+(\S+)/, async (msg, match) => {
    if (!checkAuth(msg)) return;

    const chatId = msg.chat.id;
    let inputCode = match[1];

    // 聰明防呆：如果使用者貼的是完整網址 (包含 http 或 lhc.tw)，自動幫他切出最後的代碼
    if (inputCode.includes('/')) {
        const urlParts = inputCode.split('/');
        inputCode = urlParts[urlParts.length - 1]; 
    }

    let conn;
    try {
        conn = await shortpool.getConnection();
        const [rows] = await conn.query(
            "SELECT * FROM short_links WHERE short_code = ?", 
            [inputCode]
        );

        if (rows.length === 0) {
            return bot.sendMessage(chatId, `❌ 資料庫中找不到代碼為 <code>${inputCode}</code> 的紀錄喔！`, { parse_mode: 'HTML' });
        }

        const link = rows[0];
        
        // 處理最大次數的顯示
        const maxStr = link.max_clicks > 0 ? ` / ${link.max_clicks}` : '';
        
        // 將建立時間轉換為台灣時間
        const createDate = new Date(link.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

        let response = `📊 <b>縮網址點擊報告</b>\n\n`;
        response += `🔗 短網址：<code>lhc.tw/${link.short_code}</code>\n`;
        response += `🎯 目標：${link.original_url}\n`;
        response += `👆 點擊次數：<b>${link.current_clicks}</b>${maxStr} 次\n`;
        response += `🕒 建立時間：${createDate}`;

        bot.sendMessage(chatId, response, { parse_mode: 'HTML', disable_web_page_preview: true });

    } catch (err) {
        console.error('查詢點擊次數發生錯誤:', err);
        bot.sendMessage(chatId, '❌ 查詢時發生資料庫錯誤，請稍後再試。');
    } finally {
        if (conn) conn.release();
    }
});

// 處理例外錯誤，避免機器人崩潰
bot.on('polling_error', (error) => {
    console.error('Telegram Polling 錯誤:', error.code, error.message);
});