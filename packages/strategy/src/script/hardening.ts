/**
 * Sandbox hardening for user strategy code (see docs/SECURITY-AUDIT.md, "HT Editor sandbox").
 *
 * Two layers:
 * 1. Scope shadowing (everywhere): user modules are compiled as functions whose parameters
 *    shadow every ambient capability (`fetch`, `WebSocket`, `self`, `globalThis`, `eval`,
 *    `Function`, `process`, `require`, timers, …), so a free identifier can only resolve to the
 *    strategy API or a harmless built-in (Math, Date, JSON, Array, …).
 * 2. Realm lockdown (inside the dedicated sandbox Web Worker / the VPS runner process): the
 *    network and code-loading globals are overwritten on the global object and their prototypes,
 *    and the `constructor` of every function prototype (plain, async, generator, async
 *    generator) is replaced, so `(() => {}).constructor('return this')()` cannot reach the
 *    global object.
 */

/** Identifiers shadowed (bound to `undefined`) in every user module. */
export const SHADOWED_GLOBALS = [
  'self',
  'globalThis',
  'window',
  'global',
  'document',
  'process',
  'module',
  'Deno',
  'Bun',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
  'Request',
  'Response',
  'Headers',
  'navigator',
  'location',
  'importScripts',
  'indexedDB',
  'caches',
  'BroadcastChannel',
  'MessageChannel',
  'Worker',
  'SharedWorker',
  'postMessage',
  'onmessage',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'close',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'eval',
  'Function',
  'WebAssembly',
  'localStorage',
  'sessionStorage',
] as const;

/** Globals removed from the sandbox realm by `lockdownRealm`. */
export const REALM_BLOCKED = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
  'importScripts',
  'indexedDB',
  'caches',
  'BroadcastChannel',
  'Worker',
  'SharedWorker',
  'eval',
  'setTimeout',
  'setInterval',
] as const;

const blocked = (name: string) =>
  function blockedCapability(): never {
    throw new Error(`${name} is not available in the HT Strategy sandbox`);
  };

/**
 * Locks the current realm down. Call it once, after the trusted code has captured what it needs
 * (e.g. `postMessage`) and before any user code runs. `keep` lists globals the host still needs
 * (the VPS runner keeps WebSocket and timers for its own feed).
 */
export function lockdownRealm(keep: readonly string[] = []): string[] {
  const g = globalThis as unknown as Record<string, unknown>;
  const done: string[] = [];
  for (const name of REALM_BLOCKED) {
    if (keep.includes(name)) continue;
    const stub = blocked(name);
    // Own property shadows the prototype chain; also try to delete it from the prototypes.
    let proto: object | null = Object.getPrototypeOf(g) as object | null;
    while (proto) {
      try {
        if (Object.prototype.hasOwnProperty.call(proto, name)) delete (proto as Record<string, unknown>)[name];
      } catch {
        /* non-configurable: shadowed below */
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    try {
      Object.defineProperty(g, name, { value: stub, writable: false, configurable: false });
      done.push(name);
    } catch {
      /* already locked */
    }
  }
  // Function constructors reachable from any function value.
  const ctors = [
    function () {},
    async function () {},
    function* () {},
    async function* () {},
  ].map((f) => Object.getPrototypeOf(f) as object);
  for (const p of ctors) {
    try {
      Object.defineProperty(p, 'constructor', {
        value: blocked('Function constructor'),
        writable: false,
        configurable: false,
      });
    } catch {
      /* already locked */
    }
  }
  if (!keep.includes('Function')) {
    try {
      Object.defineProperty(g, 'Function', {
        value: blocked('Function'),
        writable: false,
        configurable: false,
      });
      done.push('Function');
    } catch {
      /* already locked */
    }
  }
  return done;
}

/** Defense in depth for compiled code: no ES module loading may survive compilation. */
export function forbiddenSyntax(code: string): string | null {
  if (/\bimport\s*\(/.test(code)) return 'Dynamic import() is not allowed in strategies';
  if (/\bimport\s*\.\s*meta\b/.test(code)) return 'import.meta is not allowed in strategies';
  if (/^\s*import[\s{*'"]/m.test(code)) return 'ES module imports must be compiled first';
  return null;
}
