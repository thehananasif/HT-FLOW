/**
 * Brand artwork supplied by the owner (sources in apps/desktop/branding, optimised copies in
 * ui/public/brand): the HT Flow app icon and the "HANAN TRADE" bull-head logo. The product name in
 * text stays "HT Flow"; the logo is the owner's brand mark.
 */
const base = (import.meta.env.BASE_URL ?? '/').replace(/\/?$/, '/');

export const BRAND_URLS = {
  icon32: `${base}brand/icon-32.png`,
  icon128: `${base}brand/icon-128.png`,
  icon256: `${base}brand/icon-256.webp`,
  /** Original artwork on its light studio background (use on a light card). */
  logo: `${base}brand/hanan-trade-logo.webp`,
  /** Background removed; black chrome reads on dark and light surfaces alike. */
  logoTransparent: `${base}brand/hanan-trade-logo-transparent.webp`,
} as const;

/** The app icon (glossy black bars on a white rounded square). */
export function BrandIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <img
      className={className}
      src={size > 64 ? BRAND_URLS.icon256 : size > 32 ? BRAND_URLS.icon128 : BRAND_URLS.icon32}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: 'block', borderRadius: size * 0.22 }}
    />
  );
}

/** The "HANAN TRADE" brand logo. `card` puts the original on a light rounded card. */
export function BrandLogo({
  height = 120,
  card = false,
  className,
  testId = 'brand-logo',
}: {
  height?: number;
  card?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <img
      className={`brand-logo${card ? ' brand-logo-card' : ''}${className ? ` ${className}` : ''}`}
      src={card ? BRAND_URLS.logo : BRAND_URLS.logoTransparent}
      height={height}
      alt="HANAN TRADE"
      draggable={false}
      data-testid={testId}
      style={{ height, width: card ? height : 'auto' }}
    />
  );
}
