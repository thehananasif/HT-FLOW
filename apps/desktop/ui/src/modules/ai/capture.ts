/**
 * "AI can see my screen": renders the HT Flow window itself into an image (no OS screen capture,
 * so other apps and windows are never included). Chart canvases are copied pixel for pixel; the
 * DOM (tables, DOM ladder, panels, labels) is redrawn html-to-canvas style: backgrounds, borders
 * and visible text of every element at its on-screen position. Elements marked
 * `data-ai-exclude` (the AI window itself) are skipped.
 */
export interface Capture {
  mediaType: 'image/jpeg';
  /** Base64 (no data: prefix). */
  data: string;
  width: number;
  height: number;
}

const MAX_W = 1600;

function visible(r: DOMRect, vw: number, vh: number): boolean {
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
}

function opaque(c: string): boolean {
  return !!c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
}

/** Draws the DOM layer (boxes + text) and the canvases of `root` onto `ctx`. */
export function paintDom(ctx: CanvasRenderingContext2D, root: Element, vw: number, vh: number): void {
  const all = root.querySelectorAll<HTMLElement>('body *');
  const skip = (el: Element) => !!el.closest('[data-ai-exclude]');
  for (const el of all) {
    if (skip(el) || el instanceof HTMLCanvasElement) continue;
    const r = el.getBoundingClientRect();
    if (!visible(r, vw, vh)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    if (opaque(cs.backgroundColor)) {
      ctx.fillStyle = cs.backgroundColor;
      ctx.fillRect(r.left, r.top, r.width, r.height);
    }
    const bw = parseFloat(cs.borderBottomWidth);
    if (bw > 0 && opaque(cs.borderBottomColor)) {
      ctx.fillStyle = cs.borderBottomColor;
      ctx.fillRect(r.left, r.bottom - bw, r.width, bw);
    }
    let text = '';
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) text += n.textContent ?? '';
    if (el instanceof HTMLInputElement && el.type !== 'password') text = el.value;
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.fillStyle = cs.color;
    ctx.textBaseline = 'middle';
    const pl = parseFloat(cs.paddingLeft) || 0;
    const x =
      cs.textAlign === 'right' || cs.textAlign === 'end'
        ? r.right - (parseFloat(cs.paddingRight) || 0) - ctx.measureText(text).width
        : cs.textAlign === 'center'
          ? r.left + (r.width - ctx.measureText(text).width) / 2
          : r.left + pl;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.left, r.top, r.width, r.height);
    ctx.clip();
    ctx.fillText(text, x, r.top + r.height / 2);
    ctx.restore();
  }
  for (const c of root.querySelectorAll('canvas')) {
    if (skip(c)) continue;
    const r = c.getBoundingClientRect();
    if (!visible(r, vw, vh)) continue;
    try {
      ctx.drawImage(c, r.left, r.top, r.width, r.height);
    } catch {
      // A tainted canvas (none expected) is skipped.
    }
  }
}

/** Captures the app window as a JPEG (≤ 1600 px wide). */
export async function captureWindow(): Promise<Capture> {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(1, MAX_W / vw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.scale(scale, scale);
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#000';
  ctx.fillRect(0, 0, vw, vh);
  paintDom(ctx, document.documentElement, vw, vh);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return {
    mediaType: 'image/jpeg',
    data: url.slice(url.indexOf(',') + 1),
    width: canvas.width,
    height: canvas.height,
  };
}
