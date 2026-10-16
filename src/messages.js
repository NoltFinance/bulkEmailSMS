import { createHash } from "node:crypto";
import { extractSubject, htmlToText, renderHtml, renderText } from "./render.js";

export function messageContext(contact, email) {
  return Object.freeze({
    ...contact.fields,
    to_email: email,
  });
}

export function contentHash(template, subjectTemplate, context) {
  const payload = JSON.stringify({
    template,
    subjectTemplate,
    context,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function buildMessages({ contacts, template, subjectTemplate }) {
  const resolvedSubject = subjectTemplate || extractSubject(template);
  if (!resolvedSubject) {
    throw new Error('No subject. Pass --subject "Hello {{first_name}}" or add <!-- subject: Hello {{first_name}} --> to the template.');
  }

  const messages = [];
  const problems = [];
  for (const contact of contacts) {
    for (const email of contact.emails) {
      const context = messageContext(contact, email);
      try {
        const html = renderHtml(template, context);
        const subject = renderText(resolvedSubject, context);
        if (!subject) throw new Error("subject is empty");
        messages.push(Object.freeze({
          rowNumber: contact.rowNumber,
          to: email,
          subject,
          html,
          text: htmlToText(html),
          context,
          hash: contentHash(template, resolvedSubject, context),
        }));
      } catch (error) {
        problems.push(`Row ${contact.rowNumber} <${email}>: ${error.message}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Template problems:\n${problems.join("\n")}`);
  }

  const contexts = new Set();
  for (const message of messages) {
    if (contexts.has(message.context)) {
      throw new Error(`Row ${message.rowNumber} reused another message's data`);
    }
    contexts.add(message.context);
    if (message.context.to_email !== message.to) {
      throw new Error(`Row ${message.rowNumber} was addressed to ${message.to} but rendered for ${message.context.to_email}`);
    }
  }

  return messages;
}
