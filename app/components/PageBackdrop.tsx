"use client";

import AmbientBackdrop from "./home/AmbientBackdrop";

/**
 * The app pages' atmospheric background.
 *
 * This is deliberately a one-line wrapper around the HOME PAGE's
 * `AmbientBackdrop` rather than a second implementation: the whole point is
 * that dashboard / analytics / about / docs / … render the SAME grid, glow
 * blobs, path field and vignette the hero does, so the site reads as one
 * surface. A parallel implementation would drift the moment either side is
 * tuned — which is exactly how the flat-black app pages diverged from the
 * home page in the first place.
 *
 * Usage — two lines per page:
 *   1. render <PageBackdrop /> anywhere inside the page root, and
 *   2. make the page root's `background` transparent.
 *
 * (2) matters because every app page root sets an opaque `background: var(--bg)`
 * of its own, which would simply cover this. It is safe to drop: `body`
 * already paints `var(--bg)` in globals.css, so the page keeps its base colour
 * either way — this layer just gets to show through.
 *
 * No content markup needs to change: the backdrop sits at z-index -1. See the
 * `variant` docs in AmbientBackdrop for why that specific value is what makes
 * a drop-in possible.
 */
export default function PageBackdrop() {
  return <AmbientBackdrop variant="page" />;
}
