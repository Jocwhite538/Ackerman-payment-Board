(function () {
  "use strict";

  const encoder = new TextEncoder();

  function xmlEscape(value) {
    return String(value ?? "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function columnName(index) {
    let value = index + 1;
    let name = "";
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  }

  function excelDateSerial(value, includeTime) {
    if (!value) return null;
    const text = String(value);
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = includeTime ? Number(match[4] || 0) : 0;
    const minute = includeTime ? Number(match[5] || 0) : 0;
    const second = includeTime ? Number(match[6] || 0) : 0;
    const millisecond = includeTime && match[7] ? Number(`0.${match[7]}`) * 1000 : 0;
    const millis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    return millis / 86400000 + 25569;
  }

  function numberValue(value, type) {
    if (value === null || value === undefined || value === "") return null;
    if (type === "percent" && typeof value === "string" && value.trim().endsWith("%")) {
      const parsed = Number(value.replace("%", ""));
      return Number.isFinite(parsed) ? parsed / 100 : null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function displayLength(value) {
    if (value === null || value === undefined) return 0;
    return String(value).replace(/<[^>]*>/g, "").length;
  }

  function styleFor(type, value, options, columnIndex) {
    if (columnIndex === options.statusColumn) {
      const status = String(value || "").toLowerCase();
      if (status.includes("overdue")) return 10;
      if (status.includes("due today")) return 11;
      if (status.includes("upcoming")) return 12;
      if (status.includes("paid in full")) return 13;
      if (status.includes("no responsibility")) return 14;
    }
    if ((options.flagColumns || []).includes(columnIndex) && Number(value || 0) > 0) return 15;
    if (type === "currency") return 5;
    if (type === "percent") return 6;
    if (type === "date") return 7;
    if (type === "datetime") return 8;
    if (type === "integer" || type === "number") return 9;
    if (type === "wrap") return 17;
    return 4;
  }

  function cellXml(rowIndex, columnIndex, value, type, style) {
    const ref = `${columnName(columnIndex)}${rowIndex}`;
    if (type === "currency" || type === "percent" || type === "integer" || type === "number") {
      const numeric = numberValue(value, type);
      if (numeric === null) return `<c r="${ref}" s="${style}" t="inlineStr"><is><t></t></is></c>`;
      return `<c r="${ref}" s="${style}"><v>${numeric}</v></c>`;
    }
    if (type === "date" || type === "datetime") {
      const serial = excelDateSerial(value, type === "datetime");
      if (serial === null) return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
      return `<c r="${ref}" s="${style}"><v>${serial}</v></c>`;
    }
    const text = xmlEscape(value);
    const preserve = /^\s|\s$|\n/.test(String(value ?? "")) ? ' xml:space="preserve"' : "";
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t${preserve}>${text}</t></is></c>`;
  }

  function createWorksheetXml(config) {
    const headers = config.headers || [];
    const rows = config.rows || [];
    const types = config.types || headers.map(() => "text");
    const lastColumn = columnName(Math.max(0, headers.length - 1));
    const lastRow = Math.max(4, rows.length + 4);
    const options = {
      statusColumn: Number.isInteger(config.statusColumn) ? config.statusColumn : -1,
      flagColumns: Array.isArray(config.flagColumns) ? config.flagColumns : []
    };

    const widths = headers.map((header, columnIndex) => {
      let longest = displayLength(header);
      rows.slice(0, 200).forEach((row) => {
        longest = Math.max(longest, displayLength(row[columnIndex]));
      });
      const type = types[columnIndex];
      if (type === "date") return 14;
      if (type === "datetime") return 21;
      if (type === "currency") return Math.max(14, Math.min(18, longest + 2));
      if (type === "percent") return 13;
      if (type === "integer" || type === "number") return 12;
      const cap = type === "wrap" ? 36 : 28;
      return Math.max(11, Math.min(cap, longest + 2));
    });

    const title = xmlEscape(config.title || "Ackerman Export");
    const subtitle = xmlEscape(config.subtitle || "");
    const sheetRows = [];
    sheetRows.push(`<row r="1" ht="26" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>${title}</t></is></c></row>`);
    sheetRows.push(`<row r="2" ht="20" customHeight="1"><c r="A2" s="2" t="inlineStr"><is><t>${subtitle}</t></is></c></row>`);
    sheetRows.push('<row r="3" ht="8" customHeight="1"></row>');
    sheetRows.push(`<row r="4" ht="28" customHeight="1">${headers.map((header, index) => cellXml(4, index, header, "text", 3)).join("")}</row>`);

    rows.forEach((row, rowOffset) => {
      const rowIndex = rowOffset + 5;
      const cells = headers.map((_, columnIndex) => {
        const type = types[columnIndex] || "text";
        const value = row[columnIndex] ?? "";
        const style = styleFor(type, value, options, columnIndex);
        return cellXml(rowIndex, columnIndex, value, type, style);
      }).join("");
      sheetRows.push(`<row r="${rowIndex}" ht="20" customHeight="1">${cells}</row>`);
    });

    const columnsXml = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
    const mergeXml = headers.length > 1
      ? `<mergeCells count="2"><mergeCell ref="A1:${lastColumn}1"/><mergeCell ref="A2:${lastColumn}2"/></mergeCells>`
      : "";
    const filterRef = rows.length ? `A4:${lastColumn}${lastRow}` : `A4:${lastColumn}4`;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${columnsXml}</cols>
  <sheetData>${sheetRows.join("")}</sheetData>
  <autoFilter ref="${filterRef}"/>
  ${mergeXml}
  <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
  }

  function stylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="4">
    <numFmt numFmtId="164" formatCode="$#,##0.00;[Red]-$#,##0.00"/>
    <numFmt numFmtId="165" formatCode="0.0%"/>
    <numFmt numFmtId="166" formatCode="mm/dd/yyyy"/>
    <numFmt numFmtId="167" formatCode="m/d/yy h:mm AM/PM"/>
  </numFmts>
  <fonts count="5">
    <font><sz val="11"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="16"/><name val="Aptos Display"/><family val="2"/></font>
    <font><i/><color rgb="FF60717E"/><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><color rgb="FF12324A"/><sz val="11"/><name val="Aptos"/><family val="2"/></font>
  </fonts>
  <fills count="10">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF12324A"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF087F8C"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFE8EA"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF2D9"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE8F2FF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDEF7E5"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEDF1F4"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD8E1E7"/></left><right style="thin"><color rgb="FFD8E1E7"/></right><top style="thin"><color rgb="FFD8E1E7"/></top><bottom style="thin"><color rgb="FFD8E1E7"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="18">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="6" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="7" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="8" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="9" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
  }

  function workbookXml(sheetName) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="15000"/></bookViews><sheets><sheet name="${xmlEscape(sheetName || "Export")}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`;
  }

  function utf8Bytes(value) {
    return encoder.encode(value);
  }

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function writeU16(target, offset, value) {
    target[offset] = value & 0xFF;
    target[offset + 1] = (value >>> 8) & 0xFF;
  }

  function writeU32(target, offset, value) {
    target[offset] = value & 0xFF;
    target[offset + 1] = (value >>> 8) & 0xFF;
    target[offset + 2] = (value >>> 16) & 0xFF;
    target[offset + 3] = (value >>> 24) & 0xFF;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = (year - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, date: day };
  }

  function zipStore(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const stamp = dosDateTime();

    files.forEach((file) => {
      const nameBytes = utf8Bytes(file.name);
      const dataBytes = typeof file.data === "string" ? utf8Bytes(file.data) : file.data;
      const crc = crc32(dataBytes);
      const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
      writeU32(local, 0, 0x04034B50);
      writeU16(local, 4, 20);
      writeU16(local, 6, 0);
      writeU16(local, 8, 0);
      writeU16(local, 10, stamp.time);
      writeU16(local, 12, stamp.date);
      writeU32(local, 14, crc);
      writeU32(local, 18, dataBytes.length);
      writeU32(local, 22, dataBytes.length);
      writeU16(local, 26, nameBytes.length);
      writeU16(local, 28, 0);
      local.set(nameBytes, 30);
      local.set(dataBytes, 30 + nameBytes.length);
      chunks.push(local);

      const record = new Uint8Array(46 + nameBytes.length);
      writeU32(record, 0, 0x02014B50);
      writeU16(record, 4, 20);
      writeU16(record, 6, 20);
      writeU16(record, 8, 0);
      writeU16(record, 10, 0);
      writeU16(record, 12, stamp.time);
      writeU16(record, 14, stamp.date);
      writeU32(record, 16, crc);
      writeU32(record, 20, dataBytes.length);
      writeU32(record, 24, dataBytes.length);
      writeU16(record, 28, nameBytes.length);
      writeU16(record, 30, 0);
      writeU16(record, 32, 0);
      writeU16(record, 34, 0);
      writeU16(record, 36, 0);
      writeU32(record, 38, 0);
      writeU32(record, 42, offset);
      record.set(nameBytes, 46);
      central.push(record);
      offset += local.length;
    });

    const centralOffset = offset;
    const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
    const end = new Uint8Array(22);
    writeU32(end, 0, 0x06054B50);
    writeU16(end, 4, 0);
    writeU16(end, 6, 0);
    writeU16(end, 8, files.length);
    writeU16(end, 10, files.length);
    writeU32(end, 12, centralSize);
    writeU32(end, 16, centralOffset);
    writeU16(end, 20, 0);

    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralSize + end.length;
    const output = new Uint8Array(totalSize);
    let cursor = 0;
    [...chunks, ...central, end].forEach((chunk) => {
      output.set(chunk, cursor);
      cursor += chunk.length;
    });
    return output;
  }

  function buildWorkbookBytes(config) {
    const sheetName = String(config.sheetName || "Export").slice(0, 31).replace(/[\\/?*\[\]:]/g, "-");
    const created = new Date().toISOString();
    const worksheet = createWorksheetXml(config);
    const files = [
      {
        name: "[Content_Types].xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
      },
      {
        name: "_rels/.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
      },
      {
        name: "docProps/core.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(config.title || "Ackerman Export")}</dc:title><dc:creator>Ackerman Patient Payment Board</dc:creator><cp:lastModifiedBy>Ackerman Patient Payment Board</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`
      },
      {
        name: "docProps/app.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Ackerman Patient Payment Board</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${xmlEscape(sheetName)}</vt:lpstr></vt:vector></TitlesOfParts></Properties>`
      },
      { name: "xl/workbook.xml", data: workbookXml(sheetName) },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
      },
      { name: "xl/styles.xml", data: stylesXml() },
      { name: "xl/worksheets/sheet1.xml", data: worksheet }
    ];
    return zipStore(files);
  }

  function exportWorkbook(config) {
    const bytes = buildWorkbookBytes(config);
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = config.filename || "ackerman-export.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.AckermanExcel = { exportWorkbook, buildWorkbookBytes };
})();
