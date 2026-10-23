import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "../db";

/**
 * Self-service deletion: GitHub revocation is best-effort and must never stop
 * the account data from being deleted.
 */

const deleteUserData = vi.fn();
const revokeGithubGrant = vi.fn();

vi.mock("../db", () => ({ deleteUserData: (...a: unknown[]) => deleteUserData(...a) }));
vi.mock("../github", () => ({ revokeGithubGrant: (...a: unknown[]) => revokeGithubGrant(...a) }));

const { deleteAccount, confirmsDeletion } = await import("../account");

const user = { id: 7, github_username: "Octo-Cat", github_token: "gho_token" } as unknown as User;

beforeEach(() => {
  deleteUserData.mockReset().mockResolvedValue(undefined);
  revokeGithubGrant.mockReset();
  vi.stubEnv("GITHUB_CLIENT_ID", "client-id");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "client-secret");
});

describe("deleteAccount", () => {
  it("revokes the GitHub grant with the app's credentials, then deletes the data", async () => {
    revokeGithubGrant.mockResolvedValue(true);
    await expect(deleteAccount(user)).resolves.toEqual({ githubRevoked: true });
    expect(revokeGithubGrant).toHaveBeenCalledWith("client-id", "client-secret", "gho_token");
    expect(deleteUserData).toHaveBeenCalledWith(7, "Octo-Cat");
    expect(revokeGithubGrant.mock.invocationCallOrder[0]).toBeLessThan(deleteUserData.mock.invocationCallOrder[0]!);
  });

  it("still deletes the data when GitHub refuses", async () => {
    revokeGithubGrant.mockResolvedValue(false);
    await expect(deleteAccount(user)).resolves.toEqual({ githubRevoked: false });
    expect(deleteUserData).toHaveBeenCalledOnce();
  });

  it("still deletes the data when GitHub is unreachable", async () => {
    revokeGithubGrant.mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deleteAccount(user)).resolves.toEqual({ githubRevoked: false });
    expect(deleteUserData).toHaveBeenCalledOnce();
  });

  it("skips GitHub when there is no stored token", async () => {
    await deleteAccount({ ...user, github_token: "" });
    expect(revokeGithubGrant).not.toHaveBeenCalled();
    expect(deleteUserData).toHaveBeenCalledOnce();
  });

  it("surfaces a database failure instead of reporting success", async () => {
    revokeGithubGrant.mockResolvedValue(true);
    deleteUserData.mockRejectedValue(new Error("db down"));
    await expect(deleteAccount(user)).rejects.toThrow("db down");
  });
});

describe("confirmsDeletion", () => {
  it("accepts the username in any case, ignoring surrounding spaces", () => {
    expect(confirmsDeletion(user, "octo-cat")).toBe(true);
    expect(confirmsDeletion(user, "  Octo-Cat ")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(confirmsDeletion(user, "octocat")).toBe(false);
    expect(confirmsDeletion(user, "")).toBe(false);
    expect(confirmsDeletion(user, undefined)).toBe(false);
    expect(confirmsDeletion(user, 7)).toBe(false);
  });
});
