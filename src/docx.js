'use strict';

/**
 * A transcript as a Word document (.docx: Office Open XML, which Word, LibreOffice and Google Docs
 * open): the title, when it was recorded and how long, then one paragraph per turn with its time,
 * the speaker's name in the voice's color, and what was said. The file is a zip archive of a few XML
 * parts, written here without a dependency.
 */

const zlib = require('zlib');

const xml = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // eslint-disable-line no-control-regex
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A zip archive of [{ name, data }] (deflated), as one Buffer. */
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data } of files) {
    const raw = Buffer.from(data);
    const packed = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const fileName = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed: 2.0
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(fileName.length, 26);
    local.push(head, fileName, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, fileName);
    offset += head.length + fileName.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const run = (text, { bold = false, color = null, size = null } = {}) => {
  const props = [bold ? '<w:b/>' : '', color ? `<w:color w:val="${color}"/>` : '', size ? `<w:sz w:val="${size}"/>` : ''].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
};
const paragraph = (runs, after = 120) => `<w:p><w:pPr><w:spacing w:after="${after}"/></w:pPr>${runs.join('')}</w:p>`;

/**
 * @param {{ title: string, meta: string, created: Date, turns: { time: string, name: string, color: string | null, text: string }[] }} doc
 *   color: the speaker's #rrggbb (null: grey)
 * @returns {Buffer}
 */
function transcriptDocx({ title, meta, created, turns }) {
  const body = [
    paragraph([run(title, { bold: true, size: 36 })], 60),
    paragraph([run(meta, { color: '666666' })], 240),
    ...turns.map((t) => paragraph([
      run(`${t.time}  `, { color: '888888', size: 18 }),
      run(`${t.name}: `, { bold: true, color: t.color ? t.color.slice(1).toUpperCase() : '555555' }),
      run(t.text),
    ])),
  ].join('');
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + `${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`
    + '</w:body></w:document>';
  return zip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'docProps/core.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + `<dc:title>${xml(title)}</dc:title><dc:creator>VoiceRecon</dc:creator>`
        + `<dcterms:created xsi:type="dcterms:W3CDTF">${created.toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>`
        + '</cp:coreProperties>',
    },
    { name: 'word/document.xml', data: document },
  ]);
}

module.exports = { transcriptDocx, zip };
