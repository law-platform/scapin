// 検索ページから開かれたとき（?q=…）は、本文中の検索語を強調し、該当のカード（#pN）か最初の該当箇所へ移る
//   照合は query.js（検索ページと同じ）。段落ごとに照合するので、段落をまたぐフレーズは強調しない
(() => {
  const q = new URLSearchParams(location.search).get('q');
  const Q = window.ScapinQuery;
  const root = document.querySelector('.scapin');
  if (!q || !Q || !root) return;
  const query = Q.parse(q);
  if (query.empty) return;
  // 段落（または欄）ごとに文字列をまとめる。<br> の前後は改行でつなぐ
  const blocks = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest('.entry-meta')) continue;
    const b = node.parentElement.closest('p, .s-label, .s-value, article');
    if (!blocks.has(b)) blocks.set(b, []);
    blocks.get(b).push(node);
  }
  for (const nodes of blocks.values()) {
    const text = nodes.map((n) => n.nodeValue).join('\n');
    const ranges = Q.evaluate(Q.tokenize(Q.norm(text)), query, false);
    if (!ranges.length) continue;
    let offset = 0;
    for (const node of nodes) {
      const v = node.nodeValue;
      const start = offset;
      offset += v.length + 1;
      const mine = ranges.filter(([a, b]) => a < start + v.length && b > start);
      if (!mine.length) continue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const [a, b] of mine) {
        const s = Math.max(0, a - start);
        const e = Math.min(v.length, b - start);
        frag.append(v.slice(pos, s));
        const m = document.createElement('mark');
        m.textContent = v.slice(s, e);
        frag.append(m);
        pos = e;
      }
      frag.append(v.slice(pos));
      node.replaceWith(frag);
    }
  }
  const target = location.hash && document.getElementById(location.hash.slice(1));
  const first = (target && target.querySelector('mark')) || root.querySelector('mark');
  if (first) first.scrollIntoView({ block: 'center' });
})();

// 原本画像ビューア：国立国会図書館デジタルコレクションの IIIF 画像を本文の横（狭い画面では下）に表示する
//   各カードの data-pid / data-frame が資料とコマを指す。コマの一覧は IIIF のマニフェストから取る
(() => {
  const OSD_URL = 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/5.0.1/openseadragon.min.js';
  const STORE_KEY = 'scapin-viewer-open';
  const card = document.querySelector('.part[data-pid]');
  if (!card) return;
  const pid = card.dataset.pid;
  const startFrame = Number(card.dataset.frame) || 1;

  const manifestUrl = `https://dl.ndl.go.jp/api/iiif/${pid}/manifest.json`;
  const ndlPage = (frame) => `https://dl.ndl.go.jp/pid/${pid}/1/${frame}`;
  const store = {
    get() { try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; } },
    set(v) { try { localStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch { /* 保存できなくても動作には影響しない */ } },
  };

  // ── 画面部品 ──
  const panel = document.createElement('aside');
  panel.id = 'viewer';
  panel.hidden = true;
  panel.setAttribute('aria-label', '原本画像');
  panel.innerHTML = `
    <div class="viewer-bar">
      <button type="button" data-act="prev" title="前のコマ">‹</button>
      <span class="label"></span>
      <button type="button" data-act="next" title="次のコマ">›</button>
      <span class="spacer"></span>
      <button type="button" data-act="home" title="全体を表示">全体</button>
      <button type="button" data-act="in" title="拡大">＋</button>
      <button type="button" data-act="out" title="縮小">－</button>
      <a class="ndl" target="_blank" rel="noopener">NDL →</a>
      <button type="button" data-act="close" title="閉じる">×</button>
    </div>
    <div id="viewer-canvas"><div class="viewer-msg"></div></div>`;
  document.body.appendChild(panel);
  const label = panel.querySelector('.label');
  const ndlLink = panel.querySelector('.ndl');
  const msg = panel.querySelector('.viewer-msg');

  let osd = null;
  let osdLoading = null;
  let images = null;       // コマごとの IIIF 画像の info.json
  let imagesLoading = null;
  let frame = startFrame;

  function loadScript() {
    if (window.OpenSeadragon) return Promise.resolve();
    osdLoading ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = OSD_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error('OpenSeadragon を読み込めませんでした'));
      document.head.appendChild(s);
    });
    return osdLoading;
  }

  function loadImages() {
    imagesLoading ??= fetch(manifestUrl)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((m) => {
        images = m.sequences[0].canvases.map((c) => {
          const svc = c.images[0].resource.service;
          return `${(Array.isArray(svc) ? svc[0] : svc)['@id']}/info.json`;
        });
      })
      .catch(() => { throw new Error('原本画像の一覧を読み込めませんでした'); });
    return imagesLoading;
  }

  async function show(n) {
    msg.textContent = '読み込み中…';
    try {
      await Promise.all([loadScript(), loadImages()]);
    } catch (e) {
      msg.textContent = e.message;
      return;
    }
    frame = Math.min(Math.max(1, n), images.length);
    label.textContent = `コマ ${frame} / ${images.length}`;
    ndlLink.href = ndlPage(frame);
    if (!osd) {
      osd = OpenSeadragon({
        element: document.getElementById('viewer-canvas'),
        showNavigationControl: false,
        gestureSettingsMouse: { clickToZoom: false },
        visibilityRatio: 0.5,
        minZoomImageRatio: 0.5,
        animationTime: 0.4,
      });
      osd.addHandler('open', () => { msg.textContent = ''; });
      osd.addHandler('open-failed', () => { msg.textContent = '画像を読み込めませんでした'; });
    }
    osd.open(images[frame - 1]);
  }

  function open(n) {
    panel.hidden = false;
    document.body.classList.add('viewer-open');
    store.set(true);
    show(n ?? frame);
  }

  function close() {
    panel.hidden = true;
    document.body.classList.remove('viewer-open');
    store.set(false);
  }

  // ── 操作 ──
  panel.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    const vp = osd?.viewport;
    switch (act) {
      case 'prev': show(frame - 1); break;
      case 'next': show(frame + 1); break;
      case 'close': close(); break;
      case 'home': vp?.goHome(); break;
      case 'in': vp?.zoomBy(1.5); break;
      case 'out': vp?.zoomBy(1 / 1.5); break;
    }
  });

  document.addEventListener('click', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const src = e.target.closest('.part .source');
    if (!src) return;
    e.preventDefault();
    open(startFrame);
  });

  // 前のページで開いていたら、このページでも開く
  if (store.get()) open();
})();
