/** Where a capture lands on GitHub: `inbox/<filename>` on the repo's default branch. */
export function captureFileUrl(repo: string, filename: string): string {
  return `https://github.com/${repo}/blob/HEAD/inbox/${encodeURIComponent(filename)}`;
}
