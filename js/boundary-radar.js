/* Interactive boundary radar: one spoke per ray, one outline per model.
   Zoom into a sector (wheel / pinch / buttons / + -), drag or arrow keys to
   turn, double-click or 0 to reset. Hover a spoke for its boundaries and the
   last face the deployed model accepts on it. No dependencies.

   Mount: <div class="bradar" data-src="data/sg3_radar_1024.json"></div>     */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var JUDGES = [
    { key: "float-arcface", label: "Desktop ArcFace R100 (reference)", slot: 1, dash: "" },
    { key: "float-mfn", label: "Float MobileFaceNet", slot: 3, dash: "" },
    { key: "espdl-sil", label: "ESP-DL INT8, host", slot: 2, dash: "" },
    { key: "espdl-hil", label: "ESP-DL INT8, device", slot: 2, dash: "4 3" }
  ];
  var ORDERS = [
    { key: "heading", label: "Similar directions together" },
    { key: "boundary", label: "Sorted by boundary" },
    { key: "index", label: "Ray number" }
  ];
  var R_MIN = 20, R_MAX = 90;          // degrees shown, centre to rim
  var FAN = 300;                       // degrees of display a zoomed sector opens into
  var MARK_SPAN = 120;                 // show per-ray markers below this many spokes in view
  var SMOOTH = 25;                     // spokes in the full view's running median

  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function mount(root) {
    fetch(root.dataset.src).then(function (r) { return r.json(); }).then(function (D) { build(root, D); })
      .catch(function () { root.textContent = "The radar data did not load."; });
  }

  function build(root, D) {
    var N = D.rays.length;
    var idx = {}; D.rays.forEach(function (d, i) { idx[d] = i; });
    var state = { tau: "0.5", order: "heading", center: 0, span: N, hidden: {}, hover: null, pinned: null };

    /* ---- controls (one row, above the chart) ---- */
    var bar = h("div", "br-bar", root);
    var tauG = h("div", "br-group", bar); h("span", "br-lab", tauG, "Threshold τ");
    D.taus.forEach(function (t) {
      var b = h("button", "br-btn", tauG, t); b.type = "button"; b.dataset.tau = t;
      b.addEventListener("click", function () { state.tau = t; draw(); });
    });
    var ordG = h("div", "br-group", bar); h("span", "br-lab", ordG, "Spoke order");
    var sel = h("select", "br-sel", ordG);
    ORDERS.forEach(function (o) { var op = h("option", null, sel, o.label); op.value = o.key; });
    sel.addEventListener("change", function () { state.order = sel.value; state.center = 0; draw(); });
    var zG = h("div", "br-group", bar);
    [["−", function () { zoom(1.6); }, "Zoom out"], ["+", function () { zoom(1 / 1.6); }, "Zoom in"],
     ["Reset", reset, "Show every ray"]].forEach(function (x) {
      var b = h("button", "br-btn", zG, x[0]); b.type = "button"; b.title = x[2]; b.setAttribute("aria-label", x[2]);
      b.addEventListener("click", x[1]);
    });

    var wrap = h("div", "br-wrap", root);
    var svg = el("svg", { viewBox: "-520 -520 1040 1040", role: "img", tabindex: "0",
      "aria-label": "Boundary radar: one spoke per ray, one outline per model. Scroll or use + and − to zoom, drag or arrow keys to turn." }, wrap);
    var gGrid = el("g", {}, svg), gLines = el("g", {}, svg), gMarks = el("g", {}, svg),
        gHover = el("g", {}, svg), gMini = el("g", { transform: "translate(410,-410)" }, svg);
    var tip = h("div", "br-tip", wrap); tip.hidden = true;

    /* legend: always present, click to hide a model */
    var leg = h("div", "br-legend", root);
    JUDGES.forEach(function (j) {
      if (!D.judges[j.key]) return;
      var b = h("button", "br-key", leg); b.type = "button"; b.dataset.judge = j.key;
      var sw = document.createElementNS(NS, "svg"); sw.setAttribute("width", "26"); sw.setAttribute("height", "10");
      el("line", { x1: 1, y1: 5, x2: 25, y2: 5, class: "br-s" + j.slot, "stroke-width": 2.5,
        "stroke-dasharray": j.dash }, sw);
      b.appendChild(sw); h("span", null, b, j.label);
      b.addEventListener("click", function () { state.hidden[j.key] = !state.hidden[j.key]; draw(); });
    });
    var refs = h("div", "br-refs", root);
    refs.innerHTML = '<span><i class="br-band"></i>her photographs (' + D.references.photos_deg.map(Math.round).join("–") +
      '°)</span><span><i class="br-imp"></i>nearest of 2,115 synthetic strangers (' + Math.round(D.references.nearest_impostor_deg) +
      '°)</span><span>▵ still accepted at its last rendered point · ▿ already rejected at its first</span>' +
      '<span>all rays: faint = each ray, bold = median of ' + SMOOTH + ' neighbouring spokes · zoomed: every ray, a dot each</span>';

    var tableBox = h("details", "br-table", root);
    h("summary", null, tableBox, "Table: the rays in view");
    var tableHost = h("div", null, tableBox);
    tableBox.addEventListener("toggle", function () { if (tableBox.open) table(); });

    /* ---- geometry ---- */
    function order() { return D.orders[state.order]; }
    function rad(v) { return 60 + (Math.max(R_MIN, Math.min(R_MAX, v)) - R_MIN) / (R_MAX - R_MIN) * 420; }
    function view() {  // positions in the current order that are in view, with their display angle (deg, 0 = up)
      var out = [], half = state.span / 2, full = state.span >= N;
      for (var p = 0; p < N; p++) {
        var off = ((p - state.center) % N + N + N / 2) % N - N / 2;     // -N/2..N/2
        if (!full && Math.abs(off) > half) continue;
        var a = full ? (p / N) * 360 : (off / state.span) * FAN;
        out.push({ p: p, a: a, off: off });
      }
      out.sort(function (x, y) { return x.off - y.off; });
      return out;
    }
    function xy(a, r) { var t = (a - 90) * Math.PI / 180; return [r * Math.cos(t), r * Math.sin(t)]; }

    function zoom(f, at) {  // at: the spoke under the pointer ({p, off}), kept under it
      var ns = Math.max(8, Math.min(N, state.span * f));
      if (at && ns < N) {
        if (state.span >= N) state.center = at.p;   // leaving the full circle: open the fan on that spoke
        else state.center = (state.center + at.off * (1 - ns / state.span) + N) % N;
      }
      state.span = ns; draw();
    }
    function reset() { state.span = N; state.center = 0; state.pinned = null; draw(); }

    function draw() {
      [].forEach.call(tauG.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", b.dataset.tau === state.tau); });
      [].forEach.call(leg.querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", !state.hidden[b.dataset.judge]); });
      var V = view(), full = state.span >= N, ord = order();
      gGrid.innerHTML = ""; gLines.innerHTML = ""; gMarks.innerHTML = ""; gMini.innerHTML = "";
      /* rings and references */
      var arc = function (r, cls, g) {
        if (full) return el("circle", { r: r, class: cls }, g);
        var a0 = xy(-FAN / 2, r), a1 = xy(FAN / 2, r);
        return el("path", { d: "M" + a0 + "A" + r + "," + r + " 0 1 1 " + a1, class: cls }, g);
      };
      var band = D.references.photos_deg;
      arc((rad(band[0]) + rad(band[1])) / 2, "br-band-ring", gGrid).setAttribute("stroke-width", rad(band[1]) - rad(band[0]));
      [30, 45, 60, 75, 90].forEach(function (d) {
        arc(rad(d), "br-ring", gGrid);
        var p = xy(full ? 0 : FAN / 2 + 8, rad(d));
        var t = el("text", { x: p[0] + 4, y: p[1] - 4, class: "br-tick" }, gGrid); t.textContent = d + "°";
      });
      arc(rad(D.references.nearest_impostor_deg), "br-imp-ring", gGrid);
      if (!full) {
        [-FAN / 2, FAN / 2].forEach(function (a) {
          var p0 = xy(a, 60), p1 = xy(a, 480);
          el("line", { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], class: "br-cut" }, gGrid);
        });
      }
      /* outlines */
      var showMarks = V.length <= MARK_SPAN;
      JUDGES.forEach(function (j) {
        var jd = D.judges[j.key]; if (!jd || state.hidden[j.key]) return;
        var t = jd[state.tau], pts = [], seg = [];
        V.forEach(function (q) {
          // the outline joins boundaries only: a ray still accepted at its last point (a lower
          // bound) or rejected at its first (an upper bound) breaks it and is marked instead
          var i = idx[ord[q.p]], v = t.v[i], f = t.f[i];
          if (v == null || f === "c" || f === "r") { if (seg.length) pts.push(seg); seg = []; return; }
          seg.push(xy(q.a, rad(v)));
        });
        if (seg.length) pts.push(seg);
        if (full && pts.length === 1) pts[0].push(pts[0][0]);
        pts.forEach(function (s) {
          el("polyline", { points: s.join(" "), class: "br-line br-s" + j.slot, "stroke-dasharray": j.dash,
            "stroke-width": full ? 0.8 : 1.8, opacity: full ? 0.35 : 1 }, gLines);
        });
        if (full) {  // the running median over SMOOTH neighbouring spokes (boundaries only), closed
          var vals = V.map(function (q) { var i = idx[ord[q.p]], f = t.f[i]; return (f === "b" || f === "m") ? t.v[i] : null; });
          var sm = [], half = (SMOOTH - 1) / 2;
          for (var k = 0; k < vals.length; k++) {
            var w = [];
            for (var d = -half; d <= half; d++) { var x = vals[(k + d + vals.length) % vals.length]; if (x != null) w.push(x); }
            if (w.length < half) continue;
            w.sort(function (a, b) { return a - b; });
            sm.push(xy(V[k].a, rad(w[(w.length - 1) >> 1])));
          }
          if (sm.length) sm.push(sm[0]);
          el("polyline", { points: sm.join(" "), class: "br-line br-s" + j.slot, "stroke-dasharray": j.dash,
            "stroke-width": 3 }, gLines);
        }
        V.forEach(function (q) {
          var i = idx[ord[q.p]], v = t.v[i], f = t.f[i];
          if (v == null) return;
          if (!showMarks && f !== "c" && f !== "r") return;
          var c = xy(q.a, rad(v)), hollow = j.key === "espdl-hil";
          if (f === "c" || f === "r") {
            var s = showMarks ? 7 : 4, up = f === "c" ? -1 : 1;
            var g = el("g", { transform: "translate(" + c + ") rotate(" + q.a + ")" }, gMarks);
            el("path", { d: "M0," + (up * s) + "L" + s + "," + (-up * s * 0.6) + "L" + (-s) + "," + (-up * s * 0.6) + "Z",
              class: "br-tri br-f" + j.slot }, g);
          } else {
            el("circle", { cx: c[0], cy: c[1], r: 5, class: (hollow ? "br-hollow br-k" : "br-dot br-f") + j.slot }, gMarks);
          }
        });
      });
      /* minimap */
      el("circle", { r: 70, class: "br-mini" }, gMini);
      if (!full) {
        var a0 = ((state.center - state.span / 2) / N) * 360, a1 = ((state.center + state.span / 2) / N) * 360;
        var p0 = xy(a0, 70), p1 = xy(a1, 70);
        el("path", { d: "M0,0L" + p0 + "A70,70 0 " + (a1 - a0 > 180 ? 1 : 0) + " 1 " + p1 + "Z", class: "br-mini-sec" }, gMini);
      }
      var lab = el("text", { y: 92, class: "br-tick", "text-anchor": "middle" }, gMini);
      lab.textContent = full ? "all " + N + " rays" : Math.round(state.span) + " of " + N + " rays";
      hover(state.pinned != null ? state.pinned : state.hover);
      if (tableBox.open) table();
    }

    /* ---- hover / tooltip ---- */
    function nearest(evt) {
      var pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
      var q = pt.matrixTransform(svg.getScreenCTM().inverse());
      var a = (Math.atan2(q.y, q.x) * 180 / Math.PI + 90 + 360) % 360, r = Math.hypot(q.x, q.y);
      if (r < 40 || r > 500) return null;
      var V = view(), best = null, bd = 1e9;
      V.forEach(function (v) { var d = Math.abs(((v.a - a) % 360 + 540) % 360 - 180); if (d < bd) { bd = d; best = v; } });
      return best ? { p: best.p, off: best.off } : null;
    }
    function fmt(jd, i) {
      var v = jd[state.tau].v[i], f = jd[state.tau].f[i];
      if (v == null) return "—";
      return (f === "c" ? "beyond " : f === "r" ? "inside " : "") + v.toFixed(1) + "°" + (f === "m" ? " (first of two)" : "");
    }
    function hover(hv) {
      gHover.innerHTML = "";
      if (!hv) { tip.hidden = true; return; }
      var V = view(), q = V.find(function (v) { return v.p === hv.p; });
      if (!q) { tip.hidden = true; return; }
      var p0 = xy(q.a, 60), p1 = xy(q.a, 480);
      el("line", { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], class: "br-hand" }, gHover);
      var ray = order()[hv.p], i = idx[ray];
      var rows = JUDGES.filter(function (j) { return D.judges[j.key]; }).map(function (j) {
        return '<tr><td><svg width="18" height="8"><line x1="1" y1="4" x2="17" y2="4" class="br-s' + j.slot +
          '" stroke-width="2.5" stroke-dasharray="' + j.dash + '"/></svg> ' + j.label + "</td><td>" + fmt(D.judges[j.key], i) + "</td></tr>";
      }).join("");
      var face = D.faces.by_ray[ray];
      tip.innerHTML = '<div class="br-tip-h">Ray D' + String(ray).padStart(4, "0") + " · τ " + state.tau + "</div>" +
        (face ? '<div class="br-face"><img alt="" width="96" height="96" src="' + D.faces.dir + "D" + String(ray).padStart(4, "0") +
          '.jpg"><span>last face the host INT8 model accepts at τ 0.5: ' + face[0] + "°, score " + face[1].toFixed(2) + "</span></div>" : "") +
        "<table>" + rows + "</table>" + (state.pinned != null ? '<div class="br-note">pinned — click the chart to release</div>' : "");
      tip.hidden = false;
      var box = svg.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
      var c = xy(q.a, 300), sx = box.width / 1040;
      var x = (c[0] + 520) * sx + box.left - wb.left, y = (c[1] + 520) * sx + box.top - wb.top;
      tip.style.left = Math.min(Math.max(8, x + (c[0] > 0 ? -tip.offsetWidth - 16 : 16)), wb.width - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.min(Math.max(8, y - tip.offsetHeight / 2), wb.height - tip.offsetHeight - 8) + "px";
    }

    /* ---- input ---- */
    var drag = null;
    function centreAngle(e) {
      var b = svg.getBoundingClientRect();
      return Math.atan2(e.clientY - (b.top + b.height / 2), e.clientX - (b.left + b.width / 2));
    }
    svg.addEventListener("pointermove", function (e) {
      if (drag && e.buttons) {
        var da = (centreAngle(e) - drag.a0) * 180 / Math.PI;
        if (da > 180) da -= 360; else if (da < -180) da += 360;
        var perDeg = state.span >= N ? N / 360 : state.span / FAN;
        state.center = (drag.c0 - da * perDeg + N * 10) % N; draw(); return;
      }
      state.hover = nearest(e); if (state.pinned == null) hover(state.hover);
    });
    svg.addEventListener("pointerleave", function () { state.hover = null; if (state.pinned == null) hover(null); });
    svg.addEventListener("pointerdown", function (e) {
      drag = { a0: centreAngle(e), c0: state.center, x: e.clientX, y: e.clientY };
    });
    window.addEventListener("pointerup", function (e) {
      if (!drag) return;
      var click = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4;
      drag = null;
      if (click && e.target.closest && e.target.closest("svg") === svg) {
        var n = nearest(e); state.pinned = state.pinned == null ? n : null; hover(state.pinned || n);
      }
    });
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var n = nearest(e);
      zoom(e.deltaY > 0 ? 1.25 : 0.8, n);
    }, { passive: false });
    svg.addEventListener("dblclick", reset);
    svg.addEventListener("keydown", function (e) {
      var step = Math.max(1, state.span / 12);
      if (e.key === "+" || e.key === "=") zoom(1 / 1.6);
      else if (e.key === "-") zoom(1.6);
      else if (e.key === "0") reset();
      else if (e.key === "ArrowRight") { state.center = (state.center + step) % N; draw(); }
      else if (e.key === "ArrowLeft") { state.center = (state.center - step + N) % N; draw(); }
      else return;
      e.preventDefault();
    });

    function table() {
      var V = view(), ord = order(), js = JUDGES.filter(function (j) { return D.judges[j.key]; });
      var html = "<table><thead><tr><th>Ray</th>" + js.map(function (j) { return "<th>" + j.label + "</th>"; }).join("") +
        "</tr></thead><tbody>";
      V.forEach(function (q) {
        var ray = ord[q.p], i = idx[ray];
        html += "<tr><td>D" + String(ray).padStart(4, "0") + "</td>" +
          js.map(function (j) { return "<td>" + fmt(D.judges[j.key], i) + "</td>"; }).join("") + "</tr>";
      });
      tableHost.innerHTML = html + "</tbody></table><p class=\"br-note\">τ " + state.tau + ", " + V.length +
        " rays in view, in spoke order. Angles are achieved angles to her centroid.</p>";
    }

    draw();
  }

  document.querySelectorAll(".bradar").forEach(mount);
})();
