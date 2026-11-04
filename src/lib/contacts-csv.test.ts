import { describe, expect, it } from "vitest";
import { parseContactsCsv, parseCsvLine } from "@/lib/contacts-csv";

describe("contacts csv", () => {
  it("splits cells, keeping commas inside quotes", () => {
    expect(parseCsvLine('"Rao, Sai",+91 99 66,"a ""b"" c"')).toEqual(["Rao, Sai", "+91 99 66", 'a "b" c']);
  });

  it("reads name/phone/email columns in any order and cleans phone numbers", () => {
    const r = parseContactsCsv("Email,Phone Number,Full Name\r\nv@x.co,+91 94411-56873,Vamsi\r\n,9966999843,Sai\r\n");
    expect(r).toEqual({ contacts: [{ name: "Vamsi", phone: "+919441156873", email: "v@x.co" }, { name: "Sai", phone: "9966999843" }] });
  });

  it("uses the phone as the name when there is no name, skips bad rows, keeps the last duplicate", () => {
    const r = parseContactsCsv("\uFEFFmobile\n+15550001111\nabc\n+1 555 000 1111\n");
    expect(r.contacts).toEqual([{ name: "+15550001111", phone: "+15550001111" }]);
  });

  it("explains what's wrong with an unusable file", () => {
    expect(parseContactsCsv("name\nVamsi").error).toMatch(/phone/);
    expect(parseContactsCsv("phone").error).toMatch(/header row/);
    expect(parseContactsCsv("phone\nhello").error).toMatch(/valid phone/);
  });
});
