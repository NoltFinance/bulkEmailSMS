const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

export function extractSubject(template) {
  const match = template.match(/<!--\s*subject:\s*([\s\S]*?)\s*-->/i);
  return match ? match[1].trim() : "";
}

export function stripSubjectComment(template) {
  return template.replace(/<!--\s*subject:[\s\S]*?-->\s*/i, "");
}

function fill(template, context, { html }) {
  const missing = [];
  const rendered = template.replace(PLACEHOLDER, (_, rawKey) => {
    const key = rawKey.trim();
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      missing.push(key);
      return "";
    }
    const value = String(context[key] ?? "");
    if (value.trim() === "") {
      missing.push(`${key} (blank)`);
      return "";
    }
    return html ? escapeHtml(value) : value;
  });
  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    throw new Error(`missing or blank: ${unique.join(", ")}`);
  }
  return rendered;
}

export function renderHtml(template, context) {
  return fill(stripSubjectComment(template), context, { html: true });
}

export function renderText(template, context) {
  return sanitizeHeader(fill(template, context, { html: false }));
}

export function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
