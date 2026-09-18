/* ============================================================
   Start Right Up — site behaviour
   ------------------------------------------------------------
   Every module is self-contained and wrapped. One module throwing
   must never take another down: Phase 1 lost the planner, the survey
   and the reveals together because they shared a scope.

   No dependencies. This becomes WordPress theme JS at Phase 3.
   ============================================================ */

/* ------------------------------------------------------------
   Spring
   ------------------------------------------------------------
   Two parameters, not three. `response` is how quickly the value
   reaches the target in seconds; `damping` is 1.0 for a clean settle
   and below 1.0 to overshoot.

   The point of a spring here is not the curve. It is that a spring
   animates from wherever the value currently is, at whatever velocity
   it currently has — so a gesture can interrupt it, reverse it, and
   hand its own velocity straight in without a visible seam.
   ------------------------------------------------------------ */
function Spring(onFrame, opts) {
  opts = opts || {};
  var response = opts.response || 0.35,
      damping  = opts.damping  == null ? 1 : opts.damping,
      value = 0, velocity = 0, target = 0, raf = null, last = 0,
      done = opts.onRest || function () {};

  function step(now) {
    var dt = Math.min((now - last) / 1000, 1 / 30);   // clamp: a backgrounded tab must not explode
    last = now;
    var w = (2 * Math.PI) / response,
        z = damping,
        f = -(w * w) * (value - target) - 2 * z * w * velocity;
    velocity += f * dt;
    value    += velocity * dt;

    if (Math.abs(value - target) < 0.05 && Math.abs(velocity) < 0.05) {
      value = target; velocity = 0; onFrame(value); raf = null; done(); return;
    }
    onFrame(value);
    raf = requestAnimationFrame(step);
  }

  return {
    get value() { return value; },
    get velocity() { return velocity; },
    // Setting a target never resets the value or the velocity — that is what
    // lets an in-flight animation be redirected instead of restarted.
    to: function (t, v) {
      target = t;
      if (v != null) velocity = v;
      if (raf == null) { last = performance.now(); raf = requestAnimationFrame(step); }
    },
    set: function (x) {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      value = target = x; velocity = 0; onFrame(value);
    },
    stop: function () { if (raf) { cancelAnimationFrame(raf); raf = null; } velocity = 0; },
    get running() { return raf != null; }
  };
}

/* Where a flick is heading, not where the finger left off.
   Exponential decay, the same shape as scroll deceleration. */
function project(velocity, decel) {
  decel = decel || 0.998;
  return (velocity / 1000) * decel / (1 - decel);
}

/* Progressive resistance past an edge. A hard stop reads as frozen. */
function rubberband(overshoot, dimension, c) {
  c = c || 0.55;
  return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
}

var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches;

/* ------------------------------------------------------------
   Mobile drawer — grabbable, interruptible, velocity-aware
   ------------------------------------------------------------ */
