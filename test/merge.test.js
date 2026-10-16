import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { assertUniqueRecipients, buildContacts, findSharedEmails, isEmailColumn } from "../src/contacts.js";
import { loadTable, parseCsv } from "../src/loadTable.js";
import { buildMessages } from "../src/messages.js";
import { writePreview } from "../src/preview.js";

const TEMPLATE = `<!-- subject: {{first_name}} / {{account_id}} -->
<p>Hello {{first_name}}</p>
<p>{{company}}</p>
<p>{{account_id}}</p>
<p>{{to_email}}</p>`;

function messagesFor(matrix, template = TEMPLATE) {
  const built = buildContacts(matrix);
  const messages = buildMessages({ contacts: built.contacts, template, subjectTemplate: "" });
  return { ...built, messages };
}

test("each address gets only its own row, including a contact with two emails", () => {
  const { messages } = messagesFor([
    ["first_name", "company", "account_id", "email"],
    ["Ada", "Analytical Engines", "TOKEN-ADA", "ada@example.com"],
    ["Grace", "US Navy", "TOKEN-GRACE", "grace@example.com; g.hopper@example.com"],
    ["Alan", "Bletchley Park", "TOKEN-ALAN", "alan@example.com"],
  ]);

  assert.equal(messages.length, 4);
  const grace = messages.filter((message) => message.context.account_id === "TOKEN-GRACE");
  assert.deepEqual(grace.map((message) => message.to), ["grace@example.com", "g.hopper@example.com"]);
  for (const message of grace) {
    assert.equal(message.context.to_email, message.to);
    assert.match(message.html, /TOKEN-GRACE/);
    assert.match(message.html, new RegExp(message.to.replace(".", "\\.")));
    assert.doesNotMatch(message.html, /TOKEN-ADA/);
    assert.doesNotMatch(message.html, /TOKEN-ALAN/);
    assert.equal(message.subject, "Grace / TOKEN-GRACE");
  }

  const ada = messages.find((message) => message.to === "ada@example.com");
  assert.match(ada.html, /TOKEN-ADA/);
  assert.doesNotMatch(ada.html, /TOKEN-GRACE/);
  assert.equal(ada.context.to_email, "ada@example.com");
});

test("separate email columns stay on the same contact and a repeated address is sent once", () => {
  const built = buildContacts([
    ["First Name", "Account", "Email", "Email 2", "Email Opt In"],
    ["Ada", "TOKEN-ADA", "ada@example.com", "", "Yes"],
    ["Grace", "TOKEN-GRACE", "grace@example.com", "Grace Hopper <grace.work@example.com>", "No"],
    ["Grace", "TOKEN-GRACE-COPY", "grace@example.com", "grace@example.com", "Yes"],
  ]);
  assert.deepEqual(built.emailColumns, ["Email", "Email 2"]);
  assert.deepEqual(built.fieldColumns, ["First Name", "Account", "Email Opt In"]);
  assert.deepEqual(built.contacts[0].emails, ["ada@example.com"]);
  assert.deepEqual(built.contacts[1].emails, ["grace@example.com", "grace.work@example.com"]);
  assert.deepEqual(built.contacts[2].emails, ["grace@example.com"]);
  assert.equal(isEmailColumn("Email Opt In", ["Yes", "No"]), false);
});

test("the same address on two rows is rejected unless the caller allows it", () => {
  const matrix = [
    ["first_name", "company", "account_id", "email"],
    ["Ada", "Analytical Engines", "TOKEN-ADA", "shared@example.com"],
    ["Grace", "US Navy", "TOKEN-GRACE", "shared@example.com"],
  ];
  const { contacts } = buildContacts(matrix);
  const shared = findSharedEmails(contacts);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].email, "shared@example.com");
  assert.throws(() => assertUniqueRecipients(contacts), /shared@example.com/);
  const messages = buildMessages({ contacts, template: TEMPLATE, subjectTemplate: "" });
  assert.equal(messages[0].html.includes("TOKEN-GRACE"), false);
  assert.equal(messages[1].html.includes("TOKEN-ADA"), false);
});

test("a blank personalization field fails the merge before any mix can be sent", () => {
  assert.throws(
    () => messagesFor([
      ["first_name", "company", "account_id", "email"],
      ["Ada", "", "TOKEN-ADA", "ada@example.com"],
    ]),
    /company \(blank\)/,
  );
});

