import { describe, expect, it } from "vitest";
import { activityLabel } from "./ActivityLogPanel";

describe("activityLabel", () => {
  it("names the actions the backend writes", () => {
    expect(activityLabel("create_project")).toBe("Study created");
    expect(activityLabel("reset_workspace")).toBe("Coding reset");
  });

  it("turns an unknown id into words instead of showing it raw", () => {
    expect(activityLabel("merge_codes")).toBe("Merge codes");
    expect(activityLabel("")).toBe("Activity");
  });
});
