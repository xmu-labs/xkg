/**
 * The Lunar Graphite backdrop artwork, fixed behind the page.
 *
 *  - "full": entry pages (sign-in, onboarding), where the artwork is the hero.
 *  - "quiet": working screens, dimmed so it never competes with content.
 *
 * Rendered by each page rather than the layout, so pages that should stay
 * plain (the legal pages, Next's built-in error page) don't get it. CSS in
 * globals.css picks the theme and orientation variant.
 */
export default function Backdrop({ strength = "full" }: { strength?: "full" | "quiet" }) {
  return <div aria-hidden="true" className={`backdrop backdrop-${strength}`} />;
}
