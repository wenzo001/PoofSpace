/**
 * Markdown -> .docx with no dependencies: a .docx is a ZIP, and Word accepts stored
 * (uncompressed) entries, so the archive is written by hand here.
 *
 * Covers what docs/*.md actually uses: headings, tables, bullet/numbered lists,
 * fenced code, inline `code` and **bold**.
 */
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Runs for a line of inline markdown: `code` in monospace, **bold** in bold. */
function runs(text) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('`')) out.push({ t: tok.slice(1, -1), mono: true });
    else out.push({ t: tok.slice(2, -2), bold: true });
    last = m.index + tok.length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out.length ? out : [{ t: '' }];
}

const runXml = (r, extra = '') => {
  const props = [
    r.bold ? '<w:b/>' : '',
    r.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/>' : '',
    extra
  ].join('');
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(r.t)}</w:t></w:r>`;
};

const para = (text, opts = {}) =>
  `<w:p><w:pPr>${opts.pPr ?? ''}</w:pPr>${runs(text).map((r) => runXml(r, opts.rPr ?? '')).join('')}</w:p>`;

const heading = (text, level) =>
  para(text, {
    pPr: `<w:pStyle w:val="Heading${level}"/><w:spacing w:before="240" w:after="120"/>`,
    rPr: `<w:b/><w:sz w:val="${[34, 28, 24, 22][level - 1]}"/>`
  });

const bullet = (text) =>
  para(`\u2022  ${text}`, { pPr: '<w:ind w:left="360" w:hanging="360"/><w:spacing w:after="40"/>' });

const numbered = (num, text) =>
  para(`${num}.  ${text}`, { pPr: '<w:ind w:left="420" w:hanging="420"/><w:spacing w:after="40"/>' });

const codeBlock = (lines) =>
  lines
    .map((l) =>
      para(l.length ? l : ' ', {
        pPr: '<w:shd w:val="clear" w:fill="F2F3F5"/><w:spacing w:after="0"/><w:ind w:left="180"/>',
        rPr: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>'
      })
    )
    .join('');

const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

const table = (rows) => {
  const cols = Math.max(...rows.map((r) => cells(r).length));
  const w = Math.floor(9200 / cols);
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="9AA0A6"/>`)
      .join('') +
    '</w:tblBorders>';
  const body = rows
    .map((r, i) => {
      const cs = cells(r);
      const tds = Array.from({ length: cols }, (_, c) => {
        const txt = cs[c] ?? '';
        const pPr = i === 0 ? '<w:spacing w:after="0"/>' : '<w:spacing w:after="0"/>';
        return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${
          i === 0 ? '<w:shd w:val="clear" w:fill="E8EAED"/>' : ''
        }</w:tcPr>${para(txt, { pPr, rPr: i === 0 ? '<w:b/><w:sz w:val="18"/>' : '<w:sz w:val="18"/>' })}</w:tc>`;
      }).join('');
      return `<w:tr>${tds}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="9200" w:type="dxa"/>${borders}</w:tblPr>${grid}${body}</w:tbl>`;
};

export function mdToDocumentXml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let num = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(codeBlock(body));
      num = 0;
      continue;
    }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        if (!/^\|[\s:|-]+\|?$/.test(lines[i])) rows.push(lines[i]);
        i++;
      }
      out.push(table(rows));
      num = 0;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push(heading(h[2], h[1].length));
      num = 0;
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      out.push(bullet(line.replace(/^\s*[-*]\s+/, '')));
      num = 0;
      i++;
      continue;
    }
    const n = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (n) {
      out.push(numbered(++num, n[2]));
      i++;
      continue;
    }
    if (line.trim() === '') {
      num = 0;
      i++;
      continue;
    }
    out.push(para(line));
    num = 0;
    i++;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${out.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

const STYLE = (id, name, sz, bold) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>` +
  `<w:pPr><w:keepNext/></w:pPr><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${sz}"/></w:rPr></w:style>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:docDefaults><w:rPrDefault><w:rPr>` +
  `<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>` +
  `<w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>` +
  `<w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style>` +
  STYLE('Heading1', 'heading 1', 34, true) +
  STYLE('Heading2', 'heading 2', 28, true) +
  STYLE('Heading3', 'heading 3', 24, true) +
  STYLE('Heading4', 'heading 4', 22, true) +
  `</w:styles>`;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** ZIP with stored entries only — Word reads them the same as deflated ones. */
function zipStored(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
  const u32 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data, 'utf8');
    const crc = crc32(data);
    const head = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x5445),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)
    ]);
    chunks.push(head, name, data);
    central.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x5445),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset)
      ]),
      name
    );
    offset += head.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0)
  ]);
  return Buffer.concat([...chunks, cd, end]);
}

export function writeDocx(mdPath, outPath) {
  const md = fs.readFileSync(mdPath, 'utf8');
  const doc = mdToDocumentXml(md);
  const buf = zipStored([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: doc },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES }
  ]);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return { outPath, bytes: buf.length, docXmlBytes: Buffer.byteLength(doc) };
}

const argv = process.argv.slice(2);
if (argv[0] && !argv[0].startsWith('-')) {
  for (const f of argv) {
    const out = path.join(path.dirname(f), path.basename(f, '.md') + '.docx');
    const r = writeDocx(f, out);
    console.log(`docx ${r.outPath} bytes=${r.bytes} document.xml=${r.docXmlBytes}`);
  }
}
