# XKG / XMU geometry validation — v1.2

Date: 2026-10-22 · status: candidate review, **not mathematically exact**.

## Decision
Keep the previously shared Bézier outer contour used by every provisional XKG logo. A hand-adjusted redraw intended to improve its fit was tested but performed worse against the flattened XMU reference image; it was rejected. Refinements should therefore focus on subtle interior filaments / nodes without changing the fitted contour pending an original XMU master SVG.

## Raster evaluation
Image: flattened XMU parent-logo central opening, approximate 720×735 px. Both candidate curves sampled, then distance to nearest bright icy-edge pixel calculated as a rough visual registration proxy. This is **not** a true vector-to-vector contour Hausdorff distance: interior filaments and glow can create false matches.

| Candidate | Mean px | Median px | 90th percentile px | Result |
|---|---:|---:|---:|---|
| Existing shared Bézier | 1.72 | 0.00 | 6.33 | Retained |
| New hand-adjusted redraw | 2.79 | 1.41 | 8.49 | Rejected |

Other concerns: approved expressive xkg artwork is wider than the XMU inner void and cannot simultaneously preserve exact outer shape and artwork proportions without creative revision. The original XMU source vector is needed to confirm an exact match.

## Asset record
The original shared contour is unchanged in the provisional svg files under `docs/brand/xkg/logos`. A comparison overlay, raster preview contact sheet and sample renders are included in the separate `xkg_geometry_validation_v1_2.zip` review package in the linked ChatGPT session.

## Release gate
- [x] Compared old/new contour against available raster parent reference.
- [x] Rejected objectively poorer contour; no changes to logo path in this PR.
- [ ] Obtain XMU original SVG/source-quality master and measure exact outline shape distances.
- [ ] Check expressive saddle aesthetic at same topology and approve final outer contour.
- [ ] Review at favicon sizes and with alternate dark/light backgrounds.
- [ ] Only then ship production logos and update application assets.

No runtime paths / production logo imports changed.
