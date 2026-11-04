import { describe, expect, it } from "vitest";
import { bucketByDay } from "./channel-activity";

describe("bucketByDay", () => {
  it("counts each channel per local day, fills empty days with 0 and drops out-of-range events", () => {
    const rows = bucketByDay(
      [
        { channel: "calls", at: new Date(2026, 10, 1, 9).toISOString() },
        { channel: "calls", at: new Date(2026, 10, 1, 23).toISOString() },
        { channel: "sms", at: new Date(2026, 10, 3, 12).toISOString(), count: 40 },
        { channel: "whatsapp", at: new Date(2026, 9, 31, 12).toISOString() }, // before range
      ],
      new Date(2026, 10, 1),
      new Date(2026, 10, 3),
    );
    expect(rows.map((r) => r.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(rows.map((r) => [r.calls, r.sms, r.whatsapp, r.email])).toEqual([[2, 0, 0, 0], [0, 0, 0, 0], [0, 40, 0, 0]]);
  });
});
