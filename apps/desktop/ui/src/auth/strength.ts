/** 0..4 password strength; minimum length is 10 (P03). */
export function passwordStrength(pw: string): { score: number; label: string } {
  if (pw.length < 10) return { score: Math.min(1, pw.length ? 1 : 0), label: 'Too short (min 10)' };
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  const score = Math.min(
    4,
    1 + (classes >= 3 ? 2 : classes >= 2 ? 1 : 0) + (pw.length >= 14 ? 1 : 0),
  );
  return { score, label: ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][score]! };
}
