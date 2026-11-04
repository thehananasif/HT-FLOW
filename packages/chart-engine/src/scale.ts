/** Picks a "nice" tick-multiple step for price labels so that labels are >= minPx apart. */
export function nicePriceStep(tickPx: number, minPx: number): number {
  const bases = [1, 2, 2.5, 5];
  let mult = 1;
  for (;;) {
    for (const b of bases) {
      const step = b * mult;
      if (Number.isInteger(step) && step * tickPx >= minPx) return step;
    }
    mult *= 10;
    if (mult > 1e9) return mult;
  }
}

const TIME_STEPS = [
  1_000,
  5_000,
  15_000,
  30_000,
  60_000,
  300_000,
  900_000,
  1_800_000,
  3_600_000,
  7_200_000,
  14_400_000,
  21_600_000,
  43_200_000,
  86_400_000,
  7 * 86_400_000,
];

/** Picks a time step so that labels are >= minPx apart given average ms per px. */
export function niceTimeStep(msPerPx: number, minPx: number): number {
  for (const s of TIME_STEPS) if (s / msPerPx >= minPx) return s;
  return TIME_STEPS[TIME_STEPS.length - 1]!;
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTime(
  t: number,
  step: number,
  tzOffsetMin = -new Date().getTimezoneOffset(),
): string {
  const d = new Date(t + tzOffsetMin * 60_000);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (step >= 86_400_000 || (h === 0 && m === 0 && step >= 3_600_000))
    return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
  if (step < 60_000) return `${pad(h)}:${pad(m)}:${pad(d.getUTCSeconds())}`;
  return `${pad(h)}:${pad(m)}`;
}

export function formatDateTime(t: number, tzOffsetMin = -new Date().getTimezoneOffset()): string {
  const d = new Date(t + tzOffsetMin * 60_000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[d.getUTCDay()]} ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