test("unknown placeholders and header injection do not borrow another row", () => {
  assert.throws(
    () => messagesFor(
      [
        ["first_name", "company", "account_id", "email"],
        ["Ada", "A&B <Ltd>", "TOKEN-ADA", "ada@example.com"],
      ],
      "<!-- subject: Hello -->\n<p>{{nickname}}</p>",
    ),
    /nickname/,
  );

  const { messages } = messagesFor(
    [
      ["first_name", "company", "account_id", "email"],
      ["Ada", "A&B <Ltd>\r\nBcc: evil@example.com", "TOKEN-ADA", "ada@example.com"],
    ],
    "<!-- subject: {{company}} -->\n<p>{{company}}</p><p>{{first_name}}</p><p>{{account_id}}</p><p>{{to_email}}</p>",
  );
  assert.match(messages[0].html, /A&amp;B &lt;Ltd&gt;/);
  assert.doesNotMatch(messages[0].subject, /\n/);
  assert.match(messages[0].subject, /A&B <Ltd> Bcc: evil@example.com/);
});

test("csv quoting and excel files keep both addresses on that row only", async () => {
  const csv = parseCsv('first_name;company;account_id;email\nGrace;US Navy;TOKEN-GRACE;"grace@example.com; g.hopper@example.com"\n');
  const fromCsv = messagesFor(csv);
  assert.deepEqual(fromCsv.messages.map((message) => message.to), ["grace@example.com", "g.hopper@example.com"]);
  assert.equal(fromCsv.messages[0].context === fromCsv.messages[1].context, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-email-"));
  const xlsxPath = path.join(dir, "contacts.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("People");
  sheet.addRow(["first_name", "company", "account_id", "email", "email 2"]);
  sheet.addRow(["Grace", "US Navy", 14, { text: "grace@example.com", hyperlink: "mailto:grace@example.com" }, "g.hopper@example.com"]);
  await workbook.xlsx.writeFile(xlsxPath);

  const loaded = await loadTable(xlsxPath);
  const fromXlsx = messagesFor(loaded);
  assert.equal(fromXlsx.contacts[0].fields.account_id, "14");
  assert.deepEqual(fromXlsx.contacts[0].emails, ["grace@example.com", "g.hopper@example.com"]);
  for (const message of fromXlsx.messages) {
    assert.match(message.html, />14</);
    assert.equal(message.context.to_email, message.to);
    assert.match(message.html, /US Navy/);
  }
});

test("preview manifest keeps each row's fields beside that row's addresses", () => {
  const { messages, emailColumns, fieldColumns, contacts } = messagesFor([
    ["first_name", "company", "account_id", "email"],
    ["Ada", "Analytical Engines", "TOKEN-ADA", "ada@example.com"],
    ["Grace", "US Navy", "TOKEN-GRACE", "grace@example.com; g.hopper@example.com"],
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-email-preview-"));
  writePreview(messages, dir, {
    contactCount: contacts.length,
    emailColumns,
    fieldColumns,
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.messages.length, 3);
  const graceFiles = manifest.messages.filter((message) => message.fields.account_id === "TOKEN-GRACE");
  assert.deepEqual(graceFiles.map((message) => message.to), ["grace@example.com", "g.hopper@example.com"]);
  for (const message of graceFiles) {
    assert.equal(message.fields.to_email, message.to);
    const html = fs.readFileSync(path.join(dir, message.file), "utf8");
    assert.match(html, /TOKEN-GRACE/);
    assert.doesNotMatch(html, /TOKEN-ADA/);
  }
});

test("the NOLT account template fills full name and account number from that row only", () => {
  const template = fs.readFileSync(new URL("../templates/email.html", import.meta.url), "utf8");
  const { messages } = messagesFor([
    ["FULL_NAME", "CASA_ACCOUNT", "email"],
    ["Ada Lovelace", "1111111111", "ada@example.com"],
    ["Grace Hopper", "2222222222", "grace@example.com; g.hopper@example.com"],
  ], template);

  assert.equal(messages.length, 3);
  const ada = messages.find((message) => message.to === "ada@example.com");
  assert.equal(ada.subject, "Introducing Your Personal NOLT Account, Ada Lovelace");
  assert.match(ada.html, /Dear <span>Ada Lovelace<\/span>/);
  assert.match(ada.html, /1111111111/);
  assert.doesNotMatch(ada.html, /2222222222/);
  assert.doesNotMatch(ada.html, /\$\[/);

  const grace = messages.filter((message) => message.context.FULL_NAME === "Grace Hopper");
  assert.deepEqual(grace.map((message) => message.to), ["grace@example.com", "g.hopper@example.com"]);
  for (const message of grace) {
    assert.equal(message.subject, "Introducing Your Personal NOLT Account, Grace Hopper");
    assert.match(message.html, /2222222222/);
    assert.doesNotMatch(message.html, /1111111111/);
  }
});
