/* Tiny inline icon set (stroke icons). Usage: <i data-icon="bolt"></i> or Icons.svg('bolt'). */
window.Icons = (function () {
  const P = {
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    leaf: '<path d="M20 4C9 4 4 9 4 16c0 2 .5 3 .5 3S8 20 12 18c5-3 8-8 8-14z"/><path d="M4 20c2-6 6-9 10-11"/>',
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    factory: '<path d="M3 21V9l6 4V9l6 4V5h3v16z"/><path d="M7 17h2M12 17h2"/>',
    meter: '<circle cx="12" cy="12" r="9"/><path d="M12 12l4-4"/><path d="M7 16h10"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    ev: '<path d="M5 16l1.5-5h11L19 16"/><circle cx="8" cy="17" r="1.5"/><circle cx="16" cy="17" r="1.5"/><path d="M12 3l-2 4h4l-2 4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    book: '<path d="M4 5a2 2 0 012-2h5v17H6a2 2 0 00-2 2z"/><path d="M20 5a2 2 0 00-2-2h-5v17h5a2 2 0 012 2z"/>',
    flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3"/><path d="M8 15h8"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14c3 0 5 2 5 5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    cap: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
    award: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    wallet: '<path d="M3 7a2 2 0 012-2h13v4"/><path d="M3 7v11a2 2 0 002 2h15V9H5a2 2 0 01-2-2z"/><circle cx="16.5" cy="14.5" r="1.2"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    lightbulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M3 13h18"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
  };
  const svg = (n, cls) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${P[n] || ''}</svg>`;
  const apply = (root = document) => root.querySelectorAll('[data-icon]').forEach((e) => { if (!e.firstChild) e.innerHTML = svg(e.dataset.icon); });
  document.addEventListener('DOMContentLoaded', () => apply());
  return { svg, apply };
})();

/* Deterministic pseudo-random series so each signed-in customer/student sees stable demo numbers. */
window.Seeded = function (seed) {
  let h = 2166136261; for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
};

/* SVG chart helpers */
window.Charts = {
  bars(values, labels, { w = 560, h = 240, color = 'var(--primary)', unit = '' } = {}) {
    const pad = { l: 34, r: 10, t: 14, b: 26 }, max = Math.max(...values) * 1.15, bw = (w - pad.l - pad.r) / values.length;
    const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${w} ${h}" role="img" class="axis">`;
    for (let i = 0; i <= 4; i++) { const v = (max * i) / 4; s += `<line class="gridline" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`; }
    values.forEach((v, i) => { const x = pad.l + i * bw + bw * 0.18; s += `<rect x="${x}" y="${y(v)}" width="${bw * 0.64}" height="${h - pad.b - y(v)}" rx="5" fill="${color}" opacity="${0.45 + 0.55 * (v / Math.max(...values))}"><title>${labels[i]}: ${v}${unit}</title></rect><text x="${x + bw * 0.32}" y="${h - 8}" text-anchor="middle">${labels[i]}</text>`; });
    return s + '</svg>';
  },
  line(values, labels, { w = 560, h = 220, color = 'var(--primary)' } = {}) {
    const pad = { l: 34, r: 12, t: 14, b: 26 }, max = Math.max(...values) * 1.1, min = Math.min(...values) * 0.9;
    const x = (i) => pad.l + (i * (w - pad.l - pad.r)) / (values.length - 1), y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - min) / (max - min));
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
    let s = `<svg viewBox="0 0 ${w} ${h}" class="axis" role="img"><defs><linearGradient id="lg${labels.length}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`;
    for (let i = 0; i <= 4; i++) { const v = min + ((max - min) * i) / 4; s += `<line class="gridline" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`; }
    s += `<path d="${d} L${x(values.length - 1)},${h - pad.b} L${x(0)},${h - pad.b}Z" fill="url(#lg${labels.length})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    values.forEach((v, i) => { s += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="var(--surface)" stroke="${color}" stroke-width="2.5"/><text x="${x(i)}" y="${h - 8}" text-anchor="middle">${labels[i]}</text>`; });
    return s + '</svg>';
  },
  donut(parts, { size = 180, thickness = 26 } = {}) {
    const r = (size - thickness) / 2, c = size / 2, circ = 2 * Math.PI * r, total = parts.reduce((a, p) => a + p.v, 0);
    let off = 0, s = `<svg viewBox="0 0 ${size} ${size}" role="img"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${thickness}"/>`;
    for (const p of parts) { const len = (p.v / total) * circ; s += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${p.color}" stroke-width="${thickness}" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${c} ${c})"><title>${p.label}: ${p.v}%</title></circle>`; off += len; }
    return s + '</svg>';
  },
  ring(pct, label, { size = 150, thickness = 14, color = 'var(--primary)' } = {}) {
    const r = (size - thickness) / 2, c = size / 2, circ = 2 * Math.PI * r;
    return `<svg viewBox="0 0 ${size} ${size}" role="img"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${thickness}"/><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}" stroke-linecap="round" stroke-dasharray="${(pct / 100) * circ} ${circ}" transform="rotate(-90 ${c} ${c})"/><text x="${c}" y="${c + 2}" text-anchor="middle" font-size="${size / 4.2}" font-weight="800" fill="var(--text)">${label}</text></svg>`;
  },
};
