/* Минимальный писатель .xlsx — без зависимостей и без сборки.
   CRM отдаёт отчёт за период файлом, который открывают в Excel: раньше строки
   уезжали в Google Sheets через edge-функцию, то есть наружу и в чужой аккаунт.

   Пишем ровно тот кусок формата, который нужен отчёту: несколько листов,
   строка заголовков, числа, даты и текст. Ни формул, ни объединённых ячеек.

   Zip собирается без сжатия (метод store): дефлейта в браузере без библиотеки
   нет, а отчёт за месяц — десятки килобайт, экономить нечего. Excel такой
   архив открывает штатно.

   Текст пишется инлайном (t="inlineStr"), без таблицы общих строк: файл чуть
   толще, зато на один XML меньше и нечему рассинхронизироваться. */
(function (global) {
  "use strict";

  const XML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
  // Управляющие символы XML 1.0 не принимает вовсе — Excel на таком файле
  // ругается «unreadable content». В именах из базы они изредка попадаются.
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => XML_ESC[c])
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  // A, B, … Z, AA, AB …
  function colName(i) {
    let n = i + 1, out = "";
    while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
    return out;
  }

  // Excel считает дни от 1899-12-30 (сдвиг учитывает несуществующий 1900-02-29).
  const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
  function excelSerial(d) {
    const t = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(t.getTime())) return null;
    // Берём локальные части: в отчёте важен календарный день клуба, а не UTC.
    const local = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds());
    return (local - EXCEL_EPOCH) / 86400000;
  }

  // Стили: 0 — обычный, 1 — шапка, 2 — дата, 3 — деньги/целые с разделителем.
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="DD.MM.YYYY"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3E9D6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFB9A98A"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  // Имя листа: Excel запрещает : \ / ? * [ ] и длину больше 31 символа.
  const sheetName = (s, i) => (String(s ?? "").replace(/[:\\/?*\[\]]/g, " ").trim() || `Лист${i + 1}`).slice(0, 31);

  function cellXml(value, ref, type) {
    if (value == null || value === "") return "";
    if (type === "date") {
      const serial = excelSerial(value);
      if (serial == null) return `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
      return `<c r="${ref}" s="2"><v>${serial}</v></c>`;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return `<c r="${ref}"${type === "money" || type === "int" ? ' s="3"' : ""}><v>${value}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  }

  function sheetXml(sheet) {
    const cols = sheet.columns || [];
    const colsXml = cols.length
      ? `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join("")}</cols>`
      : "";
    const head = `<row r="1">${cols.map((c, i) => `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${esc(c.title)}</t></is></c>`).join("")}</row>`;
    const body = (sheet.rows || []).map((row, r) =>
      `<row r="${r + 2}">${row.map((v, i) => cellXml(v, `${colName(i)}${r + 2}`, cols[i]?.type)).join("")}</row>`
    ).join("");
    // Шапка закрепляется: в отчёте за месяц строк больше экрана.
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
${colsXml}<sheetData>${head}${body}</sheetData></worksheet>`;
  }

  // ── ZIP (метод store) ──────────────────────────────────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const utf8 = (s) => new TextEncoder().encode(s);

  function zip(files) {
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = utf8(f.name), data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);      // имена в UTF-8
      dv.setUint16(8, 0, true);           // store
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true);
      local.set(name, 30);
      chunks.push(local, data);

      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cen.set(name, 46);
      central.push(cen);
      offset += local.length + data.length;
    }
    const centralSize = central.reduce((a, b) => a + b.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return [...chunks, ...central, end];
  }

  // sheets: [{ name, columns:[{title,width,type}], rows:[[value,…]] }]
  function build(sheets) {
    const list = (Array.isArray(sheets) ? sheets : []).filter(Boolean);
    if (!list.length) throw new Error("Нечего выгружать");
    const names = list.map((s, i) => sheetName(s.name, i));

    const files = [
      { name: "[Content_Types].xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`) },
      { name: "_rels/.rels", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
      { name: "xl/workbook.xml", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`) },
      { name: "xl/_rels/workbook.xml.rels", data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) },
      { name: "xl/styles.xml", data: utf8(STYLES) },
      ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s)) })),
    ];
    return zip(files);
  }

  function blob(sheets) {
    return new Blob(build(sheets), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function download(filename, sheets) {
    const url = URL.createObjectURL(blob(sheets));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Ссылку отпускаем не сразу: Safari отменяет скачивание, если объект
    // освободить в том же тике, что и клик.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  global.VPXlsx = { build, blob, download, crc32, excelSerial, colName, sheetName };
})(typeof window !== "undefined" ? window : globalThis);
