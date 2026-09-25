'use strict';

const $ = (id) => document.getElementById(id);
let links = [];
let site = 'https://lhc.tw';
let editing = null;
const selected = new Set();

function visibleLinks() {
  const q = $('search').value.trim().toLowerCase();
  return links.filter((l) => !q
    || l.short_code.toLowerCase().includes(q)
    || String(l.original_url).toLowerCase().includes(q)
    || String(l.note || '').toLowerCase().includes(q));
}

function syncBulk(shown = visibleLinks()) {
  $('bulk-bar').hidden = selected.size === 0;
  $('bulk-count').textContent = `已選取 ${selected.size} 筆`;
  const all = $('check-all');
  all.checked = shown.length > 0 && shown.every((l) => selected.has(l.id));
  all.indeterminate = selected.size > 0 && !all.checked;
}

function fmtDate(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString('zh-TW', { hour12: false, dateStyle: 'short', timeStyle: 'short' });
}

// datetime-local 需要本地時區的 YYYY-MM-DDTHH:mm，不能直接用 toISOString（那是 UTC）
function toLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusOf(l) {
  if (l.is_disabled) return { text: '已停用', cls: 'bad' };
  if (l.expires_at && new Date(l.expires_at) <= new Date()) return { text: '已過期', cls: 'bad' };
  if (l.max_clicks > 0 && l.current_clicks >= l.max_clicks) return { text: '次數用盡', cls: 'bad' };
  if (l.max_clicks > 0 && l.current_clicks >= l.max_clicks - 1) return { text: '剩最後一次', cls: 'warn' };
  return { text: '有效', cls: 'ok' };
}

