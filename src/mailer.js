import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { parseCsv } from "./loadTable.js";

function csvField(value) {
  const raw = String(value ?? "");
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

export function smtpConfig() {
  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT || "587");
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASSWORD || "";
  const from = process.env.MAIL_FROM || "";
  const missing = [];
  if (!host) missing.push("SMTP_HOST");
  if (!user) missing.push("SMTP_USER");
  if (!pass) missing.push("SMTP_PASSWORD");
  if (!from) missing.push("MAIL_FROM");
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")} in the environment or .env file`);
  }
  return { host, port, secure, user, pass, from };
}

export function createTransport(config = smtpConfig()) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
}

function envelopeAddress(from) {
  const match = String(from).match(/<([^>]+)>/);
  return (match ? match[1] : from).trim();
}

export async function sendOne(transport, { from, message }) {
  await transport.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    envelope: {
      from: envelopeAddress(from),
      to: [message.to],
    },
  });
}

export function readSentLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const rows = parseCsv(fs.readFileSync(logPath, "utf8"));
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? "";
    });
    return record;
  });
}

export function sentKeys(records) {
  const keys = new Set();
  for (const record of records) {
    if (record.status === "sent" && record.to && record.hash) {
      keys.add(`${record.to.toLowerCase()}|${record.hash}`);
    }
  }
  return keys;
}

export function appendSentLog(logPath, record) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const headers = ["sent_at", "row_number", "to", "subject", "hash", "status", "error"];
  const line = headers.map((header) => csvField(record[header] ?? "")).join(",");
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `${headers.join(",")}\n${line}\n`, "utf8");
    return;
  }
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
}
