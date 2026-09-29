'use strict';

// 短網址 QR Code 面板：建立頁與管理後台共用。
// 依賴 /_assets/vendor/qr-code-styling-*.min.js（全域 QRCodeStyling）。
(() => {
  const NAVY = '#042f5e';
  const NAVY_LIGHT = '#1a5b9c';
  const YELLOW = '#ffe56d';
  const SIZE = 1024; // 下載用的解析度；畫面上用 CSS 縮小

  // 樣式都只用深色碼點配淺色底，避免反白 QR 有些掃描器讀不到
  const PRESETS = [
    {
      id: 'rounded', label: '圓角',
      dots: { type: 'rounded', gradient: { type: 'linear', rotation: Math.PI / 4, colorStops: [{ offset: 0, color: NAVY }, { offset: 1, color: NAVY_LIGHT }] } },
      square: { type: 'extra-rounded', color: NAVY },
      dot: { type: 'dot', color: NAVY },
      bg: '#ffffff',
    },
    {
      id: 'dots', label: '圓點',
      dots: { type: 'dots', color: NAVY },
      square: { type: 'extra-rounded', color: NAVY },
      dot: { type: 'dot', color: NAVY },
      bg: '#ffffff',
    },
    {
      id: 'classy', label: '流線',
      dots: { type: 'classy-rounded', color: NAVY },
      square: { type: 'extra-rounded', color: NAVY },
      dot: { type: 'square', color: NAVY },
      bg: '#ffffff',
    },
    {
      id: 'yellow', label: '品牌黃',
      dots: { type: 'rounded', color: NAVY },
      square: { type: 'extra-rounded', color: NAVY },
      dot: { type: 'dot', color: NAVY },
      bg: YELLOW, round: 0.06,
    },
    {
      id: 'square', label: '經典',
      dots: { type: 'square', color: NAVY },
      square: { type: 'square', color: NAVY },
      dot: { type: 'square', color: NAVY },
      bg: '#ffffff',
    },
  ];

  // mark.png 右上角有 ®，直接放進 QR 會很怪：
  // 用 canvas 裁成圓形並墊白底，® 在圓外會被裁掉。
  // 原圖 1000×1000，外圈圓心約 (500,500)、半徑約 465。
  let logoPromise = null;
  function roundLogo() {
    if (!logoPromise) {
      logoPromise = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const S = 512;
          const c = document.createElement('canvas');
          c.width = c.height = S;
          const ctx = c.getContext('2d');
          ctx.beginPath();
          ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.clip();
          const scale = (S / 2 - 18) / 465; // 外圈與白底之間留一點白邊
          const d = 1000 * scale;
          ctx.drawImage(img, (S - d) / 2, (S - d) / 2, d, d);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => resolve(null); // logo 載不到就出沒有 logo 的 QR
        img.src = '/_assets/brand/mark.png';
      });
    }
    return logoPromise;
  }

  function el(tag, props = {}, ...kids) {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
  }

  function mount(container) {
    let preset = PRESETS[0];
    let url = '';
    let name = 'qrcode';
    let qr = null;

    const preview = el('div', { className: 'qr-preview' });
    const styles = el('div', { className: 'qr-styles', role: 'radiogroup', ariaLabel: 'QR Code 樣式' });
    const logoToggle = el('input', { type: 'checkbox', checked: true });
    const pngBtn = el('button', { type: 'button', className: 'primary', textContent: '下載 PNG' });
    const svgBtn = el('button', { type: 'button', textContent: '下載 SVG' });
    const copyBtn = el('button', { type: 'button', textContent: '複製圖片' });
    const msg = el('p', { className: 'qr-msg muted' });

    for (const p of PRESETS) {
      const b = el('button', { type: 'button', className: 'qr-style', textContent: p.label });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(p === preset));
      b.dataset.id = p.id;
      b.addEventListener('click', () => {
        preset = p;
        for (const x of styles.children) x.setAttribute('aria-checked', String(x.dataset.id === p.id));
        draw();
      });
      styles.append(b);
    }
    logoToggle.addEventListener('change', draw);

    container.classList.add('qr-panel');
    container.replaceChildren(
      preview,
      styles,
      el('label', { className: 'check qr-logo' }, logoToggle, ' 中間放光房子創意 Logo'),
      el('div', { className: 'row qr-actions' }, pngBtn, svgBtn),
      el('div', { className: 'row qr-actions' }, copyBtn),
      msg,
    );

    async function options() {
      const image = logoToggle.checked ? await roundLogo() : null;
      return {
        width: SIZE,
        height: SIZE,
        // 預覽用 canvas：SVG 在瀏覽器縮小顯示時，相鄰碼點之間會出現白色細縫
        type: 'canvas',
        data: url,
        margin: Math.round(SIZE * 0.06),
        // 有 logo 要 H 級容錯（約 30%）才撐得住中間被蓋掉的區塊；
        // 沒 logo 用 M 級（約 15%）：lhc.tw 的短網址 ≤ 25 字元，M 與 L 一樣是 25×25 格，
        // 碼點比 H 級的 29×29 少，容錯又比 L 級多一倍
        qrOptions: { errorCorrectionLevel: image ? 'H' : 'M' },
        image: image || undefined,
        imageOptions: { hideBackgroundDots: true, imageSize: 0.38, margin: 6, saveAsBlob: true },
        dotsOptions: preset.dots,
        cornersSquareOptions: preset.square,
        cornersDotOptions: preset.dot,
        backgroundOptions: { color: preset.bg, round: preset.round || 0 },
      };
    }

    let seq = 0;
    async function draw() {
      if (!url) return;
      const mine = ++seq;
      const opts = await options();
      if (mine !== seq) return; // 使用者連點樣式時只畫最後一次
      if (!qr) {
        qr = new QRCodeStyling(opts);
        preview.replaceChildren();
        qr.append(preview);
      } else {
        qr.update(opts);
      }
    }

    function flash(text) {
      msg.textContent = text;
      clearTimeout(flash.t);
      flash.t = setTimeout(() => { msg.textContent = ''; }, 2000);
    }

    pngBtn.addEventListener('click', () => qr && qr.download({ name, extension: 'png' }));
    svgBtn.addEventListener('click', () => qr && qr.download({ name, extension: 'svg' }));
    copyBtn.addEventListener('click', async () => {
      if (!qr) return;
      try {
        // Safari 要求 ClipboardItem 在使用者手勢內同步建立，所以直接塞 Promise
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': qr.getRawData('png') })]);
        flash('已複製 QR Code 圖片');
      } catch {
        flash('這個瀏覽器不支援複製圖片，請改用下載');
      }
    });
    if (!window.ClipboardItem) copyBtn.hidden = true;

    return {
      // code 用來當下載檔名，例如 lhc-abc123.png
      show(shortUrl, code) {
        url = shortUrl;
        name = `lhc-${code || 'qrcode'}`;
        msg.textContent = '';
        draw();
      },
    };
  }

  window.LhcQR = { mount };
})();