function urlIssue(l) {
  return !/^https?:\/\//i.test(l.original_url);
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const shown = visibleLinks();

  $('rows').replaceChildren(...shown.map((l) => {
    const tr = document.createElement('tr');
    const st = statusOf(l);

    const pick = document.createElement('td');
    pick.className = 'pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(l.id);
    cb.setAttribute('aria-label', `選取 ${l.short_code}`);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(l.id); else selected.delete(l.id);
      syncBulk();
    });
    pick.append(cb);

    // 短碼不做成連結：點它會真的跳轉並累加點擊數，把自己的統計弄髒。
    // 要開的話點右邊的目標網址。
    const code = document.createElement('td');
    const cs = document.createElement('span');
    cs.className = 'code-text';
    cs.textContent = l.short_code;
    cs.title = `${site}/${l.short_code}（點目標網址可開啟，點這裡不會跳轉）`;
    code.append(cs);

    const url = document.createElement('td');
    url.className = 'url-cell';
    if (urlIssue(l)) {
      // 缺協定的網址不做成連結 —— 點了只會導到 lhc.tw 底下的相對路徑，
      // 給一個假的可點連結比純文字更誤導
      const us = document.createElement('span');
      us.textContent = l.original_url;
      const warn = document.createElement('span');
      warn.className = 'pill warn';
      warn.textContent = '缺 http(s)://';
      warn.title = '這個目標會被當成相對路徑，點了會 404';
      url.append(us, ' ', warn);
    } else {
      const ua = document.createElement('a');
      ua.href = l.original_url;
      ua.textContent = l.original_url;
      ua.target = '_blank';
      ua.rel = 'noopener noreferrer';
      ua.className = 'target-link';
      ua.title = '在新分頁開啟目標網址（不會累加點擊數）';
      url.append(ua);
    }

    const note = document.createElement('td');
    note.textContent = l.note || '—';
    note.className = 'muted';

    const clicks = document.createElement('td');
    clicks.className = 'num';
    clicks.textContent = l.max_clicks > 0 ? `${l.current_clicks} / ${l.max_clicks}` : String(l.current_clicks);

    const exp = document.createElement('td');
    exp.className = 'muted nowrap';
    exp.textContent = fmtDate(l.expires_at);

    const src = document.createElement('td');
    src.className = 'muted';
    src.textContent = l.source === 'web' ? '網頁' : l.source === 'admin' ? '管理' : 'Telegram';

    const status = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${st.cls}`;
    pill.textContent = st.text;
    status.append(pill);

    const act = document.createElement('td');
    act.className = 'nowrap';
    const edit = document.createElement('button');
    edit.textContent = '編輯';
    edit.addEventListener('click', () => openEdit(l));
    const del = document.createElement('button');
    del.textContent = '刪除';
    del.className = 'danger';
    del.addEventListener('click', () => remove(l));
    act.append(edit, ' ', del);

    tr.append(pick, code, url, note, clicks, exp, src, status, act);
    return tr;
  }));

  // 只保留還看得到的選取項目，避免搜尋過濾後刪到畫面上看不見的東西
  const visible = new Set(shown.map((l) => l.id));
  for (const id of [...selected]) if (!visible.has(id)) selected.delete(id);
  syncBulk(shown);

  const broken = links.filter(urlIssue).length;
  $('summary').textContent =
    `共 ${links.length} 筆${q ? `，符合搜尋 ${shown.length} 筆` : ''}`
    + (broken ? `・⚠️ ${broken} 筆目標網址缺少 http(s)://` : '');
}

async function load() {
  $('admin-error').textContent = '';
  try {
    const res = await fetch('/api/admin/links');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    links = data.links;
    site = data.site || site;
    render();
  } catch (e) {
    $('admin-error').textContent = `讀取失敗：${e.message}`;
  }
}

function openEdit(l) {
  editing = l;
  $('e-code').value = l.short_code;
  $('e-url').value = l.original_url;
  $('e-note').value = l.note || '';
  $('e-max').value = l.max_clicks || 0;
  $('e-cur').value = l.current_clicks || 0;
  $('e-exp').value = toLocalInput(l.expires_at);
  $('e-disabled').checked = !!l.is_disabled;
  $('e-notify').checked = !!l.notify_on_first_click;
  $('e-notified').checked = !!l.is_notified;
  $('edit-error').textContent = '';
  $('edit-dialog').showModal();
}

$('edit-cancel').addEventListener('click', () => $('edit-dialog').close());

$('edit-save').addEventListener('click', async () => {
  const btn = $('edit-save');
  btn.disabled = true;
  $('edit-error').textContent = '';
  try {
    const res = await fetch(`/api/admin/links/${editing.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        short_code: $('e-code').value.trim(),
        original_url: $('e-url').value.trim(),
        note: $('e-note').value.trim(),
        max_clicks: Number($('e-max').value) || 0,
        current_clicks: Number($('e-cur').value) || 0,
        expires_at: $('e-exp').value || null,
        is_disabled: $('e-disabled').checked,
        notify_on_first_click: $('e-notify').checked,
        is_notified: $('e-notified').checked,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('edit-error').textContent = data.error || `儲存失敗（${res.status}）`;
      return;
    }
    const i = links.findIndex((x) => x.id === editing.id);
    if (i >= 0) links[i] = data.link;
    render();
    $('edit-dialog').close();
  } catch {
    $('edit-error').textContent = '網路錯誤，請再試一次';
  } finally {
    btn.disabled = false;
  }
});

async function remove(l) {
  if (!confirm(`確定要刪除 ${l.short_code} 嗎？\n目標：${l.original_url}\n\n已經發出去的連結會立刻失效，且無法復原。`)) return;
  try {
    const res = await fetch(`/api/admin/links/${l.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      $('admin-error').textContent = d.error || `刪除失敗（${res.status}）`;
      return;
    }
    links = links.filter((x) => x.id !== l.id);
    render();
  } catch {
    $('admin-error').textContent = '網路錯誤，請再試一次';
  }
}

$('check-all').addEventListener('change', (e) => {
  const shown = visibleLinks();
  if (e.target.checked) shown.forEach((l) => selected.add(l.id));
  else shown.forEach((l) => selected.delete(l.id));
  render();
});

$('bulk-clear').addEventListener('click', () => { selected.clear(); render(); });

$('bulk-delete').addEventListener('click', async () => {
  const ids = [...selected];
  const preview = links.filter((l) => selected.has(l.id)).slice(0, 8)
    .map((l) => `  ${l.short_code} → ${l.original_url}`).join('\n');
  const more = ids.length > 8 ? `\n  …等共 ${ids.length} 筆` : '';
  if (!confirm(`確定要刪除這 ${ids.length} 筆連結嗎？\n\n${preview}${more}\n\n已經發出去的連結會立刻失效，且無法復原。`)) return;

  const btn = $('bulk-delete');
  btn.disabled = true;
  $('admin-error').textContent = '';
  try {
    const res = await fetch('/api/admin/links/bulk-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('admin-error').textContent = data.error || `刪除失敗（${res.status}）`;
      return;
    }
    links = links.filter((l) => !selected.has(l.id));
    selected.clear();
    render();
  } catch {
    $('admin-error').textContent = '網路錯誤，請再試一次';
  } finally {
    btn.disabled = false;
  }
});

$('search').addEventListener('input', render);
$('reload').addEventListener('click', load);
load();
