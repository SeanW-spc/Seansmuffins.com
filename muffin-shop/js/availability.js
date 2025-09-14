// availability.js — driver-enforced availability UI + preflight
(() => {
  const { $, normDash } = window.SMUtils || {};

  const WINDOWS = ['6:00–7:00 AM','7:00–8:00 AM','8:00–9:00 AM'];
  const CART_KEY = 'sm_cart_v1';

  // ---- API base helper (SM REV) ----
  const API_BASE = (window.SMREV_API_BASE || '/api').replace(/\/+$/,'');
  function apiUrl(path, params) {
    const full = `${API_BASE}${path.startsWith('/') ? path : '/' + path}`;
    let u;
    try { u = new URL(full); } catch { u = new URL(full, window.location.origin); }
    if (params) for (const [k,v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  const ymd = d => {
    const x = d instanceof Date ? d : new Date(d);
    return isNaN(x) ? '' : x.toISOString().slice(0,10);
  };

  function normalizeWin(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    s = s.replace(/\s*-\s*/g,'–').replace(/\s*–\s*/g,'–'); // force EN–DASH visually
    s = s.replace(/\s*(am|pm)$/i, m => ' ' + m.toUpperCase());
    return s;
  }

  async function fetchAvailability(date) {
    if (!date) return null;
    try {
      const url = apiUrl('/slot-availability', { date, detailed: '1' });
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  function normalizeAvailability(data){
    const map = new Map();   // normalized-window -> available
    const rawByWin = {};     // original response object per window (includes drivers)
    if (!data) return { map, rawByWin };

    if (Array.isArray(data.windows)){
      for (const w of data.windows){
        const label = w.window || w.label || w.name;
        const avail = Number(w.available ?? (Number(w.capacity||0) - Number(w.current||0)));
        if (label){
          map.set(normDash(label), Math.max(0, isNaN(avail) ? 0 : avail));
          rawByWin[label] = w;
        }
      }
    } else if (data.windows && typeof data.windows === 'object'){
      for (const [label, v] of Object.entries(data.windows)){
        const raw = (v && (v.available ?? (v.capacity - v.current)));
        const avail = Number.isFinite(raw) ? Number(raw) : 0;
        map.set(normDash(label), Math.max(0, avail));
        rawByWin[label] = v || {};
      }
    }
    return { map, rawByWin };
  }

  function requestedQtyFromStorage(){
    try {
      const raw = localStorage.getItem(CART_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.reduce((s,i)=> s + (parseInt(i?.quantity||0,10) || 0), 0) || 1 : 1;
    } catch { return 1; }
  }

  function applyAvailability(selectEl, avail, needQty){
    if (!selectEl) return;
    const wins = avail?.windows || {};
    const opts = Array.from(selectEl.querySelectorAll('option'));

    let selectableCount = 0;

    for (const o of opts) {
      const label = o.textContent.trim();
      if (!WINDOWS.includes(label) && !WINDOWS.includes((o.dataset.base||'').trim())) continue;

      const base = (o.dataset.base || label).trim();
      const key  = normalizeWin(base);
      const w    = wins[key] || wins[Object.keys(wins).find(k => normalizeWin(k) === key)];

      const availLeft = Number(w?.available ?? 0);
      const disabled = !w || w.sold_out || (availLeft < (needQty||1));
      o.disabled = disabled;

      // Display text (use EN–DASH in UI)
      const clean = base;
      o.textContent = disabled ? `${clean} — Full` : `${clean} — ${availLeft} left`;
      if (!disabled) selectableCount++;
    }

    // If the currently selected option just became disabled, clear it
    if (selectEl.value && selectEl.selectedOptions[0]?.disabled) {
      selectEl.value = '';
    }

    // If exactly one window remains, auto-select it
    if (!selectEl.value && selectableCount === 1) {
      const open = opts.find(o => !o.disabled && (WINDOWS.includes(o.textContent.replace(/\s+—.+$/,'').trim()) || WINDOWS.includes((o.dataset.base||'').trim())));
      if (open) selectEl.value = open.value || open.textContent;
    }
  }

  function renderPerDriverNote(selectEl, rawByWin){
    if (!selectEl) return;
    let note = document.getElementById('per-driver-note');
    if (!note) {
      note = document.createElement('div');
      note.id = 'per-driver-note';
      note.className = 'per-driver-note';
      note.style.marginTop = '.5rem';
      note.style.fontSize = '.9rem';
      note.style.opacity = '0.85';
      selectEl.parentNode.appendChild(note);
    }

    const rows = [];
    Array.from(selectEl.options).forEach(op => {
      const base = (op.dataset.base || op.value || op.textContent).replace(/\s+—.+$/,'').trim();
      if (!base) return;
      const exact = rawByWin[base];
      const fuzzyKey = Object.keys(rawByWin).find(k => normalizeWin(k) === normalizeWin(base));
      const info = exact || (fuzzyKey ? rawByWin[fuzzyKey] : null);
      if (!info) return;

      const drivers = info.drivers || {};
      const per = Object.entries(drivers).map(([d,v]) => {
        const cap = Number(v.capacity || 0);
        const cur = Number(v.current || 0);
        const rem = Math.max(0, cap - cur);
        return `${d}: ${rem}`;
      }).join(' · ');

      rows.push(`<div><strong>${base}</strong> — ${per || '—'}</div>`);
    });

    const title = `<div style="font-weight:600;margin-bottom:.25rem">Driver availability</div>`;
    note.innerHTML = title + (rows.join('') || '<div>—</div>');
  }

  async function refreshAvailability(){
    const dateEl = $('#delivery-date');
    const timeEl = $('#delivery-time');
    const slotLeft = $('#slot-left');
    if (!dateEl || !timeEl) return;

    const date = dateEl.value || ymd(new Date());
    const need = requestedQtyFromStorage();

    try{
      const data = await fetchAvailability(date);
      const { map, rawByWin } = normalizeAvailability(data);

      // Ensure base labels are preserved on options
      Array.from(timeEl.options).forEach(opt => {
        const label = (opt.dataset.base || opt.textContent || '').replace(/\s+—.+$/,'').trim();
        if (label && !opt.dataset.base) opt.dataset.base = label;
      });

      // Apply per-window disable/labels
      applyAvailability(timeEl, data, need);

      const chosenBase = (timeEl.selectedOptions[0]?.dataset.base || timeEl.value || '').replace(/\s+—.+$/,'').trim();
      const left = (chosenBase && map.has(normDash(chosenBase))) ? map.get(normDash(chosenBase)) : null;
      if (slotLeft){
        slotLeft.textContent = (chosenBase && left != null)
          ? `${left} slot${left===1?'':'s'} left for ${chosenBase}`
          : '';
      }

      renderPerDriverNote(timeEl, rawByWin);
    } catch {
      if (slotLeft) slotLeft.textContent = '';
    }
  }

  // Expose for checkout preflight
  async function preflightCapacity(dateStr, windowLabel, needQty){
    try{
      if (!dateStr || !windowLabel) return true;
      const data = await fetchAvailability(dateStr);
      const { map } = normalizeAvailability(data);
      const key = normDash(windowLabel);
      if (!map.has(key)) return true;
      const left = map.get(key);
      return left >= (needQty || 1);
    }catch{
      return true; // fail-open to avoid blocking checkout if API hiccups
    }
  }

  // Make available to other scripts
  window.refreshAvailability = refreshAvailability;
  window.preflightCapacity   = preflightCapacity;

  document.addEventListener('DOMContentLoaded', () => {
    const dateEl = $('#delivery-date');
    if (dateEl) {
      refreshAvailability();
      dateEl.addEventListener('change', refreshAvailability);
    }
  });

  // React to cart updates
  document.addEventListener('sm:cartChanged', refreshAvailability);
})();
