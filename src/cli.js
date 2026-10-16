import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildContacts, assertUniqueRecipients } from "./contacts.js";
import { loadTable } from "./loadTable.js";
import { appendSentLog, createTransport, loadEnvFile, readSentLog, sendOne, sentKeys, smtpConfig } from "./mailer.js";
import { buildMessages } from "./messages.js";
import { writePreview } from "./preview.js";

const HELP = `Usage:
  node src/cli.js preview --contacts <file.csv|file.xlsx> --template <file.html> [--subject "Hello {{first_name}}"]
  node src/cli.js send --contacts <file.csv|file.xlsx> --template <file.html> [--subject "Hello {{first_name}}"]

Each spreadsheet row is rendered on its own. A row may contain several addresses
(separate columns, or several addresses in one cell split by ; or ,). Those
addresses each get their own copy of that row. {{to_email}} is the address of
the copy being sent.

Options:
  --sheet <name>                 Worksheet name. Defaults to the first sheet.
  --subject <template>           Subject template. Otherwise the HTML comment <!-- subject: ... --> is used.
  --out <dir>                    Preview directory. Default: preview
  --limit <n>                    Only the first n contact rows.
  --allow-duplicate-emails       Allow one address to appear on more than one row.
  --skip-sent                    Skip messages already recorded as sent in logs/sent.csv for the same content.
  --delay-ms <n>                 Pause between sends. Default: 200
  --yes                          Send without the interactive SEND confirmation.
  --env-file <path>              Default: .env
`;

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      contacts: { type: "string" },
      template: { type: "string" },
      subject: { type: "string" },
      sheet: { type: "string" },
      out: { type: "string", default: "preview" },
      limit: { type: "string" },
      "allow-duplicate-emails": { type: "boolean", default: false },
      "skip-sent": { type: "boolean", default: false },
      "delay-ms": { type: "string", default: "200" },
      yes: { type: "boolean", default: false },
      "env-file": { type: "string", default: ".env" },
      help: { type: "boolean", default: false },
    },
  });
  return { values, command: positionals[0] || "" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepare(values) {
  if (!values.contacts) throw new Error("Pass --contacts with a .csv or .xlsx file");
  if (!values.template) throw new Error("Pass --template with an HTML file");
  const matrix = await loadTable(path.resolve(values.contacts), { sheet: values.sheet });
  const built = buildContacts(matrix);
  if (!values["allow-duplicate-emails"]) assertUniqueRecipients(built.contacts);

  let contacts = built.contacts;
  if (values.limit) {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
    contacts = contacts.slice(0, limit);
  }

  const template = fs.readFileSync(path.resolve(values.template), "utf8");
  const messages = buildMessages({
    contacts,
    template,
    subjectTemplate: values.subject || "",
  });
  return { ...built, contacts, messages, template };
}

function printPlan(prepared) {
  console.log(`Address columns: ${prepared.emailColumns.join(", ")}`);
  console.log(`Personalization columns: ${prepared.fieldColumns.join(", ") || "(none)"}`);
  console.log(`Contacts: ${prepared.contacts.length}`);
  console.log(`Messages: ${prepared.messages.length}`);
  for (const message of prepared.messages) {
    console.log(`  row ${message.rowNumber}  ${message.to}  |  ${message.subject}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, command } = parseCli(argv);
  if (values.help || !command) {
    console.log(HELP);
    return 0;
  }
  if (command !== "preview" && command !== "send") {
    console.error(HELP);
    return 1;
  }

  loadEnvFile(path.resolve(values["env-file"]));
  const prepared = await prepare(values);
  printPlan(prepared);
  const indexPath = writePreview(prepared.messages, path.resolve(values.out), {
    contactCount: prepared.contacts.length,
    emailColumns: prepared.emailColumns,
    fieldColumns: prepared.fieldColumns,
  });
  console.log(`Preview: ${indexPath}`);

  if (command === "preview") {
    console.log("No emails sent.");
    return 0;
  }

  const config = smtpConfig();
  const logPath = path.resolve("logs", "sent.csv");
  const alreadySent = values["skip-sent"] ? sentKeys(readSentLog(logPath)) : new Set();
  const queue = prepared.messages.filter((message) => !alreadySent.has(`${message.to.toLowerCase()}|${message.hash}`));
  const skipped = prepared.messages.length - queue.length;
  if (skipped > 0) console.log(`Skipping ${skipped} already sent message(s).`);
  if (queue.length === 0) {
    console.log("Nothing new to send.");
    return 0;
  }

  if (!values.yes) {
    if (!process.stdin.isTTY) {
      throw new Error("Refusing to send without --yes when there is no interactive prompt.");
    }
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(`Send ${queue.length} message(s)? Type SEND to continue: `);
    prompt.close();
    if (answer.trim() !== "SEND") {
      console.log("Cancelled. No emails sent.");
      return 1;
    }
  }

  const transport = createTransport(config);
  const delay = Number(values["delay-ms"] || "0");
  let sent = 0;
  let failed = 0;
  for (const message of queue) {
    try {
      await sendOne(transport, { from: config.from, message });
      appendSentLog(logPath, {
        sent_at: new Date().toISOString(),
        row_number: message.rowNumber,
        to: message.to,
        subject: message.subject,
        hash: message.hash,
        status: "sent",
        error: "",
      });
      sent += 1;
      console.log(`Sent row ${message.rowNumber} to ${message.to}`);
    } catch (error) {
      failed += 1;
      appendSentLog(logPath, {
        sent_at: new Date().toISOString(),
        row_number: message.rowNumber,
        to: message.to,
        subject: message.subject,
        hash: message.hash,
        status: "failed",
        error: error.message,
      });
      console.error(`Failed row ${message.rowNumber} to ${message.to}: ${error.message}`);
    }
    if (delay > 0) await sleep(delay);
  }
  console.log(`Finished. Sent ${sent}, failed ${failed}.`);
  return failed > 0 ? 1 : 0;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
