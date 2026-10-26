import { describe, expect, it } from "vitest";
import { basename, friendlyLocation } from "./format";

describe("friendlyLocation", () => {
  it("names the home folder Home on macOS, Linux and Windows", () => {
    expect(friendlyLocation("/Users/ada/Fleuron/Study.fleuron")).toEqual([
      "Home",
      "Fleuron",
      "Study.fleuron",
    ]);
    expect(friendlyLocation("/home/ada/research/Study.fleuron")).toEqual([
      "Home",
      "research",
      "Study.fleuron",
    ]);
    expect(friendlyLocation("C:\\Users\\ada\\Documents\\Study.fleuron")).toEqual([
      "Home",
      "Documents",
      "Study.fleuron",
    ]);
  });

  it("keeps every part of a path outside a home folder", () => {
    expect(friendlyLocation("/Volumes/Lab/Study.fleuron")).toEqual(["Volumes", "Lab", "Study.fleuron"]);
  });

  it("does not treat the shared folder or a lookalike as home", () => {
    expect(friendlyLocation("/Users/Shared/Study.fleuron")).toEqual(["Users", "Shared", "Study.fleuron"]);
    expect(friendlyLocation("/Usersx/ada/Study.fleuron")[0]).toBe("Usersx");
  });
});

describe("basename", () => {
  it("survives a trailing separator", () => {
    expect(basename("/a/Study.fleuron/")).toBe("Study.fleuron");
  });
});
