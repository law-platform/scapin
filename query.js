// 検索語の解釈と照合（検索ページ search.js と各指令のページ doc.js で共通）
//   正規化と単語の切り出しは、索引を作る program/scapin_search.cs と同じ。
//   正規化は 1 文字ずつ行い、UTF-16 の長さを変えない。正規化後の文字列で見つけた位置が
//   そのまま原文の位置になるので、強調表示を原文に戻せる。
//
//   検索語の書き方
//     空白区切り     AND（すべてを含む）
//     A OR B         A か B を含む（OR は大文字）
//     -A             A を含まない
//     "A B"          A の直後に B が続く（フレーズ）。repatriation-center のように記号を挟む語もフレーズとして扱う
//     A*             A で始まる単語（2 文字以上）
//   単数形・複数形は同一視する（forms）
window.ScapinQuery = (() => {
  const WORD = /[\p{L}\p{Nd}]+/gu;
  const cache = new Map();

  function normChar(ch) {
    let r = cache.get(ch);
    if (r !== undefined) return r;
    // 全角英数→半角、アクセント除去、小文字化
    r = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase();
    if (r.length !== ch.length) {
      r = ch.toLowerCase();
      if (r.length !== ch.length) r = ch;
    }
    cache.set(ch, r);
    return r;
  }

  function norm(s) {
    let out = '';
    for (const ch of s) out += normChar(ch);
    return out;
  }

  // 正規化済みの文字列の単語 → [[単語, 開始位置, 終了位置], ...]
  function tokenize(nt) {
    const out = [];
    for (const m of nt.matchAll(WORD)) out.push([m[0], m.index, m.index + m[0].length]);
    return out;
  }

  // 単数形・複数形を同一視するための語形（center ↔ centers、policy ↔ policies、tax ↔ taxes）
  //   3 文字以上の英字の語だけ。どの語形も先頭 2 文字が同じなので、索引の同じファイルで引ける
  function forms(w) {
    const out = new Set([w]);
    if (w.length < 3 || !/^[a-z]+$/.test(w)) return out;
    out.add(w + 's');
    out.add(w + 'es');
    if (/[^aeiou]y$/.test(w)) out.add(w.slice(0, -1) + 'ies');
    if (w.endsWith('ies')) out.add(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) out.add(w.slice(0, -2));
    if (w.endsWith('s') && !w.endsWith('ss')) out.add(w.slice(0, -1));
    for (const f of out) if (f.length < 3 && f !== w) out.delete(f);
    return out;
  }

  // 検索語 → { groups: [[item, ...], ...], neg: [item, ...], error }
  //   groups はすべてを満たす（AND）。group の中の item はどれかを満たす（OR）
  //   item = { ws: [単語, ...], prefix: 最後の単語を前方一致にするか, forms: [単語ごとの語形の Set（前方一致の語は null）] }
  function parse(q) {
    const groups = [];
    const neg = [];
    let error = '';
    let joinOr = false;
    const re = /(-?)"([^"]*)"?|(\S+)/g;
    for (const m of q.matchAll(re)) {
      let raw;
      let minus = m[1] === '-';
      if (m[3] !== undefined) {
        raw = m[3];
        if (raw === 'OR') { if (groups.length) joinOr = true; continue; }
        if (raw.startsWith('-') && raw.length > 1) { minus = true; raw = raw.slice(1); }
      } else raw = m[2];
      const prefix = /\*\s*$/.test(raw);
      const ws = tokenize(norm(raw)).map((t) => t[0]);
      if (!ws.length) { joinOr = false; continue; }
      if (prefix && ws[ws.length - 1].length < 2) { error = '前方一致（*）は 2 文字以上の語に付けてください'; joinOr = false; continue; }
      const item = { ws, prefix, forms: ws.map((w, j) => (prefix && j === ws.length - 1 ? null : forms(w))) };
      if (minus) { neg.push(item); joinOr = false; continue; }
      if (joinOr) groups[groups.length - 1].push(item);
      else groups.push([item]);
      joinOr = false;
    }
    return { groups, neg, error, empty: !groups.length && !neg.length };
  }

  // 本文の照合が要るか（フレーズを含むと索引だけでは決まらない）
  function needsText(query) {
    return query.groups.some((g) => g.some((it) => it.ws.length > 1)) || query.neg.some((it) => it.ws.length > 1);
  }

  // tokens の中の item の出現 → [[開始位置, 終了位置], ...]（文字の位置）
  function occurrences(tokens, item) {
    const out = [];
    const n = item.ws.length;
    const last = n - 1;
    for (let i = 0; i + n <= tokens.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        const w = tokens[i + j][0];
        if (item.forms[j] ? !item.forms[j].has(w) : !w.startsWith(item.ws[j])) { ok = false; break; }
      }
      if (ok) out.push([tokens[i][1], tokens[i + last][2]]);
    }
    return out;
  }

  // 重なる範囲をまとめる
  function merge(list) {
    list.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const out = [];
    for (const r of list) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    return out;
  }

  // 正規化済みの tokens が条件を満たすか。満たすなら強調する範囲を返す（満たさなければ null）
  //   requireAll = false のときは条件を問わず、出てくる語の範囲だけを返す（本文ページの強調用）
  function evaluate(tokens, query, requireAll = true) {
    const ranges = [];
    for (const g of query.groups) {
      let hit = false;
      for (const it of g) {
        const occ = occurrences(tokens, it);
        if (occ.length) { hit = true; ranges.push(...occ); }
      }
      if (!hit && requireAll) return null;
    }
    if (requireAll && query.neg.some((it) => occurrences(tokens, it).length)) return null;
    return merge(ranges);
  }

  // 原文 text が条件を満たすか → 強調する範囲（原文の位置）または null
  function match(text, query) {
    return evaluate(tokenize(norm(text)), query);
  }

  return { norm, tokenize, parse, needsText, evaluate, match };
})();
