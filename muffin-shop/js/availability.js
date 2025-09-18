// availability.js — unified dynamic availability UI + preflight (absorbs slots-ui details)
(() => {
  // ---- light utils / fallbacks ----
  const $  = (sel, root=document) => (window.SMUtils?.$ ? window.SMUtils.$(sel) : root.querySelector(sel));
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const normDash = (s) =>
    (window.SMUtils?.normDash ? window.SMUtils.normDash(s) : String(s||'').replace(/–|—|-/g,'–').trim());

  const toastHost = document.getElementById('toast');
  let _toastTimer;
  function toast(msg, ms=2200){
    if (!msg) return;
    if (toastHost) {
      toastHost.textContent = msg;
      toastHost.classList.add('show');
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => {
        toastHost.classList.remove('show');
        toastHost.textContent = '';
      }, ms);
    } else {
      // Fallback — only if no #toast element is present
      try { window.alert(msg); } catch {}
    }
  }

  // ---- global marker so any legacy scripts can bail out ----
  window.SMREV_AVAIL_DYNAMIC = true;

  // ---- API base helper (SM REV) ----
  const API_BASE = (window.SMREV_API_BASE || '/api').replace(/\/+$/, '');
  function apiUrl(path, params) {
    const full = `${API_BASE}${path.startsWith('/') ? path : '/' + path}`;
    let u; try { u = new URL(full); } catch { u = new URL(full, window.location.origin); }
    if (params) for (const [k,v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  // ---- date helpers ----
  const ymd = (d) => {
    const x = d instanceof Date ? d : new Date(d);
    return isNaN(x) ? '' : x.toISOString().slice(0,10);
  };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); x.setHours(0,0,0,0); return x; };
  const fmtDateInput = (d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  // ---- window label normalization (visual + AM/PM) ----
  function normalizeWin(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    s = s.replace(/\s*-\s*/g,'–').replace(/\s*–\s*/g,'–'); // force EN–DASH visually
    s = s.replace(/\s*(am|pm)$/i, m => ' ' + m.toUpperCase());
    return s;
  }

  // ---- fetch availability (public aggregate) ----
  async function fetchAvailability(date) {
    if (!date) return null;
    try {
      const url = apiUrl('/slot-availability', { date });
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // ---- normalize API response into: map(label->available), rawByWin, ordered windowsList ----
  function normalizeAvailability(data){
    const map = new Map();   // normalized-window -> available
    const rawByWin = {};     // original response object per window (includes drivers if detailed)
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

    // Keep insertion order (API builds in chronological order)
    return { map, rawByWin, windowsList };
  }

  // ---- cart qty (read from localStorage to avoid coupling) ----
  const CART_KEY = 'sm_cart_v1';
  function requestedQtyFromStorage(){
  // Capacity is per ORDER (one slot per checkout), not per item count.
  return 1;
}

  // ---- rebuild the <select> to mirror API-provided windows for the date ----
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

  // ---- paint options: "Full" or "N left" and enable/disable ----
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
      // direct key or fuzzy match by normalized label
      const w    = wins[key] || wins[Object.keys(wins).find(k => normalizeWin(k) === key)];

      const availLeft = Number(w?.available ?? 0);
      const disabled = !w || w.sold_out || (availLeft < (needQty||1));
      o.disabled = disabled;

      const clean = base; // show label as-is with EN–DASH
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

  // ---- optional driver breakdown note (only shows if API returned driver data) ----
  function renderPerDriverNote(selectEl, rawByWin){
    if (!selectEl) return;
    const anyDrivers = Object.values(rawByWin).some(v => v && v.drivers && Object.keys(v.drivers).length);
    let note = document.getElementById('per-driver-note');

    if (!anyDrivers) { if (note) note.remove(); return; }

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

  // ---- main refresh routine ----
  async function refreshAvailability(){
    const dateEl = $('#delivery-date');
    const timeEl = $('#delivery-time');
    const slotLeft = $('#slot-left');
    if (!dateEl || !timeEl) return;

    // ensure the select isn't locked by any other script
    timeEl.disabled = false;

    // Enforce a rolling 14-day max (absorbed from slots-ui)
    const max = fmtDateInput(addDays(new Date(), 14));
    if (!dateEl.max || dateEl.max !== max) dateEl.max = max;
    if (dateEl.value && dateEl.value > max) { dateEl.value = max; toast('Date adjusted to 14-day window'); }

    const date = dateEl.value || ymd(new Date());
    const need = requestedQtyFromStorage();

    try{
      const data = await fetchAvailability(date);
      const { map, rawByWin, windowsList } = normalizeAvailability(data);

      // Rebuild options to mirror API-provided windows for this date (always)
      const apiWindows = Object.keys((data && data.windows) || {});
      rebuildTimeOptions(timeEl, apiWindows);

      // Safety: ensure base labels are preserved on options
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
      toast('Could not load availability. Please try again.');
    }
  }

  // ---- preflight guard for checkout submit ----
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

  // ---- expose for other scripts ----
  window.refreshAvailability = refreshAvailability;
  window.preflightCapacity   = preflightCapacity;

  // ---- boot ----
  document.addEventListener('DOMContentLoaded', () => {
    const dateEl = $('#delivery-date');
    const timeEl = $('#delivery-time');
    if (!dateEl || !timeEl) return;

    // ensure selectable
    timeEl.disabled = false;

    // initial load + react to changes
    refreshAvailability();
    dateEl.addEventListener('change', refreshAvailability);
    timeEl.addEventListener('change', refreshAvailability);
  });

  // React to cart updates
  document.addEventListener('sm:cartChanged', refreshAvailability);
})();
