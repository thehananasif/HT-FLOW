/** HT Flow mark: white rounded tile with four ascending bars (original artwork). */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
      <rect width="44" height="44" rx="10" fill="var(--ht-accent, #fff)" />
      <g fill="var(--ht-accent-text, #000)">
        <rect x="11" y="20" width="3.4" height="13" rx="1" />
        <rect x="17.2" y="14" width="3.4" height="19" rx="1" />
        <rect x="23.4" y="17" width="3.4" height="16" rx="1" />
        <rect x="29.6" y="11" width="3.4" height="22" rx="1" />
      </g>
    </svg>
  );
}

export function LogoBars({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <rect x="2" y="7" width="1.6" height="7" rx="0.5" />
      <rect x="5.4" y="4" width="1.6" height="10" rx="0.5" />
      <rect x="8.8" y="6" width="1.6" height="8" rx="0.5" />
      <rect x="12.2" y="2" width="1.6" height="12" rx="0.5" />
    </svg>
  );
}
