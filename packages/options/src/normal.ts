/** Standard normal density. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal cumulative distribution, double precision (Hart 1968 as published by
 * G. West, "Better approximations to cumulative normal functions", 2005). Absolute error < 1e-14.
 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const z = Math.abs(x);
  let c: number;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let b = 3.52624965998911e-2 * z + 0.700383064443688;
      b = b * z + 6.37396220353165;
      b = b * z + 33.912866078383;
      b = b * z + 112.079291497871;
      b = b * z + 221.213596169931;
      b = b * z + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * z + 1.75566716318264;
      b = b * z + 16.064177579207;
      b = b * z + 86.7807322029461;
      b = b * z + 296.564248779674;
      b = b * z + 637.333633378831;
      b = b * z + 793.826512519948;
      b = b * z + 440.413735824752;
      c = c / b;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}
