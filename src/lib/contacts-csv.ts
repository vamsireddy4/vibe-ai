// Contacts from a CSV file (WhatsApp Contacts and Audiences "Import CSV"). Checked by contacts-csv.test.ts.

export type CsvContact = { name: string; phone: string; email?: string };

/** One CSV line into cells: commas inside "quotes" and "" escapes are kept. */
export function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i += 1; } else inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) { values.push(current.trim()); current = ""; continue; }
    current += char;
  }
  values.push(current.trim());
  return values.map((v) => v.replace(/\r/g, ""));
}

const key = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
const NAME = ["name", "fullname", "contactname", "firstname"];
const PHONE = ["phone", "phonenumber", "mobile", "mobilenumber", "whatsapp", "whatsappnumber", "number", "contactnumber"];
const EMAIL = ["email", "emailaddress"];

/**
 * Contacts from CSV text: needs a phone column (a name column is optional; the phone is used as the name).
 * Phone numbers keep only digits and a leading +. Duplicate phones keep the last row.
 */
export function parseContactsCsv(text: string): { contacts: CsvContact[]; error?: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { contacts: [], error: "The file needs a header row and at least one contact." };
  const headers = parseCsvLine(lines[0]).map(key);
  const col = (names: string[]) => headers.findIndex((h) => names.includes(h));
  const [nameAt, phoneAt, emailAt] = [col(NAME), col(PHONE), col(EMAIL)];
  if (phoneAt === -1) return { contacts: [], error: "Add a column called “phone” (and optionally “name” and “email”)." };
  const byPhone = new Map<string, CsvContact>();
  for (const row of lines.slice(1).map(parseCsvLine)) {
    const raw = row[phoneAt] ?? "";
    const phone = (raw.trim().startsWith("+") ? "+" : "") + raw.replace(/\D/g, "");
    if (phone.replace("+", "").length < 7) continue; // not a phone number
    const email = emailAt >= 0 ? row[emailAt]?.trim() : "";
    byPhone.set(phone, { name: (nameAt >= 0 ? row[nameAt]?.trim() : "") || phone, phone, ...(email ? { email } : {}) });
  }
  const contacts = [...byPhone.values()];
  return contacts.length ? { contacts } : { contacts, error: "No rows with a valid phone number were found." };
}
