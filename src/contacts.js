const STRICT_EMAIL_HEADER = /^(e-?mails?|e-?mail(?:\s+address(?:es)?)?|e-?mails?[\s_-]*\d+|e-?mail[\s_-]*\d+)$/i;
const EMAIL_WORD = /\be-?mail\b/i;
const EMAIL_ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function isEmail(value) {
  return EMAIL_ADDRESS.test(value);
}

export function splitEmailCell(value) {
  return String(value)
    .split(/[;,\n|]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const angle = part.match(/<([^>]+)>/);
      return (angle ? angle[1] : part).trim();
    })
    .filter(Boolean);
}

function looksLikeEmailList(value) {
  const parts = splitEmailCell(value);
  return parts.length > 0 && parts.every(isEmail);
}

export function isEmailColumn(header, values) {
  if (STRICT_EMAIL_HEADER.test(header.trim())) return true;
  if (!EMAIL_WORD.test(header)) return false;
  const nonempty = values.map((value) => value.trim()).filter(Boolean);
  if (nonempty.length === 0) return false;
  return nonempty.every(looksLikeEmailList);
}

function dedupeEmails(emails) {
  const seen = new Set();
  const unique = [];
  for (const email of emails) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(email);
  }
  return unique;
}

export function buildContacts(matrix) {
  if (!matrix.length) throw new Error("The contact file is empty");
  const rawHeaders = matrix[0].map((header) => String(header ?? "").trim());
  let headerCount = rawHeaders.length;
  while (headerCount > 0 && rawHeaders[headerCount - 1] === "") headerCount -= 1;
  const headers = rawHeaders.slice(0, headerCount);
  if (headers.length === 0 || headers.every((header) => header === "")) {
    throw new Error("The header row is empty");
  }

  const seenHeaders = new Set();
  headers.forEach((header, index) => {
    if (!header) throw new Error(`Empty header in column ${index + 1}`);
    const key = header.toLowerCase();
    if (seenHeaders.has(key)) throw new Error(`Duplicate column "${header}"`);
    seenHeaders.add(key);
  });
  if (headers.some((header) => header.toLowerCase() === "to_email")) {
    throw new Error('Column "to_email" is reserved. Each message receives it automatically for the address being sent.');
  }

  const dataRows = [];
  for (let index = 1; index < matrix.length; index += 1) {
    const raw = matrix[index].map((cell) => String(cell ?? "").trim());
    while (raw.length > headers.length && raw[raw.length - 1] === "") raw.pop();
    if (raw.length > headers.length) {
      throw new Error(`Row ${index + 1} has more values than the header row`);
    }
    while (raw.length < headers.length) raw.push("");
    if (raw.every((cell) => cell === "")) continue;
    dataRows.push({ rowNumber: index + 1, cells: raw });
  }
  if (dataRows.length === 0) throw new Error("No contact rows found");

  const emailColumnIndexes = headers
    .map((header, index) => {
      const values = dataRows.map((row) => row.cells[index]);
      return isEmailColumn(header, values) ? index : -1;
    })
    .filter((index) => index >= 0);

  if (emailColumnIndexes.length === 0) {
    throw new Error(
      "No email column found. Name address columns email, emails, email 2, Work Email, or similar, and keep other columns as personalization fields.",
    );
  }

  const contacts = [];
  const rowErrors = [];
  for (const row of dataRows) {
    const fields = {};
    headers.forEach((header, index) => {
      fields[header] = row.cells[index];
    });

    const emails = [];
    const invalid = [];
    for (const index of emailColumnIndexes) {
      if (!row.cells[index]) continue;
      for (const address of splitEmailCell(row.cells[index])) {
        if (!isEmail(address)) invalid.push(address);
        else emails.push(address);
      }
    }

    if (invalid.length > 0) {
      rowErrors.push(`Row ${row.rowNumber}: invalid email (${invalid.join(", ")})`);
      continue;
    }
    const unique = dedupeEmails(emails);
    if (unique.length === 0) {
      rowErrors.push(`Row ${row.rowNumber}: no email address`);
      continue;
    }

    contacts.push({
      rowNumber: row.rowNumber,
      fields: Object.freeze(fields),
      emails: Object.freeze(unique),
    });
  }

  if (rowErrors.length > 0) {
    throw new Error(`Contact sheet problems:\n${rowErrors.join("\n")}`);
  }

  return {
    contacts,
    emailColumns: emailColumnIndexes.map((index) => headers[index]),
    fieldColumns: headers.filter((_, index) => !emailColumnIndexes.includes(index)),
  };
}

export function findSharedEmails(contacts) {
  const rowsByEmail = new Map();
  for (const contact of contacts) {
    for (const email of contact.emails) {
      const key = email.toLowerCase();
      if (!rowsByEmail.has(key)) rowsByEmail.set(key, []);
      rowsByEmail.get(key).push(contact.rowNumber);
    }
  }
  return [...rowsByEmail.entries()]
    .filter(([, rows]) => new Set(rows).size > 1)
    .map(([email, rows]) => ({ email, rows }));
}

export function assertUniqueRecipients(contacts) {
  const shared = findSharedEmails(contacts);
  if (shared.length === 0) return;
  const lines = shared.map((item) => `${item.email} on rows ${item.rows.join(", ")}`);
  throw new Error(
    `The same address is on more than one row, so those messages would not have a single owner:\n${lines.join("\n")}\nGive each address one row, or pass --allow-duplicate-emails if sending both versions is intentional.`,
  );
}
