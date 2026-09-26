import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The extension's page scanner (extension/scan.js) run against a tiny fake DOM:
 * just enough of TreeWalker / innerText / getComputedStyle for what scan.js reads.
 */

type El = { tag: string; style: Record<string, string>; children: (El | Txt)[]; parentElement: El | null; readonly innerText: string };
type Txt = { nodeValue: string; parentElement: El | null };
const BLOCK = new Set(["body", "div", "li", "ul", "p", "h1", "h3"]);

function h(tag: string, style: Record<string, string> | null, ...kids: (El | string)[]): El {
  const el: El = {
    tag,
    style: style ?? {},
    children: [],
    parentElement: null,
    get innerText(): string {
      return el.children.map((c) => ("tag" in c ? c.innerText + (BLOCK.has(c.tag) ? "\n" : "") : c.nodeValue)).join("");
    },
  };
  for (const k of kids) {
    const node: El | Txt = typeof k === "string" ? { nodeValue: k, parentElement: el } : k;
    if ("tag" in node) node.parentElement = el;
    el.children.push(node);
  }
  return el;
}

function scan(body: El) {
  const all: El[] = [];
  const texts: Txt[] = [];
  const walk = (el: El) => {
    all.push(el);
    for (const c of el.children) ("tag" in c ? walk(c) : texts.push(c));
  };
  walk(body);
  const window: Record<string, unknown> = {};
  const ctx = {
    window,
    location: { hostname: "www.makemytrip.com", href: "https://www.makemytrip.com/review" },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: (el: El) => ({ visibility: "visible", display: "block", textDecorationLine: el.style.textDecoration ?? "none", fontSize: el.style.fontSize ?? "14px" }),
    document: {
      title: "Review your booking",
      body,
      createTreeWalker: () => {
        let i = 0;
        return { nextNode: () => texts[i++] ?? null };
      },
      querySelectorAll: () => all.filter((e) => ["div", "li", "p", "span", "label"].includes(e.tag)),
    },
  };
  for (const e of all) Object.assign(e, { getBoundingClientRect: () => ({ width: 100, height: 20 }) });
  runInNewContext(readFileSync(path.resolve(__dirname, "../../extension/scan.js"), "utf8"), ctx);
  return (window.__groupTripScan as () => { amountPaise: number | null; offerTexts: string[] })();
}

describe("extension page scan", () => {
  it("finds the total when ₹ and the digits are in separate elements, not the taxes line", () => {
    const body = h(
      "body",
      null,
      h("div", null, "New Delhi → Goa · Sun, 11 Oct 2026"),
      h(
        "div",
        null,
        h("h3", null, "Fare Summary"),
        h("div", null, "Base Fare ", h("span", null, "₹"), h("span", null, "11,020")),
        h("div", null, "Taxes and Surcharges ", h("span", null, "₹ 2,228")),
        h("div", null, "Was ", h("span", { textDecoration: "line-through" }, "₹ 15,990")),
        h("div", null, "Total Amount ", h("span", { fontSize: "22px" }, h("span", null, "₹"), " ", h("span", null, "13,248"))),
      ),
    );
    expect(scan(body).amountPaise).toBe(1324800);
  });

  it("reads Indian digit grouping and the labelled total over bigger unrelated prices", () => {
    const body = h(
      "body",
      null,
      h("div", null, h("span", { fontSize: "18px" }, "₹ 12,948"), " refund if you cancel"),
      h("div", null, h("div", null, "Base Fare ", h("span", null, "₹ 1,09,552")), h("div", null, "Total Amount ", h("span", null, "₹ 1,23,456"))),
    );
    expect(scan(body).amountPaise).toBe(12345600);
  });

  it("does not read 'rs' inside words as rupees, and lists card offers", () => {
    const body = h(
      "body",
      null,
      h("div", null, "Travellers 12,500 km"),
      h("div", null, "You pay ", h("span", null, "Rs. 4,999")),
      h("ul", null, h("li", null, "12% instant discount on ICICI Bank credit cards, up to ₹1,500"), h("li", null, "Free cancellation on this fare")),
    );
    const s = scan(body);
    expect(s.amountPaise).toBe(499900);
    expect(s.offerTexts).toEqual(["12% instant discount on ICICI Bank credit cards, up to ₹1,500"]);
  });
});
