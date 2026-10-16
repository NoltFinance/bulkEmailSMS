import fs from "node:fs";
import path from "node:path";
import { escapeHtml } from "./render.js";

function fileName(message) {
  const address = message.to.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  return `row-${message.rowNumber}-${address}.html`;
}

function clearPrevious(outputDir) {
  if (!fs.existsSync(outputDir)) return;
  for (const name of fs.readdirSync(outputDir)) {
    if (name.endsWith(".html") || name === "manifest.json") {
      fs.unlinkSync(path.join(outputDir, name));
    }
  }
}

export function writePreview(messages, outputDir, meta) {
  fs.mkdirSync(outputDir, { recursive: true });
  clearPrevious(outputDir);

  const files = messages.map((message) => {
    const name = fileName(message);
    fs.writeFileSync(path.join(outputDir, name), message.html, "utf8");
    return { message, name };
  });

  const fieldKeys = [...new Set(messages.flatMap((message) => Object.keys(message.context)))];
  const header = ["Row", "To", "Subject", ...fieldKeys]
    .map((key) => `<th>${escapeHtml(key)}</th>`)
    .join("");
  const body = files
    .map(({ message, name }) => {
      const cells = [
        String(message.rowNumber),
        message.to,
        message.subject,
        ...fieldKeys.map((key) => message.context[key] ?? ""),
      ]
        .map((value) => `<td>${escapeHtml(value)}</td>`)
        .join("");
      return `<tr>${cells}<td><a href="${escapeHtml(name)}">Open</a></td></tr>`;
    })
    .join("\n");

  const index = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Mail merge preview</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; margin: 24px; color: #1a1a1a; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f6f7f9; }
    p.note { max-width: 760px; line-height: 1.45; }
  </style>
</head>
<body>
  <h1>Mail merge preview</h1>
  <p class="note">${messages.length} message(s) from ${meta.contactCount} contact row(s). Address columns: ${escapeHtml(meta.emailColumns.join(", ") || "(none)")}. Each message is rendered from its own row, and {{to_email}} is the address on that message.</p>
  <table>
    <thead><tr>${header}<th>Body</th></tr></thead>
    <tbody>
      ${body}
    </tbody>
  </table>
</body>
</html>
`;
  fs.writeFileSync(path.join(outputDir, "index.html"), index, "utf8");

  const manifest = {
    generatedAt: new Date().toISOString(),
    contactCount: meta.contactCount,
    emailColumns: meta.emailColumns,
    fieldColumns: meta.fieldColumns,
    messages: files.map(({ message, name }) => ({
      rowNumber: message.rowNumber,
      to: message.to,
      subject: message.subject,
      file: name,
      hash: message.hash,
      fields: message.context,
    })),
  };
  fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return path.join(outputDir, "index.html");
}
