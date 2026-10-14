import { describe, expect, it } from "vitest";
import { labelFromName } from "./AgentDetailPage";

describe("labelFromName", () => {
  it("writes a name out as a label", () => {
    expect(labelFromName("notes-helper")).toBe("Notes Helper");
    expect(labelFromName("release_captain.v2")).toBe("Release Captain V2");
  });

  it("ignores doubled separators", () => {
    expect(labelFromName("a--b")).toBe("A B");
  });
});
