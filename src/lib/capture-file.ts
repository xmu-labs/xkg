import { githubPut } from "@/lib/github";

/** How many names saveNewCapture tries: the plain one, then -2 … -N. */
export const MAX_NAME_TRIES = 20;

/**
 * Save a new capture under `inbox/<stem>.md`, or `<stem>-2.md`, `-3`, … when
 * that name is taken (the same source captured twice in a day, or two sources
 * the model gave the same short name). Never overwrites: each try is a create,
 * which GitHub refuses when the file exists. Returns the file name it used.
 */
export async function saveNewCapture(token: string, repo: string, stem: string, markdown: string): Promise<string> {
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const filename = n === 1 ? `${stem}.md` : `${stem}-${n}.md`;
    try {
      await githubPut(token, repo, `inbox/${filename}`, markdown, `capture: add ${filename}`);
      return filename;
    } catch (err) {
      if ((err as { fileExists?: unknown } | null)?.fileExists !== true) throw err;
    }
  }
  throw new Error(`[capture] Every name from ${stem}.md to ${stem}-${MAX_NAME_TRIES}.md is taken.`);
}
