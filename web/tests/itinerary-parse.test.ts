import { describe, expect, it } from "vitest";

import { findDates, parseItineraryText, SAMPLE_ITINERARY_TEXT } from "../lib/itinerary/parse";
import { extractPdfText, looksLikePdf } from "../lib/itinerary/pdf-text";

describe("date extraction", () => {
  it("reads ranges and single dates", () => {
    expect(findDates("12 - 16 December 2026")).toEqual({ start: "2026-12-12", end: "2026-12-16" });
    expect(findDates("12–16 Dec 2026")).toEqual({ start: "2026-12-12", end: "2026-12-16" });
    expect(findDates("2 Jan 2027 to 8 Jan 2027")).toEqual({ start: "2027-01-02", end: "2027-01-08" });
    expect(findDates("2026-12-12 - 2026-12-16")).toEqual({ start: "2026-12-12", end: "2026-12-16" });
    expect(findDates("12/12/2026").start).toBe("2026-12-12");
    expect(findDates("Check in 3 March 2026").start).toBe("2026-03-03");
  });
  it("rejects impossible dates", () => {
    expect(findDates("31 February 2026").start).toBeUndefined();
    expect(findDates("no dates here")).toEqual({});
  });
});

describe("itinerary parsing", () => {
  const parsed = parseItineraryText(SAMPLE_ITINERARY_TEXT);

  it("pulls the trip shape out of the sample", () => {
    expect(parsed.destination).toMatch(/Manali/);
    expect(parsed.startDate).toBe("2026-12-12");
    expect(parsed.endDate).toBe("2026-12-16");
    expect(parsed.travellers).toBe(6);
  });

  it("finds every priced line and categorises it", () => {
    expect(parsed.items.length).toBe(9);
    const byTitle = (needle: string) => parsed.items.find((i) => i.title.toLowerCase().includes(needle))!;
    expect(byTitle("volvo bus delhi").estimatedPaise).toBe(21_600_00);
    expect(byTitle("volvo bus delhi").category).toBe("Transport");
    expect(byTitle("homestay").estimatedPaise).toBe(62_000_00);
    expect(byTitle("homestay").category).toBe("Stay");
    expect(byTitle("paragliding").category).toBe("Activity");
    expect(byTitle("breakfast").category).toBe("Food");
    expect(byTitle("local cab").category).toBe("Local travel");
  });

  it("skips totals and other noise", () => {
    expect(parsed.items.some((i) => /^total/i.test(i.title))).toBe(false);
  });

  it("keeps the source line as evidence for the review screen", () => {
    for (const item of parsed.items) {
      expect(item.evidence.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(item.confidence);
    }
  });

  it("reads several rupee formats", () => {
    const parsedAmounts = parseItineraryText(["Hotel ₹1,20,000", "Cab Rs. 2500.50", "Guide INR 3,000", "Tickets 4500/-"].join("\n"));
    expect(parsedAmounts.items.map((i) => i.estimatedPaise)).toEqual([1_20_000_00, 2_500_50, 3_000_00, 4_500_00]);
  });

  it("returns nothing rather than guessing when there are no prices", () => {
    const empty = parseItineraryText("Day 1 arrive\nDay 2 explore the town\nDay 3 head home");
    expect(empty.items).toHaveLength(0);
    expect(empty.textLength).toBeGreaterThan(0);
  });

  it("uses the previous line as the title when the price stands alone", () => {
    const result = parseItineraryText("Deluxe room with balcony\n₹18,000");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Deluxe room with balcony");
    expect(result.items[0].estimatedPaise).toBe(18_000_00);
  });
});

describe("pdf text extraction", () => {
  /** A minimal uncompressed PDF with a text layer, built by hand. */
  function makePdf(lines: string[]): Uint8Array {
    const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
    const objects = [
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj",
      `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`,
    ];
    const pdf = `%PDF-1.4\n${objects.join("\n")}\ntrailer<</Root 1 0 R>>\n%%EOF`;
    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i);
    return bytes;
  }

  it("recognises a PDF header", () => {
    expect(looksLikePdf(makePdf(["x"]))).toBe(true);
    expect(looksLikePdf(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("reads an uncompressed text layer end to end", () => {
    const bytes = makePdf(["Manali Trip", "12 - 16 December 2026", "Homestay Old Manali Rs 62,000", "Paragliding Rs 18,000"]);
    const text = extractPdfText(bytes);
    expect(text).toContain("Manali Trip");
    expect(text).toContain("62,000");

    const parsed = parseItineraryText(text);
    expect(parsed.startDate).toBe("2026-12-12");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].estimatedPaise).toBe(62_000_00);
    expect(parsed.items[0].category).toBe("Stay");
    expect(parsed.items[1].estimatedPaise).toBe(18_000_00);
  });

  it("returns nothing for a file with no text layer, rather than inventing content", () => {
    expect(extractPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]))).toBe("");
  });
});
