/**
 * Whether a `playwright test` command line runs the "ui" project, so the
 * config knows to start the app server. Playwright takes `--project=ui`,
 * `--project ui`, or several names after one `--project`; with none named
 * it runs every project.
 */
export function selectsUiProject(argv: string[]): boolean {
  const named: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--project=")) {
      named.push(arg.slice("--project=".length));
    } else if (arg === "--project") {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) named.push(argv[++i]!);
    }
  }
  return named.length === 0 || named.includes("ui");
}
