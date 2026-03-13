import { describe, expect, it } from "vitest";
import { parseQuickOpenQuery, rankQuickOpenMatches } from "./quick-open";

describe("parseQuickOpenQuery", () => {
  it("extracts line suffix", () => {
    expect(parseQuickOpenQuery("src/App.tsx:42")).toEqual({ query: "src/App.tsx", line: 42 });
  });

  it("keeps raw query when no valid line suffix exists", () => {
    expect(parseQuickOpenQuery("src/App.tsx:abc")).toEqual({ query: "src/App.tsx:abc" });
  });
});

describe("rankQuickOpenMatches", () => {
  const files = [
    "src/components/AppLayout.tsx",
    "src/components/ProjectFilesPanel.tsx",
    "electron/src/ipc/files.ts",
  ];

  it("ranks exact basename prefix higher", () => {
    const results = rankQuickOpenMatches(files, "AppL");
    expect(results[0]?.path).toBe("src/components/AppLayout.tsx");
  });

  it("supports fuzzy subsequence matches", () => {
    const results = rankQuickOpenMatches(files, "prfpn");
    expect(results[0]?.path).toBe("src/components/ProjectFilesPanel.tsx");
  });
});
