"use client";

/**
 * The xkg saddle mark (Lunar Graphite).
 *
 *  - "flat": the 2D mark, for product chrome at small sizes. It is wide, so
 *    `size` sets the width and the height follows the artwork.
 *  - "expressive": the 3D artwork, for the sign-in and onboarding hero. It
 *    has a transparent background, so it sits on the backdrop artwork.
 *
 * Both theme variants are rendered; CSS shows the one matching data-theme.
 */
const FLAT_RATIO = 613 / 1282;

const SOURCES = {
  flat: { light: "/brand/xkg-2d-light.svg", dark: "/brand/xkg-2d-dark.svg" },
  expressive: { light: "/brand/xkg-expressive-light.png", dark: "/brand/xkg-expressive-dark.png" },
} as const;

export default function BrandMark({
  size,
  variant = "flat",
  className = "",
}: {
  size: number;
  variant?: keyof typeof SOURCES;
  className?: string;
}) {
  const width = size;
  const height = variant === "flat" ? Math.round(size * FLAT_RATIO) : size;
  const src = SOURCES[variant];
  return (
    <span className={`brand-mark ${className}`.trim()} style={{ width, height }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src.light} alt="xkg" width={width} height={height} className="brand-mark-light" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src.dark} alt="" width={width} height={height} className="brand-mark-dark" />
    </span>
  );
}
