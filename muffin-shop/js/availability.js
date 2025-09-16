// availability.js — driver-enforced availability UI + preflight (dynamic windows)
(() => {
  const { $, normDash } = window.SMUtils || {};

  const CART_KEY = 'sm_cart_v1';

  // ---- API base helper (SM REV) ----
  const API_BASE = (window.SMREV_API_BASE || '/api').replace(/\/+$/, '');
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
      const url = apiUrl('/slot-availability', { date });
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // Pull {available} per window AND a normalized windows list from API data
  function normalizeAvailability(data){
    const map = new Map();   // normalized-window -> available
    const rawByWin = {};     // original response object per window (includes drivers)
    let windowsList = [];

    if (!data || !data.windows) return { map, rawByWin, windowsList };

    if (Array.isArray(data.windows)) {
      // (Not used by our API, but keep for safety)
      data.windows.forEach(w => {
        const label = normalizeWin(w.window || w.label || w.name || '');
        if (!label) return;
        const avail = Number(w.available ?? (Number(w.capacity||0) - Number(w.current||0)));
        map.set(normDash(label), Math.max(0, isNaN(avail) ? 0 : avail));
        rawByWin[label] = w;
        windowsList.push(label);
      });
    } else if (typeof data.windows === 'object') {
      // Keys are window labels
      for (const [labelRaw, v] of Object.entries(data.windows)){
        const label = normalizeWin(labelRaw);
        const raw = (v && (v.available ?? (v.capacity - v.current)));
        const avail = Number.isFinite(raw) ? Number(raw) : 0;
        map.set(normDash(label), Math.max(0, avail));
        rawByWin[label] = v || {};
        windowsList.push(label);
      }
    }

    // Keep insertion order (API builds in chronological order); no extra sort needed
    return { map, rawByWin, windowsList };
  }

  function requestedQtyFromStorage(){
    try {
      const raw = localStorage.getItem(CART_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.reduce((s,i)=> s + (parseInt(i?.quantity||0,10) || 0), 0) || 1 : 1;
    } catch { return 1; }
  }

  // Rebuild the <select> options to match the windows provided by the API (preserving selection if possible)
  function rebuildTimeOptions(selectEl, windowsList){
    if (!selectEl || !Array.isArray(windowsList)) return;

    // Snapshot current selection (base label w/o trailing " — …")
    const curBase = (selectEl.selectedOptions[0]?.dataset.base || selectEl.value || '')
      .replace(/\s+—.+$/,'').trim();

    // Build list of current base labels (exclude placeholder)
    const currentBases = Array.from(selectEl.options)
      .filter(o => o.value !== '')
      .map(o => (o.dataset.base || o.textContent || '').replace(/\s+—.+$/,'').trim());

    // If identical, skip rebuild
    const same =
      currentBases.length === windowsList.length &&
      currentBases.every((b, i) => b === windowsList[i]);
    if (same) return;

    // Rebuild with a single placeholder
    selectEl.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Select a window…';
    selectEl.appendChild(ph);

    windowsList.forEach(label => {
      const opt = document.createElement('option');
      opt.value = label;
      opt.textContent = label;
      opt.dataset.base = label;
      selectEl.appendChild(opt);
    });

    // Try to restore selection if it still exists
    if (curBase && windowsList.includes(curBase)) {
      selectEl.value = curBase;
    } else {
      // leave unselected; applyAvailability may auto-select if exactly one open
      selectEl.value = '';
    }
  }

  function applyAvailability(selectEl, data, needQty){
    if (!selectEl || !data) return;
    const wins = data.windows || {};
    const opts = Array.from(selectEl.querySelectorAll('option'));

    let selectableCount = 0;

    for (const o of opts) {
      if (o.value === '') continue; // skip placeholder
      const base = (o.dataset.base || o.textContent || '').replace(/\s+—.+$/,'').trim();
      if (!base) continue;

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
      const open = opts.find(o => o.value && !o.disabled);
      if (open) selectEl.value = open.value;
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
      if (op.value === '') return;
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
      const { map, rawByWin, windowsList } = normalizeAvailability(data);

      // Rebuild options to mirror API-provided windows for this date
      if (windowsList && windowsList.length) {
        rebuildTimeOptions(timeEl, windowsList);
      }

      // Ensure base labels are preserved on options (safety)
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
    const timeEl = $('#delivery-time');
    if (dateEl || timeEl) {
      refreshAvailability();
      if (dateEl) dateEl.addEventListener('change', refreshAvailability);
      if (timeEl) timeEl.addEventListener('change', refreshAvailability);
    }
  });

  // React to cart updates
  document.addEventListener('sm:cartChanged', refreshAvailability);
})();
