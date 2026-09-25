// 縮網址獨立化：新增公開建立所需的欄位
// - creator_tg_id 改為可空（網頁建立沒有 Telegram ID）
// - source       建立來源 web / telegram / admin
// - creator_ip   公開開放後追查濫用用
// - note         管理頁的備註
// - is_disabled  管理頁的停用開關（發現濫用時要能立刻關掉）
// - expires_at   時效性（原本只能限次數）
// - updated_at   最後修改時間
require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: 'lhc_short',
  });

  const [before] = await c.query('SHOW COLUMNS FROM short_links');
  const have = new Set(before.map((x) => x.Field));
  if (have.has('source')) {
    console.log('已經套用過，不重複執行');
    await c.end();
    return;
  }

  await c.query(`ALTER TABLE short_links
    MODIFY creator_tg_id BIGINT NULL,
    ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'telegram' AFTER creator_tg_id,
    ADD COLUMN creator_ip VARCHAR(45) NULL AFTER source,
    ADD COLUMN note VARCHAR(255) NULL AFTER creator_ip,
    ADD COLUMN is_disabled TINYINT(1) NOT NULL DEFAULT 0 AFTER note,
    ADD COLUMN expires_at DATETIME NULL AFTER is_disabled,
    ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP`);

  const [after] = await c.query('SHOW COLUMNS FROM short_links');
  const [[n]] = await c.query('SELECT COUNT(*) c FROM short_links');
  console.log('欄位:', after.map((x) => x.Field).join(', '));
  console.log('資料筆數(異動前為 23):', n.c);
  await c.end();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
