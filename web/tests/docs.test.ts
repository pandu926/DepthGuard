import { describe, expect, it } from "vitest";
import katex from "katex";
import {
  blockText,
  docBySlug,
  docGroups,
  docPages,
  searchDocs,
} from "../src/docs/content";

describe("public handbook", () => {
  it("has one navigable chapter entry for every page and resolves internal article links", () => {
    const slugs = docGroups.flatMap((g) => g.pages);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(slugs)).toEqual(new Set(docPages.map((p) => p.slug)));
    for (const page of docPages) {
      expect(new Set(page.sections.map((s) => s.id)).size).toBe(
        page.sections.length,
      );
      for (const section of page.sections) {
        for (const block of section.blocks) {
          for (const link of blockText(block).matchAll(
            /\]\(\/docs\/([^)#]+)(?:#([^)]*))?\)/g,
          )) {
            const target = docBySlug.get(link[1]);
            expect(target, `Missing article ${link[1]}`).toBeDefined();
            if (link[2])
              expect(target!.sections.some((s) => s.id === link[2])).toBe(true);
          }
        }
      }
    }
  });
  it("renders every theoretical equation as accessible MathML without HTML extension trust", () => {
    let count = 0;
    for (const page of docPages)
      for (const section of page.sections)
        for (const block of section.blocks) {
          if (block.type !== "equation") continue;
          const rendered = katex.renderToString(block.latex, {
            output: "mathml",
            displayMode: true,
            throwOnError: true,
            trust: false,
            strict: "error",
            maxExpand: 100,
            maxSize: 20,
          });
          expect(rendered).toContain("<math");
          expect(rendered).not.toMatch(/<script|<iframe|style=/);
          count++;
        }
    expect(count).toBeGreaterThan(15);
  });
  it("finds body content and mathematical topics, not just page titles", () => {
    expect(
      searchDocs("minimum payout").some((r) =>
        ["reserve-economy", "holder-rights", "redemption-math"].includes(
          r.page.slug,
        ),
      ),
    ).toBe(true);
    expect(
      searchDocs("conservation").some(
        (r) => r.page.slug === "capital-conservation",
      ),
    ).toBe(true);
    expect(
      searchDocs("outstanding supply").some(
        (r) => r.page.slug === "redemption-math",
      ),
    ).toBe(true);
    expect(searchDocs("unknownxqz")).toEqual([]);
    expect(searchDocs(" ")).toEqual([]);
  });
});
