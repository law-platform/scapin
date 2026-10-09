// 検索ページ：本文の全文検索と、SCAPIN No.・Date・Subject・Department の詳細検索
//   search/meta.json          指令の一覧（番号順）と詳細検索の項目。最初に読み込み、詳細検索はこれだけで行う
//   search/idx/NNN.json       索引（単語 → それを含む指令の番号を差分で並べたもの）。検索語に必要なファイルだけ読み込む
//   search/text/<指令>.json   カードごとの本文。表示する指令の分だけ読み込み、該当箇所と前後の文脈を出す
//   見出しの振り分けの式は program/scapin_search.cs と同じ。検索語の解釈と照合は query.js
(() => {
  const BASE = 'search/';
  const DOCS_PER_BATCH = 100;   // 「さらに表示」1 回で出す件数
  const FETCH_PARALLEL = 12;    // 本文を同時に読み込む数
  const HITS_PER_DOC = 3;       // 1 件の中で文脈を出す箇所数
  const CONTEXT = 80;           // 文脈の前後の文字数

  const Q = window.ScapinQuery;
  const $ = (id) => document.getElementById(id);
  const form = $('sform');
  const fields = {
    q: $('fq'), no: $('fno'), dm: $('fdm'), y1: $('fy1'), m1: $('fm1'), d1: $('fd1'), y2: $('fy2'), m2: $('fm2'), d2: $('fd2'),
    s: $('fs'), file: $('ffile'), dept: $('fdept'), div: $('fdiv'), sort: $('fsort'),
  };
  const dateRow = document.querySelector('.date-row');
  const statusEl = $('fstatus');
  const results = $('results');
  const moreWrap = $('more-wrap');
  const moreBtn = $('more');

  let meta = null;
  let metaLoading = null;
  const shardCache = new Map();
  const textCache = new Map();
  let run = null;   // 実行中の検索（新しい検索が始まったら古い結果は捨てる）

  // 入力の誤り（メッセージをそのまま出す）
  class InputError extends Error {}

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function getJson(path) {
    const r = await fetch(BASE + path);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  // ── 指令の一覧と部局の選択肢 ──
  //   meta.docs: [ファイル名, SCAPIN 番号, 年月日, 件名, 部局の番号, File No.]
  function loadMeta() {
    metaLoading ??= getJson('meta.json').then((m) => {
      meta = m;
      meta.base = m.docs.map((d) => (d[1] ? parseInt(d[1], 10) : NaN));
      meta.isA = m.docs.map((d) => /-A/.test(d[1]));
      buildDepts();
    });
    return metaLoading;
  }

  // 種類（SCAPIN・SCAPIN-A のチェック。初期状態は両方）。URL では片方だけのとき t=s / t=a、どちらも外したとき t=none
  const seriesBoxes = { s: $('fts'), a: $('fta') };
  const getSeries = () => {
    const s = seriesBoxes.s.checked; const a = seriesBoxes.a.checked;
    return s && a ? 'all' : s ? 's' : a ? 'a' : 'none';
  };
  function setSeries(v) {
    seriesBoxes.s.checked = v === 'all' || v === 's';
    seriesBoxes.a.checked = v === 'all' || v === 'a';
  }
  function seriesTest(t) {
    if (t === 'all') return null;
    const a = t === 'a';
    return (i) => meta.isA[i] === a;
  }

  // 部局の鍵「課 (名称)//部 (名称)」を課ごとにまとめ、課のプルダウンを作る。部のプルダウンは課を選ぶと作る
  //   件数は選んでいる種類の中で数える。その種類に出てこない部局は出さない
  let sections = new Map();   // 課 → { total, subs: Map(部 → 件数) }
  function buildDepts() {
    const count = new Array(meta.depts.length).fill(0);
    const inSeries = seriesTest(getSeries());
    meta.docs.forEach((d, i) => { if (d[4] >= 0 && (!inSeries || inSeries(i))) count[d[4]]++; });
    sections = new Map();
    meta.depts.forEach((key, i) => {
      if (!count[i]) return;
      const [sec, ...rest] = key.split('//');
      if (!sections.has(sec)) sections.set(sec, { total: 0, subs: new Map() });
      const s = sections.get(sec);
      s.total += count[i];
      if (rest.length) { const sub = rest.join('//'); s.subs.set(sub, (s.subs.get(sub) || 0) + count[i]); }
    });
    sections = new Map([...sections].sort((a, b) => a[0].localeCompare(b[0])));
    let html = '<option value="">すべて</option>';
    for (const [sec, s] of sections) html += `<option value="${esc(sec)}">${esc(sec)}（${s.total}）</option>`;
    const cur = fields.dept.value;
    const curDiv = fields.div.value;
    fields.dept.innerHTML = html;
    fields.dept.value = cur;
    if (fields.dept.selectedIndex === -1) fields.dept.value = '';
    fillDivs(fields.dept.value === cur ? curDiv : '');
  }

  function fillDivs(cur = '') {
    const s = sections.get(fields.dept.value);
    let html = '<option value="">すべて</option>';
    if (s) for (const [sub, n] of [...s.subs].sort((a, b) => a[0].localeCompare(b[0]))) html += `<option value="${esc(sub)}">${esc(sub)}（${n}）</option>`;
    fields.div.innerHTML = html;
    fields.div.disabled = !s || !s.subs.size;
    fields.div.value = cur;
    if (fields.div.selectedIndex === -1) fields.div.value = '';
  }

  // ── 詳細検索の条件 ──
  // SCAPIN No.: 245（枝番 245/1 なども含む）、408/2、100-200、1, 5, 9、130-A（枝番も含む）、130-A/1
  //   -A の付かない番号は、種類で選んだもの（両方なら SCAPIN と SCAPIN-A の両方）の番号として扱う
  function parseNo(str) {
    const s = str.replace(/scapin[\s-]*/gi, '').replace(/\s*[-–―〜~～]\s*/g, '-').replace(/-a\b/gi, '-A').trim();
    if (!s) return null;
    const tests = [];
    for (const part of s.split(/[\s,，、;]+/).filter(Boolean)) {
      let m;
      if ((m = part.match(/^(\d+)$/))) { const n = +m[1]; tests.push((i) => meta.base[i] === n); }
      else if ((m = part.match(/^(\d+)\/(\d+)$/))) { const v = `${+m[1]}/${+m[2]}`; tests.push((i) => meta.docs[i][1] === v); }
      else if ((m = part.match(/^(\d+)-A$/))) { const n = +m[1]; tests.push((i) => meta.isA[i] && meta.base[i] === n); }
      else if ((m = part.match(/^(\d+)-A\/(\d+)$/))) { const v = `${+m[1]}-A/${+m[2]}`; tests.push((i) => meta.docs[i][1] === v); }
      else if ((m = part.match(/^(\d+)-(\d+)$/))) {
        const a = Math.min(+m[1], +m[2]); const b = Math.max(+m[1], +m[2]);
        tests.push((i) => meta.base[i] >= a && meta.base[i] <= b);
      }
      else throw new InputError(`SCAPIN No. の「${part}」を読み取れません`);
    }
    const test = (i) => tests.some((t) => t(i));
    test.hasA = /-A/.test(s);   // SCAPIN-A の番号を名指ししている
    return test;
  }

  // 年・月・日の欄 → その期間の [最初の日, 最後の日]（文字列で比べる）。年だけ、年と月だけでもよい
  function parseDate(y, m, d, label) {
    if (!y && !m && !d) return null;
    const num = (x) => x.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    [y, m, d] = [num(y), num(m), num(d)];
    if (!/^\d{2}(\d{2})?$/.test(y)) throw new InputError(`${label}の年を 1946 か 46 の形で入れてください`);
    if (y.length === 2) y = '19' + y;
    if (m && !(/^\d{1,2}$/.test(m) && +m >= 1 && +m <= 12)) throw new InputError(`${label}の月を 1〜12 で入れてください`);
    if (d && !(/^\d{1,2}$/.test(d) && +d >= 1 && +d <= 31)) throw new InputError(`${label}の日を 1〜31 で入れてください`);
    if (d && !m) throw new InputError(`${label}の日を指定するときは月も入れてください`);
    const p2 = (x) => String(+x).padStart(2, '0');
    if (d) { const s = `${y}-${p2(m)}-${p2(d)}`; return [s, s]; }
    if (m) return [`${y}-${p2(m)}-01`, `${y}-${p2(m)}-31`];
    return [`${y}-01-01`, `${y}-12-31`];
  }

  function dateTest(v) {
    if (v.dm === 'range') {
      const a = parseDate(v.y1, v.m1, v.d1, 'Date（期間の始め）');
      const b = parseDate(v.y2, v.m2, v.d2, 'Date（期間の終わり）');
      if (!a && !b) return null;
      return (i) => { const d = meta.docs[i][2]; return !!d && (!a || d >= a[0]) && (!b || d <= b[1]); };
    }
    const a = parseDate(v.y1, v.m1, v.d1, 'Date ');
    if (!a) return null;
    return (i) => { const d = meta.docs[i][2]; return !!d && d >= a[0] && d <= a[1]; };
  }

  // File No.: AG の後の番号と一致するもの。* を付けると前方一致（370* → 370、370.05 など）
  function fileTest(str) {
    const s = str.replace(/^\s*AG\s*/i, '').replace(/[\s()（）]/g, '').replace(/\.$/, '');
    if (!s) return null;
    if (s.endsWith('*')) { const p = s.slice(0, -1); return (i) => !!meta.docs[i][5] && meta.docs[i][5].startsWith(p); }
    return (i) => meta.docs[i][5] === s;
  }

  // Department: 課だけなら、その下の部も含む
  function deptTest(sec, div) {
    if (!sec) return null;
    const key = div ? `${sec}//${div}` : sec;
    return (i) => { const k = meta.depts[meta.docs[i][4]]; return !!k && (k === key || (!div && k.startsWith(sec + '//'))); };
  }

  // ── 索引 ──
  function shardOf(word) {
    const h = word.length === 1 ? word.charCodeAt(0) : word.charCodeAt(0) * 31 + word.charCodeAt(1);
    return h % meta.shards;
  }

  function shard(i) {
    if (!shardCache.has(i)) shardCache.set(i, getJson(`idx/${String(i).padStart(3, '0')}.json`));
    return shardCache.get(i);
  }

  function decode(deltas) {
    const out = new Array(deltas.length);
    let v = 0;
    for (let i = 0; i < deltas.length; i++) out[i] = v += deltas[i];
    return out;
  }

  function intersect(a, b) {
    const out = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) { out.push(a[i]); i++; j++; } else if (a[i] < b[j]) i++; else j++;
    }
    return out;
  }

  function union(lists) {
    const set = new Set();
    for (const l of lists) for (const x of l) set.add(x);
    return [...set].sort((a, b) => a - b);
  }

  // 単語を含む指令。前方一致なら、その語で始まる単語すべて（先頭 2 文字が同じ単語は同じファイルにある）
  async function postings(word, prefix) {
    const idx = await shard(shardOf(word));
    if (!prefix) return idx[word] ? decode(idx[word]) : [];
    return union(Object.keys(idx).filter((k) => k.startsWith(word)).map((k) => decode(idx[k])));
  }

  // item のすべての単語（単数形・複数形を含む）を含む指令（フレーズは語順を問わない候補）
  async function itemDocs(item) {
    const lists = await Promise.all(item.ws.map(async (w, j) => {
      if (!item.forms[j]) return postings(w, true);
      return union(await Promise.all([...item.forms[j]].map((f) => postings(f, false))));
    }));
    lists.sort((a, b) => a.length - b.length);
    return lists.reduce((c, l) => intersect(c, l));
  }

  // 全文検索の候補（AND は共通部分、OR は和、除外は 1 語のものだけ索引で引く。フレーズは本文で確かめる）
  async function textCandidates(query) {
    let c = null;
    for (const g of query.groups) {
      const docs = union(await Promise.all(g.map(itemDocs)));
      c = c ? intersect(c, docs) : docs;
      if (!c.length) return c;
    }
    if (!c) c = meta.docs.map((_, i) => i);
    for (const it of query.neg) {
      if (it.ws.length > 1) continue;
      const ex = new Set(await itemDocs(it));
      c = c.filter((i) => !ex.has(i));
    }
    return c;
  }

  // ── 本文の照合 ──
  function textOf(i) {
    const name = meta.docs[i][0];
    if (!textCache.has(name)) textCache.set(name, getJson(`text/${encodeURIComponent(name)}.json`).catch(() => []));
    return textCache.get(name);
  }

  // 指令の本文（カードの並び）が条件を満たすなら、カードごとの強調範囲 [{ no, text, ranges }] を返す
  function findHits(parts, query, verify) {
    const cards = parts.map(([no, text]) => ({ no, text, tokens: Q.tokenize(Q.norm(text)) }));
    if (verify && !Q.evaluate(cards.flatMap((c) => c.tokens), query)) return null;
    return cards.map((c) => ({ no: c.no, text: c.text, ranges: Q.evaluate(c.tokens, query, false) }));
  }

  // 範囲 r の前後の文脈（同じ段落の中だけ、単語の途中では切らない）
  function snippet(text, r, ranges) {
    const segStart = text.lastIndexOf('\n', r[0]) + 1;
    const nl = text.indexOf('\n', r[1]);
    const segEnd = nl === -1 ? text.length : nl;
    let s = Math.max(segStart, r[0] - CONTEXT);
    let e = Math.min(segEnd, r[1] + CONTEXT);
    if (s > segStart) { const sp = text.indexOf(' ', s); if (sp !== -1 && sp < r[0]) s = sp + 1; }
    if (e < segEnd) { const sp = text.lastIndexOf(' ', e); if (sp > r[1]) e = sp; }
    let html = s > segStart ? '… ' : '';
    let cur = s;
    for (const [a, b] of ranges) {
      if (b <= s || a >= e) continue;
      const a2 = Math.max(a, s);
      const b2 = Math.min(b, e);
      html += esc(text.slice(cur, a2)) + '<mark>' + esc(text.slice(a2, b2)) + '</mark>';
      cur = b2;
    }
    html += esc(text.slice(cur, e)) + (e < segEnd ? ' …' : '');
    return { html, end: e };
  }

  function highlight(text, query) {
    if (!query) return esc(text);
    const ranges = Q.evaluate(Q.tokenize(Q.norm(text)), query, false);
    let html = '';
    let cur = 0;
    for (const [a, b] of ranges) { html += esc(text.slice(cur, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; cur = b; }
    return html + esc(text.slice(cur));
  }

  function renderDoc(i, cards, r) {
    const [file, no, date, subject, deptNo, fileNo] = meta.docs[i];
    const href = `doc/${encodeURIComponent(file)}.html${r.v.q ? `?q=${encodeURIComponent(r.v.q)}` : ''}`;
    const dept = deptNo >= 0 ? meta.depts[deptNo].replace(/\/\//g, ' / ') : '';
    let lis = '';
    let total = 0;
    let shown = 0;
    for (const c of cards || []) {
      total += c.ranges.length;
      let lastEnd = -1;   // 直前の文脈に入っている箇所は飛ばす
      for (const rg of c.ranges) {
        if (shown >= HITS_PER_DOC) break;
        if (rg[0] < lastEnd) continue;
        const sn = snippet(c.text, rg, c.ranges);
        lastEnd = sn.end;
        lis += `<li><a href="${href}#p${c.no}">${c.no > 1 ? '<span class="who">付属文書</span>' : ''}${sn.html}</a></li>`;
        shown++;
      }
    }
    return `<article class="entry result">
<div class="entry-meta"><span class="badge">${esc(no ? 'SCAPIN-' + no : 'Unnumbered')}</span><span class="crumb">${esc([date, fileNo ? 'AG ' + fileNo : '', dept].filter(Boolean).join(' ・ '))}</span>${total ? `<span class="source">${total} 箇所</span>` : ''}</div>
<h3 class="hw"><a href="${href}">${highlight(subject, r.subject)}</a></h3>
${lis ? `<ul class="kwic">${lis}</ul>` : ''}${total > shown && shown ? `<p class="more-hits"><a href="${href}">ほか ${total - shown} 箇所 →</a></p>` : ''}
</article>`;
  }

  // ── 検索の実行 ──
  function setStatus(r) {
    const done = r.next >= r.cand.length;
    if (done && !r.found) { statusEl.textContent = '該当する指令はありません'; return; }
    if (r.exact) statusEl.textContent = `${r.cand.length} 件`;
    else statusEl.textContent = `${r.found} 件` + (done ? '' : `（候補 ${r.cand.length} 件のうち ${r.next} 件を確認済み）`);
  }

  async function showMore(r) {
    moreWrap.hidden = true;
    let shown = 0;
    while (r.next < r.cand.length && shown < DOCS_PER_BATCH) {
      if (!r.text) {
        const batch = r.cand.slice(r.next, r.next + DOCS_PER_BATCH);
        r.next += batch.length;
        results.insertAdjacentHTML('beforeend', batch.map((i) => renderDoc(i, null, r)).join(''));
        r.found += batch.length;
        shown += batch.length;
        break;
      }
      const batch = r.cand.slice(r.next, r.next + Math.min(FETCH_PARALLEL, DOCS_PER_BATCH - shown));
      const texts = await Promise.all(batch.map(textOf));
      if (run !== r) return;
      r.next += batch.length;
      let html = '';
      batch.forEach((i, k) => {
        const cards = findHits(texts[k], r.text, !r.exact);
        if (!cards) return;
        html += renderDoc(i, cards, r);
        r.found++;
        shown++;
      });
      results.insertAdjacentHTML('beforeend', html);
      setStatus(r);
    }
    setStatus(r);
    moreWrap.hidden = r.next >= r.cand.length;
  }

  function readForm() {
    const v = { t: getSeries() };
    for (const [k, el] of Object.entries(fields)) v[k] = el.value.trim();
    return v;
  }

  function writeForm(p) {
    setSeries(p.get('t') ?? 'all');
    for (const [k, el] of Object.entries(fields)) {
      if (k === 'div') continue;
      const def = k === 'dm' ? 'on' : k === 'sort' ? 'no' : '';
      el.value = p.get(k) ?? def;
      if (el.tagName === 'SELECT' && el.selectedIndex === -1) el.value = def;
    }
    if (meta) buildDepts();
    fillDivs(p.get('div') ?? '');
    syncDateMode();
  }

  function toParams(v) {
    const p = new URLSearchParams();
    for (const [k, x] of Object.entries(v)) {
      if (!x || (k === 't' && x === 'all') || (k === 'dm' && x === 'on') || (k === 'sort' && x === 'no')) continue;
      if (/^[ymd]2$/.test(k) && v.dm !== 'range') continue;
      p.set(k, x);
    }
    return p;
  }

  function hasCondition(v) {
    return !!(v.q || v.no || v.y1 || v.m1 || v.d1 || (v.dm === 'range' && (v.y2 || v.m2 || v.d2)) || v.s || v.file || v.dept);
  }

  async function search(push) {
    const v = readForm();
    const r = { v, cand: [], next: 0, found: 0, text: null, subject: null, exact: true };
    run = r;
    if (push) {
      const p = toParams(v).toString();
      const next = p ? `?${p}` : '';
      if (next !== location.search) history.pushState(null, '', next || location.pathname);
    }
    results.innerHTML = '';
    moreWrap.hidden = true;
    if (!hasCondition(v)) { statusEl.textContent = ''; return; }
    statusEl.textContent = '検索中…';
    try {
      await loadMeta();
      // 詳細検索の条件。種類が SCAPIN だけでも、SCAPIN-A の番号（130-A など）を名指ししたら SCAPIN-A も出す
      if (v.t === 'none') throw new InputError('種類（SCAPIN・SCAPIN-A）のどちらかにチェックを入れてください');
      const noTest = parseNo(v.no);
      const series = noTest && noTest.hasA && v.t === 's' ? 'all' : v.t;
      if (v.q && series === 'a') throw new InputError('SCAPIN-A は本文のテキストがないため、本文の検索はできません。種類の SCAPIN にもチェックを入れてください');
      const tests = [seriesTest(series), noTest, dateTest(v), fileTest(v.file), deptTest(v.dept, v.div)].filter(Boolean);
      if (v.s) {
        const sq = Q.parse(v.s);
        if (sq.error) throw new InputError(`Subject: ${sq.error}`);
        if (!sq.empty) { r.subject = sq; tests.push((i) => !!Q.match(meta.docs[i][3], sq)); }
      }
      // 全文検索
      let cand;
      if (v.q) {
        const tq = Q.parse(v.q);
        if (tq.error) throw new InputError(tq.error);
        if (!tq.empty) {
          r.text = tq;
          r.exact = !Q.needsText(tq);
          cand = await textCandidates(tq);
        }
      }
      if (!cand) cand = meta.docs.map((_, i) => i);
      // 本文の検索では SCAPIN-A（本文なし）を除く（除外の語だけの検索で全件が候補になる場合）
      if (r.text) cand = cand.filter((i) => !meta.isA[i]);
      if (run !== r) return;
      cand = cand.filter((i) => tests.every((t) => t(i)));
      if (v.sort === 'date' || v.sort === 'date-desc') {
        const dir = v.sort === 'date' ? 1 : -1;
        // 日付のないものは最後。同じ日付は番号順
        cand.sort((a, b) => {
          const da = meta.docs[a][2]; const db = meta.docs[b][2];
          if (!da || !db) return (!da) - (!db) || a - b;
          return (da < db ? -dir : da > db ? dir : 0) || a - b;
        });
      }
      r.cand = cand;
      await showMore(r);
    } catch (e) {
      if (run === r) statusEl.textContent = e instanceof InputError ? e.message : '検索用のデータを読み込めませんでした';
    }
  }

  function syncDateMode() {
    const range = fields.dm.value === 'range';
    dateRow.classList.toggle('is-range', range);
    for (const k of ['y1', 'm1', 'd1']) fields[k].setAttribute('aria-label', (range ? '期間の始めの' : '') + fields[k].placeholder);
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); search(true); });
  fields.dm.addEventListener('change', syncDateMode);
  fields.dept.addEventListener('change', () => fillDivs());
  for (const x of Object.values(seriesBoxes)) x.addEventListener('change', () => { if (meta) buildDepts(); });
  fields.sort.addEventListener('change', () => { if (hasCondition(readForm())) search(true); });
  $('fclear').addEventListener('click', () => {
    writeForm(new URLSearchParams());
    search(true);
    fields.q.focus();
  });
  moreBtn.addEventListener('click', () => { if (run) showMore(run); });
  window.addEventListener('popstate', () => { writeForm(new URLSearchParams(location.search)); search(false); });

  // 部局の選択肢を用意してから、URL の条件（?q=…&no=…）があればその検索を出す
  loadMeta().catch(() => {}).finally(() => {
    writeForm(new URLSearchParams(location.search));
    if (location.search) search(false);
  });
  syncDateMode();

  // 各指令のページの「関係の種類について」（#rel-help）から来たら、その説明を開く
  const help = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (help && help.tagName === 'DETAILS') { help.open = true; help.scrollIntoView(); }
})();
