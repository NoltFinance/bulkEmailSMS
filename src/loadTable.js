import fs from "node:fs";
import ExcelJS from "exceljs";

function decodeCsv(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer).replace(/^\uFEFF/, "");
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const replacements = utf8.match(/\uFFFD/g);
  if (replacements && replacements.length > 0) {
    return new TextDecoder("windows-1252").decode(buffer);
  }
  return utf8.replace(/^\uFEFF/, "");
}

export function detectDelimiter(text) {
  let inQuotes = false;
  let commas = 0;
  let semis = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) break;
    if (!inQuotes && char === ",") commas += 1;
    if (!inQuotes && char === ";") semis += 1;
  }
  return semis > commas ? ";" : ",";
}

export function parseCsv(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ""));
}

function formatCellValue(value) {
  if (value == null) return "";
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") {
    if (value.error) return String(value.error);
    if (Object.prototype.hasOwnProperty.call(value, "result")) return formatCellValue(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? "").join("").trim();
    if (value.hyperlink) {
      const text = value.text ? String(value.text) : String(value.hyperlink);
      return text.replace(/^mailto:/i, "").trim();
    }
    if (value.text) return String(value.text).trim();
  }
  return String(value).trim();
}

async function loadXlsx(filePath, sheetName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) {
    throw new Error(sheetName ? `Sheet not found: ${sheetName}` : "Workbook has no sheets");
  }
  const width = sheet.columnCount;
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    for (let column = 1; column <= width; column += 1) {
      cells.push(formatCellValue(row.getCell(column).value));
    }
    rows.push(cells);
  });
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

export async function loadTable(filePath, { sheet } = {}) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".csv")) {
    const text = decodeCsv(fs.readFileSync(filePath));
    return parseCsv(text);
  }
  if (lower.endsWith(".xlsx")) {
    return loadXlsx(filePath, sheet);
  }
  throw new Error("Contacts file must be .csv or .xlsx");
}
