/**
 * Splits a Why or Impact line into prose and code names, so the capture page
 * can show names as code chips. Backticked names are code; so are bare file
 * names and paths the model wrote without backticks ("suggest.ts",
 * "packages/llm/src/policy.ts"). The text itself is never changed.
 */

export interface TextPart {
  code: boolean;
  text: string;
}

const EXT = "tsx?|jsx?|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|md|mdx|json|ya?ml|toml|css|scss|html|sql|sh|vue|svelte";
// A path or file name with a code extension, not glued to more word characters.
const FILE = new RegExp(`(?<![\\w./-])(?:[\\w.-]+/)*[\\w-][\\w.-]*\\.(?:${EXT})(?![\\w/-]|\\.\\w)`, "g");
// Product names like Node.js or Vue.js are prose, not files.
const PRODUCT = /^[A-Z][a-z]+\.js$/;

function bareNames(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(FILE)) {
    if (PRODUCT.test(m[0])) continue;
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

export function splitCode(text: string): TextPart[] {
  return text.split("`").flatMap((part, i) => (i % 2 ? [{ code: true, text: part }] : bareNames(part))).filter((p) => p.text);
}
