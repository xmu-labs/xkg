# Implementation gates
1. Obtain canonical XMU central negative-space path and reconcile width/height versus earlier XKG expressive raster.
2. Review 2D/mono/expressive candidates at 16, 24, 32, 64 and 128 px; create a separately optically corrected favicon master.
3. Turn token candidates into a single semantic source of truth. Current `src/app/globals.css` uses `--bg`, `--fg`, `--fg-muted`, `--gold`, `--btn`, `--btn-hover`, rgba color aliases and manual focus border handlers.
4. Add temporary backwards-compatible aliases; avoid fragile blanket replacement; only remove aliases after callsites are migrated.
5. Update `src/components/BrandMark.tsx`, public favicons/icons and `src/app/layout.tsx` theme colors only after approved visual assets exist.
6. Validate WCAG 2.2 AA: text, interactive borders, focus ring, keyboard navigation, reduced-motion, non-color-only error states and touch targets.
7. Test actual Next.js rendered pages at 360/768/1280 px, dark/light, 200% zoom and 16–64 px icon readability.
8. Update Notion and obtain brand approval before merging a runtime migration.

**No runtime modifications in this candidate branch.**