(function () {
  try {
    var toggle = document.getElementById('navToggle'),
        drawer = document.getElementById('drawer'),
        scrim  = document.getElementById('scrim'),
        closeB = document.getElementById('drawerClose');
    if (!toggle || !drawer || !scrim) return;

    var W = 340, open = false, dragging = false, startX = 0, grabAt = 0, hist = [];

    function width() { return drawer.getBoundingClientRect().width || W; }

    function paint(x) {
      drawer.style.transform = 'translateX(' + x + 'px)';
      // The scrim tracks the panel, so the dimming is continuous during the
      // drag rather than appearing only once the gesture completes.
      var p = 1 - Math.min(1, Math.max(0, x / width()));
      scrim.style.opacity = String(p);
      // Retire it as soon as it is effectively gone, rather than waiting for the
      // spring's tail. A panel nobody can see must not still be in the tab order.
      if (!open && !dragging && x > width() - 2) finishClose();
    }

    var spring = Spring(paint, {
      response: 0.3, damping: 0.85,      // a sheet, per Apple's own drawer values
      onRest: function () { if (!open) finishClose(); }
    });
    spring.set(width());

    function lockScroll(on) {
      document.body.style.overflow = on ? 'hidden' : '';
    }

    function openDrawer() {
      open = true; closed = false;
      drawer.style.visibility = 'visible';
      scrim.hidden = false;
      scrim.dataset.open = 'true';
      drawer.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      lockScroll(true);
      if (REDUCED) { spring.set(0); } else { spring.to(0); }
      var f = drawer.querySelector('a,button');
      if (f) f.focus();
    }

    function closeDrawer(velocity) {
      open = false;
      drawer.setAttribute('aria-hidden', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      if (REDUCED) { spring.set(width()); finishClose(); }
      else { spring.to(width(), velocity); }
    }

    var closed = true;
    function finishClose() {
      if (closed) return;
      closed = true;
      // visibility is what actually takes the panel out of the tab order —
      // a drawer translated off screen is still focusable.
      drawer.style.visibility = 'hidden';
      scrim.dataset.open = 'false';
      scrim.hidden = true;
      scrim.style.opacity = '';
      lockScroll(false);
      if (document.activeElement === document.body) toggle.focus();
    }

    toggle.addEventListener('click', function () { toggle.focus(); openDrawer(); });
    if (closeB) closeB.addEventListener('click', function () { toggle.focus(); closeDrawer(); });
    scrim.addEventListener('click', function () { toggle.focus(); closeDrawer(); });

    /* Swipe to dismiss. 1:1 with the finger, resistance in the wrong
       direction, and the landing decided by where the flick is going.

       A drag is not committed until the finger has moved ~10px sideways.
       Below that the pointer is never captured, so a tap on a link stays a
       tap on a link — capturing early is what swallows navigation. */
    var THRESHOLD = 10, pending = false;

    drawer.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;
      pending = true; dragging = false;
      startX = e.clientX;
      hist = [{ x: e.clientX, t: performance.now() }];
    });

    drawer.addEventListener('pointermove', function (e) {
      if (!pending && !dragging) return;
      var dx = e.clientX - startX;

      if (!dragging) {
        if (Math.abs(dx) < THRESHOLD) return;   // still might be a tap
        dragging = true;
        spring.stop();                          // grab it mid-flight, wherever it is
        grabAt = spring.value;
        startX = e.clientX;                     // re-anchor so there is no jump at commit
        try { drawer.setPointerCapture(e.pointerId); } catch (_) {}
        return;
      }

      var x = grabAt + (e.clientX - startX);
      if (x < 0) x = -rubberband(-x, width());  // pulling it further open resists
      paint(x);
      hist.push({ x: e.clientX, t: performance.now() });
      if (hist.length > 5) hist.shift();
    });

    function release(e) {
      pending = false;
      if (!dragging) return;
      dragging = false;
      try { drawer.releasePointerCapture(e.pointerId); } catch (_) {}

      // Velocity from the last few samples, not the final pair — one stray
      // event at release should not decide the gesture.
      var first = hist[0], last = hist[hist.length - 1],
          dt = Math.max(1, last.t - first.t),
          v  = (last.x - first.x) / dt * 1000;

      var current = spring.value,
          projected = current + project(v);

      // Sign of the velocity decides, not where the finger happened to stop.
      if (projected > width() / 2) closeDrawer(v);
      else { open = true; spring.to(0, v); }
    }
    drawer.addEventListener('pointerup', release);
    drawer.addEventListener('pointercancel', release);

    /* Focus trap. Without it, Tab walks straight out of an open drawer
       into the page behind, which is still there and still scrollable. */
    document.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape') { toggle.focus(); closeDrawer(); return; }
      if (e.key !== 'Tab') return;
      var f = drawer.querySelectorAll('a[href],button:not([disabled])');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    drawer.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        // A drag that happens to finish over a link is a drag, not a tap.
        if (hist.length > 1 && Math.abs(hist[hist.length - 1].x - hist[0].x) > THRESHOLD) {
          ev.preventDefault(); return;
        }
        closeDrawer();
      });
    });

    window.addEventListener('resize', function () { if (!open) spring.set(width()); });
  } catch (e) {}
})();

/* ------------------------------------------------------------
   Journey rail
   ------------------------------------------------------------
   Plane travels origin → Singapore with scroll. Vertical on the right
   at desktop, horizontal along the bottom on a phone. The first state
   is painted synchronously — the most important element must never
   flash empty on a slow connection.
   ------------------------------------------------------------ */
