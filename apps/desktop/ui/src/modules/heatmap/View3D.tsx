import { useEffect, useRef, useState } from 'react';
import type * as ThreeNs from 'three';
import { isoProject, type Surface } from '@htflow/heatmap';
import type { Camera } from './model';
import { DEFAULT_CAMERA } from './model';

export interface View3DProps {
  /** Latest surface (time × price × size) and colour table; polled every frame. */
  surface: () => { s: Surface; lut: Uint8ClampedArray; version: number } | null;
  camera: Camera;
  onCamera: (c: Camera) => void;
  height: number;
  /** 'webgl' uses three.js; 'canvas' forces the Canvas2D isometric fallback. */
  renderer: 'webgl' | 'canvas';
  powerPreference: 'default' | 'high-performance' | 'low-power';
  background: string;
  /** Called once with the renderer actually used (WebGL may be unavailable). */
  onRenderer?: (r: 'webgl' | 'canvas') => void;
}

const clampPitch = (p: number) => Math.min(1.5, Math.max(0.05, p));
const clampDist = (d: number) => Math.min(8, Math.max(1, d));

/**
 * Hand-written orbit controls: drag = orbit, wheel = zoom, double-click = reset, arrow keys /
 * +/- from the keyboard. Works for both renderers.
 */
function useOrbit(
  el: React.RefObject<HTMLElement | null>,
  cam: React.MutableRefObject<Camera>,
  onChange: () => void,
  onCommit: (c: Camera) => void,
) {
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let drag: { x: number; y: number; cam: Camera } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, cam: { ...cam.current } };
      node.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      cam.current = {
        ...cam.current,
        yaw: drag.cam.yaw - (e.clientX - drag.x) * 0.008,
        pitch: clampPitch(drag.cam.pitch + (e.clientY - drag.y) * 0.006),
      };
      onChange();
    };
    const up = () => {
      if (!drag) return;
      drag = null;
      onCommit(cam.current);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.current = {
        ...cam.current,
        dist: clampDist(cam.current.dist * Math.exp(e.deltaY * 0.001)),
      };
      onChange();
      onCommit(cam.current);
    };
    const dbl = () => {
      cam.current = { ...DEFAULT_CAMERA };
      onChange();
      onCommit(cam.current);
    };
    const key = (e: KeyboardEvent) => {
      const c = cam.current;
      const step = e.shiftKey ? 0.2 : 0.06;
      let next: Camera | null = null;
      if (e.key === 'ArrowLeft') next = { ...c, yaw: c.yaw + step };
      else if (e.key === 'ArrowRight') next = { ...c, yaw: c.yaw - step };
      else if (e.key === 'ArrowUp') next = { ...c, pitch: clampPitch(c.pitch + step) };
      else if (e.key === 'ArrowDown') next = { ...c, pitch: clampPitch(c.pitch - step) };
      else if (e.key === '+' || e.key === '=') next = { ...c, dist: clampDist(c.dist * 0.9) };
      else if (e.key === '-') next = { ...c, dist: clampDist(c.dist / 0.9) };
      else if (e.key === 'Home') next = { ...DEFAULT_CAMERA };
      if (!next) return;
      e.preventDefault();
      cam.current = next;
      onChange();
      onCommit(next);
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('wheel', wheel, { passive: false });
    node.addEventListener('dblclick', dbl);
    node.addEventListener('keydown', key);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('dblclick', dbl);
      node.removeEventListener('keydown', key);
    };
  }, [el, cam, onChange, onCommit]);
}

/** P11 3D mode: extruded depth surface (time × price × size) in the same colours as the 2D map. */
export function View3D(props: View3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const cam = useRef<Camera>(props.camera);
  const dirty = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  const [used, setUsed] = useState<'webgl' | 'canvas' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cam.current = props.camera;
    dirty.current = true;
  }, [props.camera]);

  const onChange = useRef(() => (dirty.current = true)).current;
  const onCommit = useRef((c: Camera) => latest.current.onCamera(c)).current;
  useOrbit(host, cam, onChange, onCommit);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    const report = (r: 'webgl' | 'canvas') => {
      setUsed(r);
      latest.current.onRenderer?.(r);
    };
    const startCanvas = () => {
      if (disposed) return;
      stop = startIsometric(el, latest, cam, dirty);
      report('canvas');
    };
    if (props.renderer === 'canvas' || !webglAvailable()) startCanvas();
    else {
      import('three')
        .then((THREE) => {
          if (disposed) return;
          try {
            stop = startThree(THREE, el, latest, cam, dirty);
            report('webgl');
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            startCanvas();
          }
        })
        .catch(() => startCanvas());
    }
    return () => {
      disposed = true;
      stop?.();
    };
  }, [props.renderer, props.powerPreference]);

  return (
    <div
      ref={host}
      className="hm-3d"
      tabIndex={0}
      role="img"
      aria-label="3D liquidity surface — drag to orbit, wheel to zoom, double-click to reset"
      data-testid="heatmap-3d"
      data-renderer={used ?? ''}
    >
      <div className="hm-3d-hint">
        3D · {used === 'webgl' ? 'three.js' : used === 'canvas' ? 'Canvas 2D (isometric)' : '…'} ·
        drag orbit · wheel zoom · double-click reset
        {error ? ` · WebGL failed: ${error}` : ''}
      </div>
    </div>
  );
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

