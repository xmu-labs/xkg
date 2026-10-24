/**
 * Where a capture lands on GitHub: `inbox/<filename>` on `main`, the branch
 * githubPut writes to (not HEAD, which follows a repo's default branch).
 */
export function captureFileUrl(repo: string, filename: string): string {
  return `https://github.com/${repo}/blob/main/inbox/${encodeURIComponent(filename)}`;
}
