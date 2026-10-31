/**
 * Where a capture lands on GitHub: `<folder>/<filename>` on `main`, the branch
 * githubPut writes to (not HEAD, which follows a repo's default branch). New
 * captures are in `inbox/`.
 */
export function captureFileUrl(repo: string, filename: string, folder = "inbox"): string {
  return `https://github.com/${repo}/blob/main/${folder}/${encodeURIComponent(filename)}`;
}