(function () {
  try {
    var track = document.getElementById('prailTrack'),
        trail = document.getElementById('prailTrail'),
        plane = document.getElementById('prailPlane'),
        dest  = document.getElementById('prailDest');
    if (!track || !trail || !plane) return;

    var len = 0, tp = 0, cp = 0, raf = null;

    function horiz() { return window.matchMedia('(max-width:820px)').matches; }
    function docH()  { return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight); }
    function measure(){ len = horiz() ? track.clientWidth : track.clientHeight; }

    function render(p) {
      var d = (p * (len - 14)).toFixed(1);
      if (horiz()) { plane.style.left = d + 'px'; plane.style.bottom = ''; trail.style.width = d + 'px'; trail.style.height = ''; }
      else         { plane.style.bottom = d + 'px'; plane.style.left = ''; trail.style.height = d + 'px'; trail.style.width = ''; }
      if (dest) dest.classList.toggle('arrived', p >= 0.985);
    }
    function target() {
      var vh = window.innerHeight;
      return Math.max(0, Math.min(1, window.pageYOffset / Math.max(1, docH() - vh)));
    }
    function tick() {
      cp += (tp - cp) * 0.14;
      if (Math.abs(tp - cp) < 0.0007) cp = tp;
      render(cp);
      raf = Math.abs(tp - cp) > 0.0007 ? requestAnimationFrame(tick) : null;
    }
    function reset() { measure(); tp = cp = target(); render(cp); }

    reset();
    window.addEventListener('load', reset);
    window.addEventListener('resize', function () { measure(); tp = target(); render(cp); });

    if (REDUCED) {
      window.addEventListener('scroll', function () { cp = target(); render(cp); }, { passive: true });
      return;
    }
    window.addEventListener('scroll', function () {
      tp = target();
      if (!raf) raf = requestAnimationFrame(tick);
    }, { passive: true });
  } catch (e) {}
})();

/* ------------------------------------------------------------
   Sticky bar — depth only once content is actually underneath it
   ------------------------------------------------------------ */
(function () {
  try {
    var nav = document.querySelector('.nav');
    if (!nav) return;
    var on = null;
    function check() {
      var next = window.pageYOffset > 8;
      if (next !== on) { on = next; nav.dataset.scrolled = String(on); }
    }
    check();   // writes the attribute on load, so the state is always readable
    window.addEventListener('scroll', check, { passive: true });
  } catch (e) {}
})();

/* ------------------------------------------------------------
   Wayfinding — mark the current page in the bar and the drawer
   ------------------------------------------------------------ */
(function () {
  try {
    var here = location.pathname.replace(/index\.html$/, '').replace(/\/$/, '') || '/';
    document.querySelectorAll('.nav__links a,.drawer a[href]').forEach(function (a) {
      var h = (a.getAttribute('href') || '').replace(/index\.html$/, '').replace(/\/$/, '');
      if (!h || h.charAt(0) === '#') return;
      if (h.split('/').pop() === here.split('/').pop()) a.setAttribute('aria-current', 'page');
    });
  } catch (e) {}
})();

/* ------------------------------------------------------------
   Comparison table — reachable by keyboard, and it says when
   there is more to the right
   ------------------------------------------------------------ */
(function () {
  try {
    document.querySelectorAll('.compare__scroll').forEach(function (el) {
      // A scrollable region that cannot be focused cannot be scrolled by keyboard.
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'region');
      var hint = el.parentElement && el.parentElement.querySelector('.compare__hint');
      if (hint && !el.getAttribute('aria-label')) el.setAttribute('aria-label', hint.textContent.trim());

      function edge() {
        el.dataset.more = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
      }
      edge();
      el.addEventListener('scroll', edge, { passive: true });
      window.addEventListener('resize', edge);
    });
  } catch (e) {}
})();

/* ------------------------------------------------------------
   Forms — validate inline, on leaving a field, never only on submit
   ------------------------------------------------------------ */
(function () {
  try {
    document.querySelectorAll('form').forEach(function (form) {
      var fields = form.querySelectorAll('input,select,textarea');

      function check(el, force) {
        var wrap = el.closest('.field');
        if (!wrap) return true;
        // Silent until the field has been used — nobody wants to be told a
        // form is wrong before they have filled it in.
        if (!force && !wrap.dataset.touched) return true;
        var ok = el.checkValidity();
        wrap.dataset.invalid = String(!ok);
        var err = wrap.querySelector('.field__err');
        if (!err) { err = document.createElement('span'); err.className = 'field__err'; wrap.appendChild(err); }
        err.textContent = ok ? '' : el.validationMessage;
        return ok;
      }

      fields.forEach(function (el) {
        el.addEventListener('blur', function () {
          var w = el.closest('.field'); if (w) w.dataset.touched = '1';
          check(el);
        });
        el.addEventListener('input', function () { check(el); });
      });

      form.addEventListener('submit', function (e) {
        var bad = null;
        fields.forEach(function (el) {
          var w = el.closest('.field'); if (w) w.dataset.touched = '1';
          if (!check(el, true) && !bad) bad = el;
        });
        if (bad) { e.preventDefault(); bad.focus(); }
      });
    });
  } catch (e) {}
})();
