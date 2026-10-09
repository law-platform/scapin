# SCAPIN-DB

占領期（1945〜1952 年）に連合国最高司令官（SCAP）が日本政府に出した指令（SCAPIN）2,635 件の本文を、原本画像と並べて読み、検索する静的サイト。
SCAPIN-A 7,931 件も、件名・番号・日付・発出部局と関係 SCAPIN で検索できる（本文のテキストはない）。
原本画像は国立国会図書館デジタルコレクションの IIIF から表示する（GitHub Pages でそのまま公開できる）。

SCAPIN の本文のデータは、佐野智也『SCAPIN』（名古屋大学、2025 年、https://doi.org/10.18999/2013682 、CC BY 4.0）を使っている。

## 構成

```
index.html            検索ページ（本文の全文検索と、SCAPIN No.・Date・Subject・File No.・Department の詳細検索。検索の書き方・略号一覧・関係 SCAPIN の見方は折りたたみで載せる）
doc/<指令>.html       各指令の本文と関係 SCAPIN。「原本 →」から原本画像を本文の横に表示する
style.css             見た目（明治法典編纂議事録 arthis・明治法律辞書検索 juridic と共通の作り）
query.js              検索語の解釈と照合（検索ページと各指令のページで共通）
search.js             検索ページの処理
doc.js                各指令のページの処理（検索語の強調と、OpenSeadragon による原本画像ビューア）
search/               検索のデータ
  meta.json             指令の一覧（番号順）と、詳細検索に使う項目（番号・年月日・件名・部局・File No.）
  idx/NNN.json          全文検索の索引（単語 → それを含む指令）。検索語に必要なファイルだけ読み込む
  text/<指令>.json      本文。表示する指令の分だけ読み込み、該当箇所と前後の文脈を出す
```

## 検索の書き方

- 種類は SCAPIN と SCAPIN-A のチェックで選ぶ（初期状態は両方）。SCAPIN-A は本文のテキストがないため、本文の検索には出てこない。
- 本文は単語で検索する。空白区切りで AND、`OR` で OR、`-語` で除外、`"…"` で語順どおりのフレーズ、`語*` で前方一致。
- 大文字・小文字は区別しない。単数形・複数形（center／centers、policy／policies）は同じ語として扱う。
- Subject も同じ書き方で検索できる。
- SCAPIN No. は `245`（245/1 などの枝番も含む）、`408/2`、`100-200`、`1, 5, 9` の形。SCAPIN-A は `130-A`（枝番も含む）、`130-A/1`。
- Date は「日付を指定」と「期間を指定」を選べる。年・月・日の欄に分かれていて、年だけ、年と月だけでもよい（年は `1946` と `46` のどちらでも可）。
- File No. は AG の後の番号と一致するもの（例: `370.05`）。`370*` のように * を付けると前方一致。
- Department は課と部の 2 段のプルダウン。課だけを選ぶと、その下の部も含む。

## データの更新

このフォルダの中身はすべて、このリポジトリの外にある変換プログラム
`scapin/program/convert_scapin_to_html.ps1` が、元データから生成する。

- `scapin/data/SCAPIN/*.xml`: 本文（TEI）
- `scapin/data/SCAPIN-A/*.xml`: SCAPIN-A（件名は titleStmt の title、番号・日付・発出部局は idno・docDate・orgName の属性だけで、本文はない）
- `scapin/data/scapin_relations.tsv`: 関係 SCAPIN（英文目録の記載による。列は scapin・relation・target・note で、番号は `927/1`、`130-A/1`、`unnumbered` の表記）。各指令のページには、相手の側の行を逆向きにした関係（Amended by など）も出す

元データを変えたら、`scapin/` 直下で:

```
powershell -File program\convert_scapin_to_html.ps1
```

1 件だけ確かめるときは `-Only <出力ファイル名>`（例: `-Only scapin0245.html`）を付ける。
索引と meta.json は全件を変換したときだけ作り直すので、最後に全件を変換し直す。
