import { env } from "./env";

/**
 * True for the one account allowed to open /admin: the GitHub login in
 * ADMIN_GITHUB_LOGIN, compared without case (GitHub logins ignore it). With
 * the variable unset, nobody is.
 */
export function isOwner(user: { github_username?: string | null } | null): boolean {
  const owner = env.adminGithubLogin;
  const login = user?.github_username?.trim().toLowerCase();
  return Boolean(owner && login && login === owner);
}
