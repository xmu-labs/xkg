import { deleteUserData, type User } from "./db";
import { revokeGithubGrant } from "./github";
import { env } from "./env";

export interface DeleteAccountResult {
  /** False when GitHub could not confirm the revocation; the user should revoke xkg there. */
  githubRevoked: boolean;
}

/**
 * Self-service account deletion.
 *
 * GitHub is asked to revoke xkg's authorization first, while the token is still
 * on hand. That step is best-effort and time-limited: the stored token is
 * deleted either way, so a slow or failing GitHub must not keep someone from
 * deleting their account.
 */
export async function deleteAccount(user: User): Promise<DeleteAccountResult> {
  let githubRevoked = false;
  if (user.github_token) {
    try {
      githubRevoked = await revokeGithubGrant(env.githubClientId, env.githubClientSecret, user.github_token);
    } catch (err) {
      console.error("[account] GitHub revocation failed:", err);
    }
  }

  await deleteUserData(user.id, user.github_username);
  return { githubRevoked };
}

/** The user confirms by typing their GitHub username. GitHub usernames are case-insensitive. */
export function confirmsDeletion(user: Pick<User, "github_username">, typed: unknown): boolean {
  return typeof typed === "string" && typed.trim().toLowerCase() === user.github_username.toLowerCase();
}