type Latest = React.MutableRefObject<View3DProps>;
type CamRef = React.MutableRefObject<Camera>;
type Flag = React.MutableRefObject<boolean>;

function startThree(
  THREE: typeof ThreeNs,
  el: HTMLDivElement,
  latest: Latest,
  cam: CamRef,
  dirty: Flag,
): () => void {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: latest.current.powerPreference,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  let mesh: ThreeNs.Mesh | null = null;
  let geomKey = '';
  let version = -1;
  // Floor frame (time × price) for orientation.
  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 0.001, 1.2)),
    new THREE.LineBasicMaterial({ color: 0x5a5a5a }),
  );
  scene.add(frame);

  const resize = () => {
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty.current = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  const rebuild = () => {
    const data = latest.current.surface();
    if (!data || data.version === version) return;
    version = data.version;
    const { s, lut } = data;
    const key = `${s.cols}x${s.rows}`;
    if (key !== geomKey || !mesh) {
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      const g = new THREE.PlaneGeometry(2, 1.2, Math.max(1, s.cols - 1), Math.max(1, s.rows - 1));
      g.rotateX(-Math.PI / 2);
      g.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(g.attributes.position!.count * 3), 3),
      );
      mesh = new THREE.Mesh(g, material);
      scene.add(mesh);
      geomKey = key;
    }
    const pos = mesh.geometry.attributes.position as ThreeNs.BufferAttribute;
    const col = mesh.geometry.attributes.color as ThreeNs.BufferAttribute;
    const hScale = 0.45 * latest.current.height;
    // PlaneGeometry vertices: row-major from the far edge (−z after rotation) to the near edge.
    for (let r = 0; r < s.rows; r++) {
      const row = s.rows - 1 - r; // far edge = highest price
      for (let c = 0; c < s.cols; c++) {
        const v = r * s.cols + c;
        const idx = s.idx[c * s.rows + row]!;
        pos.setY(v, (idx / 255) * hScale);
        col.setXYZ(v, lut[idx * 4]! / 255, lut[idx * 4 + 1]! / 255, lut[idx * 4 + 2]! / 255);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    dirty.current = true;
  };

  let raf = 0;
  let last = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (now - last > 100) {
      last = now;
      rebuild();
    }
    if (!dirty.current) return;
    dirty.current = false;
    scene.background = new THREE.Color(latest.current.background);
    const c = cam.current;
    camera.position.set(
      c.dist * Math.cos(c.pitch) * Math.sin(c.yaw),
      c.dist * Math.sin(c.pitch),
      c.dist * Math.cos(c.pitch) * Math.cos(c.yaw),
    );
    camera.lookAt(0, 0.15, 0);
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    mesh?.geometry.dispose();
    material.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}

/** Canvas2D fallback: isometric quads drawn back to front with the same LUT colours. */
function startIsometric(el: HTMLDivElement, latest: Latest, cam: CamRef, dirty: Flag): () => void {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  el.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  let version = -1;
  const resize = () => {
    const d = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, el.clientWidth * d);
    canvas.height = Math.max(1, el.clientHeight * d);
    dirty.current = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();
  let raf = 0;
  let last = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const data = latest.current.surface();
    if (data && data.version !== version && now - last > 100) {
      version = data.version;
      last = now;
      dirty.current = true;
    }
    if (!dirty.current || !data) return;
    dirty.current = false;
    const { s, lut } = data;
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = latest.current.background;
    ctx.fillRect(0, 0, W, H);
    const c = cam.current;
    const scale = (Math.min(W, H) * 0.95) / c.dist;
    const hScale = 0.45 * latest.current.height;
    // Downsample so the fallback stays interactive.
    const stepC = Math.max(1, Math.ceil(s.cols / 90));
    const stepR = Math.max(1, Math.ceil(s.rows / 60));
    const P = (ci: number, ri: number) => {
      const x = (ci / Math.max(1, s.cols - 1)) * 2 - 1;
      const z = 0.6 - (ri / Math.max(1, s.rows - 1)) * 1.2;
      const idx = s.idx[Math.min(s.cols - 1, ci) * s.rows + Math.min(s.rows - 1, ri)]!;
      const p = isoProject(x, (idx / 255) * hScale - 0.15, z, c.yaw, c.pitch);
      return { x: W / 2 + p.sx * scale, y: H / 2 + p.sy * scale, d: p.depth, idx };
    };
    const quads: { d: number; pts: { x: number; y: number }[]; idx: number }[] = [];
    for (let ci = 0; ci < s.cols - stepC; ci += stepC) {
      for (let ri = 0; ri < s.rows - stepR; ri += stepR) {
        const a = P(ci, ri);
        const b = P(ci + stepC, ri);
        const cc = P(ci + stepC, ri + stepR);
        const d = P(ci, ri + stepR);
        quads.push({
          d: (a.d + b.d + cc.d + d.d) / 4,
          pts: [a, b, cc, d],
          idx: Math.max(a.idx, b.idx, cc.idx, d.idx),
        });
      }
    }
    quads.sort((q1, q2) => q1.d - q2.d);
    ctx.lineWidth = 0.5;
    for (const q of quads) {
      const i = q.idx * 4;
      ctx.fillStyle = `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
      ctx.beginPath();
      ctx.moveTo(q.pts[0]!.x, q.pts[0]!.y);
      for (let k = 1; k < 4; k++) ctx.lineTo(q.pts[k]!.x, q.pts[k]!.y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
    }
  };
  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    canvas.remove();
  };
}
