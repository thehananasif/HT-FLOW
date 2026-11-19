// In-page half of the "click everything" crawler. Plain browser JavaScript (no imports, no build
// step) so the same file runs under Playwright (page.addInitScript / page.evaluate) and under
// WebdriverIO + tauri-driver against the real WebView2 (browser.execute). It is idempotent and
// installs `window.__CLICKALL__`. Everything it returns is plain JSON.
(function () {
  if (window.__CLICKALL__) return;

  /** @type {{kind: string, message: string, at: number}[]} */
  var errors = [];
  /** @type {string[]} */
  var nativeDialogs = [];
  var fmt = function (a) {
    if (a instanceof Error) return a.message;
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch (e) {
      return String(a);
    }
  };
  var push = function (kind, msg) {
    errors.push({ kind: kind, message: String(msg).slice(0, 600), at: Date.now() });
  };
  window.addEventListener('error', function (e) {
    if (e && e.message) push('pageerror', e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    push('unhandledrejection', r && r.message ? r.message : fmt(r));
  });
  var origError = console.error;
  console.error = function () {
    try {
      push('console.error', Array.prototype.map.call(arguments, fmt).join(' '));
    } catch (x) {
      /* ignore */
    }
    return origError.apply(console, arguments);
  };
  // Native modal dialogs would block a WebDriver session: answer them safely ("Cancel").
  window.alert = function (m) {
    nativeDialogs.push('alert: ' + m);
  };
  window.confirm = function (m) {
    nativeDialogs.push('confirm: ' + m);
    return false;
  };
  window.prompt = function (m) {
    nativeDialogs.push('prompt: ' + m);
    return null;
  };
  // window.print() opens a blocking OS dialog in the desktop app.
  window.print = function () {
    nativeDialogs.push('print');
  };

  // ----------------------------------------------------------------------------- geometry

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
  }
  function intersect(a, b) {
    return {
      x1: Math.max(a.x1, b.x1),
      y1: Math.max(a.y1, b.y1),
      x2: Math.min(a.x2, b.x2),
      y2: Math.min(a.y2, b.y2),
    };
  }
  function w(r) {
    return Math.max(0, r.x2 - r.x1);
  }
  function h(r) {
    return Math.max(0, r.y2 - r.y1);
  }
  var clipCache = new Map();
  /** Visible box of an element's ancestors' clipping (overflow != visible) and the viewport. */
  function ancestorClip(el) {
    if (!el || el === document.documentElement) {
      return { x1: 0, y1: 0, x2: window.innerWidth, y2: window.innerHeight };
    }
    if (clipCache.has(el)) return clipCache.get(el);
    var cs = getComputedStyle(el);
    var parentClip = cs.position === 'fixed' ? null : ancestorClip(el.parentElement);
    var clip = parentClip || { x1: 0, y1: 0, x2: window.innerWidth, y2: window.innerHeight };
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.contain.indexOf('paint') >= 0) {
      clip = intersect(clip, rectOf(el));
    }
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
      clip = { x1: 0, y1: 0, x2: 0, y2: 0 };
    }
    clipCache.set(el, clip);
    return clip;
  }
  function visibleBox(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;
    var r = intersect(rectOf(el), ancestorClip(el.parentElement));
    return w(r) >= 2 && h(r) >= 2 ? r : null;
  }
  function freshGeometry() {
    clipCache = new Map();
  }

  // ----------------------------------------------------------------------------- roots

  function resolveRoot(spec) {
    if (!spec || spec === 'document') return document.body;
    if (spec === 'active-panel') {
      return (
        document.querySelector('.dv-groupview.dv-active-group') ||
        document.querySelector('.dv-groupview')
      );
    }
    if (spec === 'top-layer') {
      var layers = openLayers();
      return layers.length ? layers[layers.length - 1].el : null;
    }
    return document.querySelector(spec);
  }

  var LAYER_SEL = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
  function openLayers() {
    var out = [];
    var els = document.querySelectorAll(LAYER_SEL);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!visibleBox(el)) continue;
      // A listbox rendered inline (not a popup) is part of the window, not a layer.
      var role = el.getAttribute('role');
      if (role === 'listbox' && !el.closest('[data-radix-popper-content-wrapper], .ht-combo-list, .palette'))
        continue;
      if (el.closest('.palette') && role !== 'dialog') continue;
      out.push({ el: el, role: role, label: labelOf(el, true) });
    }
    return out;
  }

  // ----------------------------------------------------------------------------- controls

  var CONTROL_SEL = [
    'button',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="option"]',
    '[role="treeitem"]',
    'a[href]',
    'select',
    'input[type="checkbox"]',
    'input[type="radio"]',
    'summary',
  ].join(',');
  // Roles that are distinct actions even when they share a class (never capped).
  var UNCAPPED = { tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, switch: 1, checkbox: 1, radio: 1, select: 1 };
  var REPEAT_CAP = 4;

  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r) return r;
    var t = el.tagName.toLowerCase();
    if (t === 'input') return el.type;
    if (t === 'a') return 'link';
    if (t === 'summary') return 'button';
    return t;
  }
  function labelOf(el, short) {
    var s =
      el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby') &&
        (document.getElementById(el.getAttribute('aria-labelledby').split(' ')[0]) || {}).textContent) ||
      (el.tagName === 'SELECT' && el.closest('label') && el.closest('label').textContent) ||
      (el.textContent || '').trim() ||
      el.getAttribute('title') ||
      el.getAttribute('data-testid') ||
      el.getAttribute('placeholder') ||
      '';
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.slice(0, short ? 60 : 90);
  }
  function normLabel(s) {
    return s.replace(/[0-9]+([.,][0-9]+)*/g, '#');
  }
  function disabled(el) {
    return (
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.getAttribute('data-disabled') !== null ||
      !!el.closest('fieldset[disabled]') ||
      !!el.closest('[data-clickall-skip]')
    );
  }
  function keyOf(el, role, label, counts) {
    var tid = el.getAttribute('data-testid');
    var base = role + '|' + (tid ? '#' + tid : normLabel(label));
    var n = counts[base] || 0;
    counts[base] = n + 1;
    return base + '|' + n;
  }
  function controlsIn(root) {
    if (!root) return [];
    freshGeometry();
    var counts = {};
    var classCounts = {};
    var out = [];
    var els = root.querySelectorAll(CONTROL_SEL);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var role = roleOf(el);
      // Nested interactive: a button inside a menuitem / tab is the same control.
      if (el.parentElement && el.parentElement.closest(CONTROL_SEL) && el.parentElement.closest(CONTROL_SEL) !== el && root.contains(el.parentElement.closest(CONTROL_SEL)))
        continue;
      var box = visibleBox(el);
      if (!box) continue;
      var label = labelOf(el);
      var key = keyOf(el, role, label, counts);
      var tid = el.getAttribute('data-testid');
      if (!UNCAPPED[role] && !tid && !el.getAttribute('aria-label')) {
        var cls = role + '.' + (typeof el.className === 'string' ? el.className : '');
        classCounts[cls] = (classCounts[cls] || 0) + 1;
        if (classCounts[cls] > REPEAT_CAP) continue;
      }
      out.push({
        key: key,
        role: role,
        label: label,
        testid: tid || undefined,
        disabled: disabled(el),
        href: el.tagName === 'A' ? el.getAttribute('href') : undefined,
        target: el.getAttribute('target') || undefined,
        tag: el.tagName.toLowerCase(),
        options: el.tagName === 'SELECT' ? el.options.length : undefined,
        selectedIndex: el.tagName === 'SELECT' ? el.selectedIndex : undefined,
      });
    }
    return out;
  }
  function findByKey(root, key) {
    if (!root) return null;
    var counts = {};
    var els = root.querySelectorAll(CONTROL_SEL);
    freshGeometry();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var role = roleOf(el);
      if (el.parentElement && el.parentElement.closest(CONTROL_SEL) && el.parentElement.closest(CONTROL_SEL) !== el && root.contains(el.parentElement.closest(CONTROL_SEL)))
        continue;
      if (!visibleBox(el)) continue;
      if (keyOf(el, role, labelOf(el), counts) === key) return el;
    }
    return null;
  }
  function mark(rootSpec, key) {
    var old = document.querySelectorAll('[data-clickall-target]');
    for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-clickall-target');
    var el = findByKey(resolveRoot(rootSpec), key);
    if (!el) return false;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
    el.setAttribute('data-clickall-target', '1');
    return true;
  }
  /** Picks a different option of the marked <select> and fires change (React listens to it). */
  function cycleSelect() {
    var el = document.querySelector('[data-clickall-target]');
    if (!el || el.tagName !== 'SELECT' || el.options.length < 2) return null;
    var next = el.selectedIndex === 0 ? 1 : 0;
    var setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, el.options[next].value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.options[next].textContent;
  }

  // ----------------------------------------------------------------------------- state

  var VOLATILE = /^(up|down|flash.*|tick.*|pos|neg|blink.*|pulse.*|is-.*hover.*|.*focus.*|dv-active.*|dv-inactive.*|.*-hover|live|delayed|stale)$/;
  function hash(str) {
    var x = 2166136261;
    for (var i = 0; i < str.length; i++) {
      x ^= str.charCodeAt(i);
      x = Math.imul(x, 16777619);
    }
    return (x >>> 0).toString(36);
  }
  function snapshot() {
    var all = document.body.getElementsByTagName('*');
    var parts = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var tag = el.tagName;
      if (tag === 'svg' || tag === 'path' || tag === 'g' || tag === 'line' || tag === 'rect') continue;
      var cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(function (c) { return c && !VOLATILE.test(c); }).join('.') : '';
      var st =
        (el.getAttribute('aria-selected') || '') +
        (el.getAttribute('aria-pressed') || '') +
        (el.getAttribute('aria-checked') || '') +
        (el.getAttribute('aria-expanded') || '') +
        (el.getAttribute('data-state') || '');
      var v = tag === 'INPUT' ? (el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value) : tag === 'SELECT' ? el.value : '';
      parts.push(tag + '.' + cls + st + v);
    }
    var intro = window.__HTFLOW_INTROSPECT__;
    var toasts = document.querySelectorAll('.ht-toast');
    var lastToast = toasts.length ? toasts[toasts.length - 1].textContent.trim().slice(0, 120) : '';
    return {
      sig: hash(parts.join('|')),
      elements: parts.length,
      layers: openLayers().map(function (l) {
        return l.role + ':' + l.label;
      }),
      toasts: toasts.length,
      lastToast: lastToast,
      windows: intro ? intro.windowCount() : 0,
      url: location.href,
      nativeDialogs: nativeDialogs.length,
    };
  }

  // ----------------------------------------------------------------------------- layout checks

  var SKIP_TEXT = '[role="tooltip"], .ht-toasts, [aria-hidden="true"], .sr-only, .visually-hidden, script, style, noscript, canvas';
  function textBoxes(root) {
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var range = document.createRange();
    var n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      var el = n.parentElement;
      if (!el || el.closest(SKIP_TEXT)) continue;
      var clip = visibleBox(el);
      if (!clip) continue;
      range.selectNodeContents(n);
      var rs = range.getClientRects();
      for (var i = 0; i < rs.length; i++) {
        var r = intersect({ x1: rs[i].left, y1: rs[i].top, x2: rs[i].right, y2: rs[i].bottom }, clip);
        if (w(r) >= 3 && h(r) >= 3) out.push({ el: el, r: r, text: n.nodeValue.trim().slice(0, 40) });
      }
      if (out.length > 2500) break;
    }
    return out;
  }
  function describe(el) {
    var s = el.tagName.toLowerCase();
    var tid = el.getAttribute('data-testid');
    if (tid) return s + '[data-testid=' + tid + ']';
    if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
    return s;
  }
  function overlaps(root) {
    var boxes = textBoxes(root);
    boxes.sort(function (a, b) {
      return a.r.x1 - b.r.x1;
    });
    var found = [];
    for (var i = 0; i < boxes.length && found.length < 20; i++) {
      var a = boxes[i];
      for (var j = i + 1; j < boxes.length; j++) {
        var b = boxes[j];
        if (b.r.x1 >= a.r.x2) break;
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        var o = intersect(a.r, b.r);
        var area = w(o) * h(o);
        var minArea = Math.min(w(a.r) * h(a.r), w(b.r) * h(b.r));
        if (w(o) > 2 && h(o) > 3 && area > 0.25 * minArea) {
          found.push({ a: describe(a.el) + ' "' + a.text + '"', b: describe(b.el) + ' "' + b.text + '"' });
          if (found.length >= 20) break;
        }
      }
    }
    return found;
  }
  function overflows(root) {
    var rb = rectOf(root);
    var found = [];
    // A root that scrolls horizontally (the ribbon) holds wider content by design.
    if (getComputedStyle(root).overflowX === 'auto' || getComputedStyle(root).overflowX === 'scroll') return found;
    var reported = [];
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length && found.length < 20; i++) {
      var el = all[i];
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.right <= rb.x2 + 1 && r.left >= rb.x1 - 1) continue;
      var cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') continue;
      // Contained by a clipping / scrolling ancestor inside the root: that is a scroll area, fine.
      var contained = false;
      for (var a = el.parentElement; a && a !== root; a = a.parentElement) {
        var acs = getComputedStyle(a);
        if (acs.overflowX !== 'visible') {
          contained = true;
          break;
        }
      }
      if (contained) continue;
      var dup = false;
      for (var k = 0; k < reported.length; k++) if (reported[k].contains(el)) dup = true;
      if (dup) continue;
      reported.push(el);
      found.push(describe(el) + ' (' + Math.round(r.left - rb.x1) + '..' + Math.round(r.right - rb.x1) + ' of ' + Math.round(rb.x2 - rb.x1) + 'px)');
    }
    return found;
  }

  window.__CLICKALL__ = {
    version: 1,
    takeErrors: function () {
      return errors.splice(0, errors.length);
    },
    takeNativeDialogs: function () {
      return nativeDialogs.splice(0, nativeDialogs.length);
    },
    beat: function () {
      var el = document.querySelector('[data-testid="app-heartbeat"]');
      return el ? Number(el.getAttribute('data-beat')) : -1;
    },
    exists: function (rootSpec) {
      return !!resolveRoot(rootSpec);
    },
    controls: function (rootSpec) {
      return controlsIn(resolveRoot(rootSpec));
    },
    mark: mark,
    cycleSelect: cycleSelect,
    snapshot: snapshot,
    layers: function () {
      return openLayers().map(function (l) {
        return { role: l.role, label: l.label };
      });
    },
    layout: function (rootSpec) {
      var root = resolveRoot(rootSpec);
      if (!root) return { overflow: [], overlap: [] };
      freshGeometry();
      return { overflow: overflows(root), overlap: overlaps(root) };
    },
    /** Marks the root element so the driver can screenshot it. */
    markRoot: function (rootSpec) {
      var old = document.querySelectorAll('[data-clickall-root]');
      for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-clickall-root');
      var root = resolveRoot(rootSpec);
      if (root) root.setAttribute('data-clickall-root', '1');
      return !!root;
    },
    /** Marks a point inside the root (centre-ish) for right-clicks; returns client coordinates. */
    point: function (rootSpec, fx, fy) {
      var root = resolveRoot(rootSpec);
      if (!root) return null;
      var r = root.getBoundingClientRect();
      return { x: r.left + r.width * fx, y: r.top + r.height * fy };
    },
  };
})();
