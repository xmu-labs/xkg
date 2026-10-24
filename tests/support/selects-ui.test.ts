import { describe, expect, it } from "vitest";
import { selectsUiProject } from "./selects-ui";

const argv = (...args: string[]) => ["node", "playwright", "test", ...args];

describe("selectsUiProject", () => {
  it("is true when no project is named, since Playwright then runs them all", () => {
    expect(selectsUiProject(argv())).toBe(true);
  });
  it("reads --project=ui and --project ui alike", () => {
    expect(selectsUiProject(argv("--project=ui"))).toBe(true);
    expect(selectsUiProject(argv("--project", "ui"))).toBe(true);
  });
  it("reads a list of projects after one --project", () => {
    expect(selectsUiProject(argv("--project", "network", "ui", "--workers=1"))).toBe(true);
  });
  it("is false for network-only runs, so they never start a browser server", () => {
    expect(selectsUiProject(argv("--project=network"))).toBe(false);
    expect(selectsUiProject(argv("--project", "network", "tests/e2e/x.spec.ts"))).toBe(false);
  });
});
