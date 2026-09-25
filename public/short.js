'use strict';

const $ = (id) => document.getElementById(id);

$('toggle-adv').addEventListener('click', () => {
  const adv = $('advanced');
  adv.hidden = !adv.hidden;
  $('toggle-adv').textContent = adv.hidden ? '進階設定' : '收起進階設定';
});

function formatLimits(data) {
  const parts = [];
  if (data.maxClicks > 0) parts.push(`可開啟 ${data.maxClicks} 次`);
  if (data.expiresAt) {
    parts.push(`${new Date(data.expiresAt).toLocaleString('zh-TW', { hour12: false })} 到期`);
  }
  return parts.length ? parts.join('・') : '不限次數、無到期日';
}

$('create').addEventListener('click', async () => {
  const btn = $('create');
  const url = $('url').value.trim();
  $('error').textContent = '';
  if (!url) {
    $('error').textContent = '請先輸入要縮短的網址';
    $('url').focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = '產生中…';
  try {
    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        code: $('code').value.trim() || undefined,
        maxClicks: Number($('max-clicks').value) || 0,
        expiresAt: $('expires').value || undefined,
        note: $('note').value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('error').textContent = data.error || `產生失敗（${res.status}）`;
      return;
    }
    $('short-url').textContent = data.shortUrl;
    $('short-url').href = data.shortUrl;
    $('target').textContent = `指向：${data.url}`;
    $('limits').textContent = formatLimits({
      maxClicks: Number($('max-clicks').value) || 0,
      expiresAt: $('expires').value || null,
    });
    $('form').hidden = true;
    $('done').hidden = false;
  } catch {
    $('error').textContent = '網路錯誤，請再試一次';
  } finally {
    btn.disabled = false;
    btn.textContent = '產生短網址';
  }
});

$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('create').click();
});

$('copy').addEventListener('click', async () => {
  const btn = $('copy');
  try {
    await navigator.clipboard.writeText($('short-url').textContent);
    btn.textContent = '已複製';
  } catch {
    btn.textContent = '複製失敗';
  }
  setTimeout(() => { btn.textContent = '複製網址'; }, 1500);
});

$('again').addEventListener('click', () => {
  for (const id of ['url', 'code', 'max-clicks', 'expires', 'note']) $(id).value = '';
  $('advanced').hidden = true;
  $('toggle-adv').textContent = '進階設定';
  $('done').hidden = true;
  $('form').hidden = false;
  $('url').focus();
});
