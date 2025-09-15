(() => {
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const LS = {
    apiBase: 'dispatch_apiBase',
    adminToken: 'dispatch_adminToken',
    drivers: 'drivers_profiles_v1',
    overrides: 'driver_day_overrides_v1',
    scheduled: 'scheduledOrders'
  };

  // Canonical windows (EN–DASH), dynamic if drivers.html injects window.SMREV_WINDOWS
  const WINDOWS = (Array.isArray(window.SMREV_WINDOWS) && window.SMREV_WINDOWS.length)
    ? window.SMREV_WINDOWS.slice()
    : ['6:00–7:00 AM','7:00–8:00 AM','8:00–9:00 AM'];

  const cfg = () => ({ apiBase: localStorage.getItem(LS.apiBase) || '', adminToken: localStorage.getItem(LS.adminToken) || '' });
  const saveCfg = (b,t)=>{ if(b!=null)localStorage.setItem(LS.apiBase,b); if(t!=null)localStorage.setItem(LS.adminToken,t); };
  const toast = (m)=>{ try{ let t=$('#toast'); if(!t){alert(m);return;} const d=document.createElement('div'); d.className='toast'; d.textContent=m; t.appendChild(d); setTimeout(()=>d.remove(),2200);}catch{alert(m);} };
  const todayStr = () => new Date().toISOString().slice(0,10);
  const escapeHtml = s => String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));
  const shortHour = w => w.replace(/:00/g,''); // compact labels (keeps AM/PM)

  // URL + auth
  const buildUrl = (base, path) => `${String(base||'').replace(/\/+$/,'')}/${String(path||'').replace(/^\/+/,'')}`;
  const authHeaders = (token) => ({ 'Authorization': `Bearer ${token}`, 'X-Admin-Token': token });

  // ===== Storage for drivers + per-day overrides =====
  function loadDrivers(){ try { return JSON.parse(localStorage.getItem(LS.drivers) || '[]'); } catch { return []; } }
  function saveDrivers(list){ localStorage.setItem(LS.drivers, JSON.stringify(list)); }

  function loadOverrides(){ try { return JSON.parse(localStorage.getItem(LS.overrides) || '{}'); } catch { return {}; } }
  function saveOverrides(map){ localStorage.setItem(LS.overrides, JSON.stringify(map || {})); }
  function getDriverOverrides(name){ const o = loadOverrides(); return o[name] || {}; }
  function setDriverOverride(name, date, winsOrNull){
    const all = loadOverrides();
    if (!all[name]) all[name] = {};
    if (winsOrNull === undefined){ delete all[name][date]; }
    else { all[name][date] = Array.isArray(winsOrNull) ? winsOrNull.slice() : []; }
    saveOverrides(all);
  }

  // ===== Availability helpers =====
  function effectiveWindowsFor(name, defaultWins, date){
    const ov = getDriverOverrides(name)[date];
    return Array.isArray(ov) ? ov : (defaultWins && defaultWins.length ? defaultWins : WINDOWS);
  }

  function windowsSummary(wins){
    const set = new Set(wins || []);
    const ordered = WINDOWS.filter(w => set.has(w));
    return ordered.map(shortHour).join(', ') || 'None';
  }

  function computeCapsByWindowAndDriver(){
    const out = {}; WINDOWS.forEach(w => out[w] = { total:0, drivers:{} });
    const date = $('#applyDate')?.value || todayStr();
    serializeDrivers().forEach(d => {
      if (!d.active) return;
      const effWins = effectiveWindowsFor(d.name, d.windows, date);
      (effWins || []).forEach(w => {
        if (!out[w]) out[w] = { total:0, drivers:{} };
        const cap = Number(d.capacity||0);
        out[w].drivers[d.name] = (out[w].drivers[d.name] || 0) + cap;
        out[w].total += cap;
      });
    });
    return out;
  }

  function renderAvailPreview(date, avail, caps){
    const host = $('#capsRows'); if (!host) return;
    host.innerHTML = '';
    const wins = Object.keys(caps).length ? Object.keys(caps) : WINDOWS;
    wins.forEach(w => {
      const a = (avail && avail.windows && (avail.windows[w] || avail.windows[Object.keys(avail.windows).find(k => k.trim()===w.trim())])) || { capacity:0, current:0, available:0, drivers:{} };
      const capPlan = caps[w] || { total:0, drivers:{} };
      const div = document.createElement('div');
      const totalLine = `<div><strong>${w}</strong>: ${Number(a.current||0)}/${Number(a.capacity||0)} used — <em>${Number(a.available||0)} open</em> (planned per-driver total: ${capPlan.total})</div>`;
      const driverLines = Object.keys(capPlan.drivers).map(d => {
        const da = a.drivers?.[d] || { capacity:0, current:0, available:0 };
        return `<div style="font-size:12px;margin-left:8px;">• ${escapeHtml(d)}: ${Number(da.current||0)}/${Number(da.capacity||0)} used — ${Number(da.available||0)} open (plan: ${capPlan.drivers[d]})</div>`;
      }).join('');
      div.innerHTML = totalLine + driverLines;
      host.appendChild(div);
    });
    if (!date) host.textContent = 'No date selected.';
  }

  async function fetchAvailability(date){
    const { apiBase, adminToken } = cfg();
    if (!apiBase || !date) return null;
    const u = new URL(buildUrl(apiBase, 'api/slot-availability'));
    u.searchParams.set('date', date);
    u.searchParams.set('detailed', '1'); // per-driver when token valid
    const r = await fetch(u.toString(), { headers: (adminToken ? authHeaders(adminToken) : {}), cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  }

  async function refreshPreview(){
    const date = $('#applyDate')?.value;
    const host = $('#capsRows');
    if (!date){ if (host) host.textContent = 'No date selected.'; return; }
    const caps = computeCapsByWindowAndDriver();
    try{
      const avail = await fetchAvailability(date);
      if (avail) renderAvailPreview(date, avail, caps);
      else if (host) host.textContent = 'Failed to load availability.';
    }catch{
      if (host) host.textContent = 'Failed to load availability.';
    }
  }

  function syncSummaryFromRow(row){
    const name = row.querySelector('.drv-name').value.trim() || 'Driver';
    const cap  = Math.max(1, Number(row.querySelector('.drv-cap').value||1));
    const active = row.querySelector('.drv-active').checked;
    const wins = row.dataset.windows ? JSON.parse(row.dataset.windows) : WINDOWS;

    const card = row.closest('.driver-card');
    card.querySelector('.drv-title').textContent = name;
    card.querySelector('.drv-cap-pill').textContent = `Cap: ${cap} per window`;
    card.querySelector('.drv-wins-pill').textContent = `Hours: ${windowsSummary(wins) || 'None'}`;
    const pill = card.querySelector('.drv-active-pill');
    pill.textContent = active ? 'Active' : 'Inactive';
    pill.classList.toggle('green', active);

    const chipsHost = card.querySelector('.drv-plan-chips');
    const chips = (wins || []).map(w => `<span class="pill">${escapeHtml(shortHour(w))} × ${cap}</span>`).join(' ');
    chipsHost.innerHTML = chips || '';
  }

  function serializeDrivers(){
    return $$('#driversList .driver-card .driver-body').map(body => {
      const name = body.querySelector('.drv-name').value.trim() || 'Driver';
      const cap  = Math.max(1, Number(body.querySelector('.drv-cap').value||1));
      const act  = body.querySelector('.drv-active').checked;
      const wins = body.dataset.windows ? JSON.parse(body.dataset.windows) : WINDOWS.slice();
      return { name, capacity: cap, active: act, windows: wins };
    });
  }

  // ===== Route utilities =====
  function startMinutes(win){
    const m = /^\s*(\d{1,2}):(\d{2})\s*–\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(String(win||'')); // "H:MM–H:MM AM/PM"
    if (m){
      let sh = +m[1], sm = +m[2], eh = +m[3], em = +m[4], period = m[5].toUpperCase();
      let sh24;
      if (period === 'AM'){ sh24 = (sh % 12); }
      else { sh24 = (sh < eh) ? (sh % 12) + 12 : (sh % 12); }
      return sh24 * 60 + sm;
    }
    return 9999;
  }
  function timeToWindow(hhmm){
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm||'')); if (!m) return '';
    const H = +m[1], M = +m[2];
    const h12 = (H % 12) || 12;
    const startStr = `${h12}:${String(M).padStart(2,'0')}`;
    return WINDOWS.find(w => w.startsWith(startStr)) || '';
  }
  function getScheduledLocal(){ try{ return JSON.parse(localStorage.getItem(LS.scheduled) || '[]'); }catch{ return []; } }

  // ----- Remote orders helpers (confirmed) -----
  async function fetchConfirmedOrders(date){
    const { apiBase, adminToken } = cfg();
    if (!apiBase || !adminToken || !date) return [];
    const url = new URL(buildUrl(apiBase, 'api/orders-feed'));
    url.searchParams.set('date', date);
    url.searchParams.set('status', 'confirmed');
    const r = await fetch(url.toString(), { headers: authHeaders(adminToken) });
    if (!r.ok) return [];
    const j = await r.json().catch(()=>({}));
    return Array.isArray(j.orders) ? j.orders : [];
  }
  async function fetchDriversForDate(date){
    const { apiBase, adminToken } = cfg();
    if (!apiBase || !adminToken || !date) return [];
    const url = new URL(buildUrl(apiBase, 'api/orders-feed'));
    url.searchParams.set('date', date);
    url.searchParams.set('status', 'confirmed');
    const r = await fetch(url.toString(), { headers: authHeaders(adminToken) });
    if (!r.ok) return [];
    const j = await r.json().catch(()=>({}));
    return Array.isArray(j.drivers) ? j.drivers : [];
  }

  function makeRouteItemFromLocal(x){
    return {
      source: 'local',
      session: x.sessionId || '',
      confirmedAt: x.confirmedAt ? new Date(x.confirmedAt).getTime() : 0,
      window: timeToWindow(x.time || '') || '',
      name: x.customerName || 'Customer',
      phone: x.phone || '',
      address: x.address || '',
      muffins: Array.isArray(x.muffins) ? x.muffins.slice() : []
    };
  }
  function parseMuffinsFromItemsStr(itemsStr){
    const s = String(itemsStr||'').trim();
    if (!s) return [];
    return s.split(/\s*,\s*/).map(part=>{
      const mQty = part.match(/x(\d+)\s*$/i);
      const mBox = part.match(/\((\d+)\)/);
      const flavor = part.replace(/\s*x\d+\s*$/i,'').replace(/\s*\(\d+\)\s*$/,'').replace(/Muffin.*$/i,'').trim();
      const qty = (mQty?Number(mQty[1]):1) * (mBox?Number(mBox[1]):1);
      return `${qty} × ${flavor || 'Muffins'}`.trim();
    });
  }
  function makeRouteItemFromApi(o){
    return {
      source: 'api',
      session: o.stripe_session_id || '',
      confirmedAt: 0,
      window: o.preferred_window || '',
      name: o.customer_name || 'Customer',
      phone: o.phone || '',
      address: o.address || '',
      muffins: parseMuffinsFromItemsStr(o.items || '')
    };
  }

  const REMOTE_BY_DATE = {};
  async function ensureRemoteForDate(date){
    if (REMOTE_BY_DATE[date]) return REMOTE_BY_DATE[date];
    const orders = await fetchConfirmedOrders(date);
    REMOTE_BY_DATE[date] = orders;
    return orders;
  }
  async function routeItemsForDriver(date, driverName, winFilter){
    const remote = await ensureRemoteForDate(date);
    const local = getScheduledLocal();

    const r = remote
      .filter(o => (o.driver || '') === driverName && (!winFilter || o.preferred_window === winFilter))
      .map(makeRouteItemFromApi);

    const l = local
      .filter(x => x.driver === driverName && x.date === date && (!winFilter || timeToWindow(x.time||'') === winFilter))
      .map(makeRouteItemFromLocal);

    const seen = new Set(l.map(i => i.session));
    const combined = l.concat(r.filter(i => !seen.has(i.session)));
    combined.sort((a,b) => startMinutes(a.window) - startMinutes(b.window));
    return combined;
  }

  function renderRouteList(host, items){
    host.innerHTML = '';
    if (!items.length){ host.innerHTML = '<div class="muted">No confirmed orders for this driver.</div>'; return; }
    const list = document.createElement('div');
    list.className = 'dispatch-list';
    items.forEach((it, idx) => {
      const card = document.createElement('div');
      card.className = 'order-card';
      const muffins = it.muffins && it.muffins.length ? it.muffins.join(', ') : '—';
      const phoneLink = it.phone ? `<a href="tel:${encodeURIComponent(it.phone)}">${escapeHtml(it.phone)}</a>` : '—';
      card.innerHTML = `
        <div class="order-top">
          <div class="order-name">#${idx+1} • ${escapeHtml(it.window || '—')}</div>
          <div class="badge">${it.source==='local'?'local':'api'}</div>
        </div>
        <div class="order-meta"><strong>${escapeHtml(it.name)}</strong> • ${phoneLink}</div>
        <div class="order-meta">${escapeHtml(it.address || '')}</div>
        <div class="order-note">${escapeHtml(muffins)}</div>
      `;
      list.appendChild(card);
    });
    host.appendChild(list);
  }

  // ===== NEW: Standalone modals (calendar, per-day editor, default hours) =====
  const modalCtx = {
    row: null,
    calMonth: new Date(),
    selDate: null,
    els: { cal: null, day: null, def: null }
  };

  function ensureModal(id, titleText, extraHeaderHtml=''){
    let m = document.getElementById(id);
    if (m) return m;
    m = document.createElement('div');
    m.id = id;
    m.className = 'hours-modal';           // reuse existing overlay styling
    m.setAttribute('role','dialog');
    m.setAttribute('aria-modal','true');

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="calendar-header" style="margin-bottom:6px; align-items:center; display:flex; gap:8px;">
        <button class="btn" data-close style="margin-right:auto">✖ Close</button>
        ${extraHeaderHtml || ''}
      </div>
      <h3 class="modal-title" style="margin:0 0 6px 0">${escapeHtml(titleText || '')}</h3>
      <div class="modal-body"></div>
      <div class="hours-actions" style="margin-top:10px; display:none;">
        <button class="btn" data-cancel>Cancel</button>
        <button class="primary-btn" data-save>Save</button>
      </div>
    `;
    m.appendChild(panel);
    document.body.appendChild(m);

    // Close handlers
    panel.querySelector('[data-close]')?.addEventListener('click', () => m.style.display='none');
    panel.querySelector('[data-cancel]')?.addEventListener('click', () => m.style.display='none');

    return m;
  }

  function showModal(modal){ if (modal) modal.style.display = 'flex'; }
  function hideModal(modal){ if (modal) modal.style.display = 'none'; }

  // ---- Calendar modal
  function ensureCalendarModal(){
    const extraHeader = `<button class="btn" id="btnOpenDefault">⚙ Set default availability</button>`;
    const cal = ensureModal('drvCalModal', 'Driver availability calendar', extraHeader);
    const body = cal.querySelector('.modal-body');

    if (!cal.dataset.built){
      // Build calendar structure
      body.innerHTML = `
        <div class="calendar-header" style="margin:0 0 6px 0;">
          <button class="calendar-nav" id="drvCalPrev" type="button">‹</button>
          <h3 id="drvCalTitle" style="margin:0"></h3>
          <button class="calendar-nav" id="drvCalNext" type="button">›</button>
        </div>
        <div class="calendar-grid">
          <div class="calendar-dow">Sun</div><div class="calendar-dow">Mon</div><div class="calendar-dow">Tue</div>
          <div class="calendar-dow">Wed</div><div class="calendar-dow">Thu</div><div class="calendar-dow">Fri</div><div class="calendar-dow">Sat</div>
          <div id="drvCalDays" class="calendar-days"></div>
        </div>
      `;
      cal.dataset.built = '1';
    }

    // Wire header buttons
    cal.querySelector('#btnOpenDefault')?.addEventListener('click', () => openDefaultModal());
    cal.querySelector('#drvCalPrev')?.addEventListener('click', () => { const m = modalCtx.calMonth; modalCtx.calMonth = new Date(m.getFullYear(), m.getMonth()-1, 1); renderCalendarModal(); });
    cal.querySelector('#drvCalNext')?.addEventListener('click', () => { const m = modalCtx.calMonth; modalCtx.calMonth = new Date(m.getFullYear(), m.getMonth()+1, 1); renderCalendarModal(); });

    modalCtx.els.cal = cal;
    return cal;
  }

  function monthStart(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
  function monthEnd(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0); }
  function ymd(date){ const y=date.getFullYear(); const m=String(date.getMonth()+1).padStart(2,'0'); const dd=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }

  function renderCalendarModal(){
    const cal = modalCtx.els.cal || ensureCalendarModal();
    const titleEl = cal.querySelector('#drvCalTitle');
    const daysHost = cal.querySelector('#drvCalDays');
    if (!titleEl || !daysHost || !modalCtx.row) return;

    const m0 = monthStart(modalCtx.calMonth);
    const mZ = monthEnd(modalCtx.calMonth);
    titleEl.textContent = m0.toLocaleString(undefined, { month:'long', year:'numeric' });

    daysHost.innerHTML = '';
    const pad = m0.getDay();
    for (let i=0;i<pad;i++){
      const cell = document.createElement('div');
      cell.className = 'calendar-cell other-month';
      daysHost.appendChild(cell);
    }

    const drvName = modalCtx.row.querySelector('.drv-name').value.trim() || 'Driver';
    const defaultWins = JSON.parse(modalCtx.row.dataset.windows || '[]');
    const overrides = getDriverOverrides(drvName);

    for (let d=1; d<=mZ.getDate(); d++){
      const cur = new Date(m0.getFullYear(), m0.getMonth(), d);
      const cell = document.createElement('div');
      cell.className = 'calendar-cell';
      if (ymd(cur) === todayStr()) cell.classList.add('today');

      const dateStr = ymd(cur);
      const ov = overrides[dateStr];
      let pill = '';
      if (Array.isArray(ov)){
        if (ov.length === 0) pill = `<span class="pill">Off</span>`;
        else pill = `<span class="pill">${ov.map(shortHour).join(', ')}</span>`;
      }

      cell.innerHTML = `<div class="date-num">${d}</div>${pill}`;
      cell.addEventListener('click', () => openDayModal(cur));
      daysHost.appendChild(cell);
    }
  }

  // ---- Default (weekly) modal
  function ensureDefaultModal(){
    const def = ensureModal('drvDefaultModal', 'Default weekly availability');
    const body = def.querySelector('.modal-body');
    const actions = def.querySelector('.hours-actions');
    actions.style.display = 'flex';

    if (!def.dataset.built){
      body.innerHTML = `
        <div class="muted" style="margin-bottom:6px">Select the hours this driver usually works each week.</div>
        <div id="drvDefaultGrid" class="hours-grid"></div>
      `;
      def.dataset.built = '1';
    }

    // Save default
    def.querySelector('[data-save]').onclick = () => {
      if (!modalCtx.row) return hideModal(def);
      const selected = readHoursGrid($('#drvDefaultGrid'));
      modalCtx.row.dataset.windows = JSON.stringify(selected);
      saveDrivers(serializeDrivers());
      syncSummaryFromRow(modalCtx.row);
      refreshPreview();
      hideModal(def); // return to calendar
    };

    modalCtx.els.def = def;
    return def;
  }

  // ---- Per-day modal
  function ensureDayModal(){
    const day = ensureModal('drvDayModal', 'Edit day availability');
    const body = day.querySelector('.modal-body');
    const actions = day.querySelector('.hours-actions');
    actions.style.display = 'flex';

    if (!day.dataset.built){
      body.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <strong id="drvDayLabel">—</strong>
          <button class="btn" id="drvDayUseDefault" type="button">Use default</button>
          <button class="btn" id="drvDayClear" type="button">Not available</button>
          <button class="btn" id="drvDayAll" type="button">All hours</button>
        </div>
        <div id="drvDayGrid" class="hours-grid"></div>
      `;
      day.dataset.built = '1';
    }

    // Wire buttons (handlers set when opening)
    modalCtx.els.day = day;
    return day;
  }

  // ---- Hours grid (checkboxes for all WINDOWS)
  function buildHoursGrid(host, winsArr){
    host.innerHTML = '';
    const set = new Set(winsArr || []);
    WINDOWS.forEach(w => {
      const id = 'h_' + Math.random().toString(36).slice(2);
      const wrap = document.createElement('label');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '6px';
      wrap.innerHTML = `<input type="checkbox" id="${id}" ${set.has(w)?'checked':''}> ${escapeHtml(w)}`;
      wrap.dataset.window = w;
      host.appendChild(wrap);
    });
  }
  function readHoursGrid(host){
    return Array.from(host.querySelectorAll('label'))
      .filter(l => l.querySelector('input')?.checked)
      .map(l => l.dataset.window);
  }

  // ---- Open modals
  function openDefaultModal(){
    const def = ensureDefaultModal();
    // Pre-fill from driver default
    const currentDefault = modalCtx.row ? JSON.parse(modalCtx.row.dataset.windows || JSON.stringify(WINDOWS)) : WINDOWS;
    buildHoursGrid($('#drvDefaultGrid'), currentDefault);
    showModal(def);
  }

  function openDayModal(dateObj){
    modalCtx.selDate = dateObj;
    const day = ensureDayModal();
    const lbl  = day.querySelector('#drvDayLabel');
    const grid = day.querySelector('#drvDayGrid');
    if (!modalCtx.row || !lbl || !grid) return;

    const drvName = modalCtx.row.querySelector('.drv-name').value.trim() || 'Driver';
    const defWins = JSON.parse(modalCtx.row.dataset.windows || '[]');
    const curOv = getDriverOverrides(drvName)[ymd(dateObj)];
    const wins = Array.isArray(curOv) ? curOv : defWins;

    lbl.textContent = `${ymd(dateObj)} (${dateObj.toLocaleDateString(undefined, { weekday:'short' })})`;
    buildHoursGrid(grid, wins);

    day.querySelector('#drvDayUseDefault').onclick = () => { setDriverOverride(drvName, ymd(dateObj), undefined); renderCalendarModal(); openDayModal(dateObj); };
    day.querySelector('#drvDayClear').onclick      = () => { setDriverOverride(drvName, ymd(dateObj), []); renderCalendarModal(); openDayModal(dateObj); };
    day.querySelector('#drvDayAll').onclick        = () => { setDriverOverride(drvName, ymd(dateObj), WINDOWS.slice()); renderCalendarModal(); openDayModal(dateObj); };

    // Save button writes selected and closes day modal (returns to calendar)
    day.querySelector('[data-save]').onclick = () => {
      const selected = readHoursGrid(grid);
      setDriverOverride(drvName, ymd(dateObj), selected);
      renderCalendarModal();
      refreshPreview();
      hideModal(day);
    };

    showModal(day);
  }

  function openCalendarModal(rowBody){
    modalCtx.row = rowBody;
    modalCtx.calMonth = new Date($('#applyDate')?.value || todayStr());
    modalCtx.selDate = null;

    ensureCalendarModal();
    renderCalendarModal();
    showModal(modalCtx.els.cal);
  }

  // ===== Driver card =====
  function driverCardEl(d){
    const tpl = $('#driverTpl').content.cloneNode(true);
    const details = tpl.querySelector('.driver-card');
    const body = tpl.querySelector('.driver-body');

    const name = body.querySelector('.drv-name');
    const cap  = body.querySelector('.drv-cap');
    const act  = body.querySelector('.drv-active');
    const rem  = body.querySelector('.removeDriver');
    const fold = body.querySelector('.toggleFold');
    const btnHours = tpl.querySelector('.edit-hours');
    const btnRoute = tpl.querySelector('.show-route');

    const routeWrap = tpl.querySelector('.route-wrap');
    const routeDate = routeWrap.querySelector('.route-date');
    const routeWin  = routeWrap.querySelector('.route-window');
    const routeLoad = routeWrap.querySelector('.load-route');
    const routeMap  = routeWrap.querySelector('.open-route-map');
    const routeList = routeWrap.querySelector('.route-list');

    name.value = d.name || '';
    cap.value  = Number(d.capacity||5);
    act.checked = (d.active!==false);

    const selWins = Array.isArray(d.windows) && d.windows.length ? d.windows : WINDOWS.slice();
    body.dataset.windows = JSON.stringify(selWins);

    const emit = () => { saveDrivers(serializeDrivers()); syncSummaryFromRow(body); refreshPreview(); };
    name.addEventListener('input', emit);
    cap.addEventListener('input', emit);
    act.addEventListener('change', emit);
    rem.addEventListener('click', () => { details.remove(); emit(); });
    fold.addEventListener('click', () => { details.open = !details.open; });

    routeDate.value = $('#applyDate')?.value || todayStr();
    async function doLoadRoute(){
      const dn = (name.value || 'Driver').trim() || 'Driver';
      const items = await routeItemsForDriver(routeDate.value, dn, routeWin.value);
      renderRouteList(routeList, items);
      const addrs = items.map(i=>i.address).filter(Boolean);
      routeMap.disabled = addrs.length === 0;
      routeMap.onclick = () => {
        if (!addrs.length) return;
        const origin = encodeURIComponent(addrs[0]);
        const dest   = encodeURIComponent(addrs[addrs.length-1]);
        const way    = addrs.slice(1,-1).map(encodeURIComponent).join('|');
        const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}${way?`&waypoints=${way}`:''}`;
        window.open(url,'_blank','noopener');
      };
    }
    routeLoad.addEventListener('click', doLoadRoute);
    btnRoute.addEventListener('click', () => {
      routeWrap.style.display = routeWrap.style.display === 'none' ? 'block' : 'none';
      if (routeWrap.style.display === 'block') doLoadRoute();
    });

    // NEW: open standalone calendar modal
    btnHours.addEventListener('click', () => openCalendarModal(body));

    syncSummaryFromRow(body);
    return details;
  }

  function renderDrivers(){
    const list = loadDrivers();
    const host = $('#driversList');
    if (!host) return;
    host.innerHTML = '';
    if (!list.length){
      host.appendChild(driverCardEl({ name:'You', capacity:5, active:true, windows:WINDOWS }));
      saveDrivers(serializeDrivers());
      return;
    }
    list.forEach(d => host.appendChild(driverCardEl(d)));
  }

  // ===== Schedule calendar (right-hand card) — unchanged =====
  const schedEls = {
    title: $('#schedTitle'),
    prev:  $('#schedPrev'),
    next:  $('#schedNext'),
    days:  $('#schedDays'),
    dayPanel:  $('#dayPanel'),
    dayTitle:  $('#dayTitle'),
    dayDrivers:$('#dayDrivers')
  };
  const schedCtx = { month: new Date(), counts: {} };
  function daysInMonth(y,m){ return new Date(y, m+1, 0).getDate(); }

  async function fetchDayCountsForMonth(baseDate){
    const { apiBase, adminToken } = cfg();
    if (!apiBase || !adminToken) return {};
    const y = baseDate.getFullYear(), m = baseDate.getMonth();
    const lastDay = daysInMonth(y, m);
    const counts = {};
    await Promise.all(Array.from({length:lastDay}, (_,i)=>i+1).map(async d=>{
      const date = ymd(new Date(y, m, d));
      try{
        const url = new URL(buildUrl(apiBase, 'api/orders-feed'));
        url.searchParams.set('date', date);
        url.searchParams.set('status', 'confirmed');
        const r = await fetch(url.toString(), { headers: authHeaders(adminToken) });
        if (!r.ok) { counts[date]=0; return; }
        const j = await r.json().catch(()=>({}));
        counts[date] = Number(j.count || (Array.isArray(j.orders)? j.orders.length : 0)) || 0;
      }catch{ counts[date]=0; }
    }));
    return counts;
  }

  function renderSchedCalendar(){
    const { title, days } = schedEls;
    if (!title || !days) return;

    const m0 = monthStart(schedCtx.month);
    const mZ = monthEnd(schedCtx.month);

    title.textContent = m0.toLocaleString(undefined, { month:'long', year:'numeric' });

    days.innerHTML = '';
    const pad = m0.getDay();
    for (let i=0;i<pad;i++){
      const cell = document.createElement('div');
      cell.className = 'calendar-cell other-month';
      days.appendChild(cell);
    }
    for (let d=1; d<=mZ.getDate(); d++){
      const cur = new Date(m0.getFullYear(), m0.getMonth(), d);
      const dateStr = ymd(cur);
      const cell = document.createElement('div');
      cell.className = 'calendar-cell';
      if (dateStr === todayStr()) cell.classList.add('today');

      const cnt = schedCtx.counts[dateStr] || 0;
      const badge = cnt ? `<span class="count-badge">${cnt}</span>` : '';
      cell.innerHTML = `<div class="date-num">${d}</div>${badge}`;
      cell.dataset.date = dateStr;
      cell.addEventListener('click', () => showDay(dateStr));
      days.appendChild(cell);
    }
  }

  async function showDay(dateStr){
    if (schedEls.dayTitle) schedEls.dayTitle.textContent = dateStr;
    if (schedEls.dayDrivers) schedEls.dayDrivers.innerHTML = '<div class="muted">Loading…</div>';

    const remoteDrivers = await fetchDriversForDate(dateStr);
    const localDrivers = Array.from(new Set(
      getScheduledLocal().filter(x => x.date === dateStr).map(x => x.driver).filter(Boolean)
    ));
    const names = Array.from(new Set([ ...remoteDrivers, ...localDrivers ])).sort();

    if (!names.length){
      if (schedEls.dayDrivers) schedEls.dayDrivers.innerHTML = '<div class="muted">No drivers with confirmed orders.</div>';
      return;
    }

    const host = schedEls.dayDrivers;
    if (!host) return;
    host.innerHTML = '';
    for (const name of names){
      const details = document.createElement('details');
      details.className = 'driver-day-card';
      const summary = document.createElement('summary');
      summary.innerHTML = `<strong>${escapeHtml(name)}</strong> <span class="muted">(tap to view route)</span>`;
      const content = document.createElement('div');
      content.className = 'driver-day-route';
      content.innerHTML = '<div class="muted">Loading route…</div>';

      details.addEventListener('toggle', async () => {
        if (!details.open) return;
        const items = await routeItemsForDriver(dateStr, name, '');
        const total = items.length;

        const counts = {};
        items.forEach(i => { if (i.window) counts[i.window] = (counts[i.window]||0) + 1; });
        const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
        const suffix = top ? ` — busiest: ${escapeHtml(top[0])} (${top[1]})` : '';

        summary.innerHTML = `<strong>${escapeHtml(name)}</strong> • ${total} stop${total===1?'':'s'}${suffix}`;

        const mapBtn = document.createElement('button');
        mapBtn.type = 'button';
        mapBtn.className = 'mini';
        mapBtn.textContent = '🗺️ Open Google Maps';
        const addrs = items.map(i=>i.address).filter(Boolean);
        mapBtn.disabled = addrs.length === 0;
        mapBtn.onclick = () => openMaps(addrs);

        const listHost = document.createElement('div');
        renderRouteList(listHost, items);

        content.innerHTML = '';
        content.appendChild(mapBtn);
        content.appendChild(listHost);
      }, { once: true });

      details.appendChild(summary);
      details.appendChild(content);
      host.appendChild(details);
    }

    if (schedEls.dayPanel) schedEls.dayPanel.style.display = 'block';
  }

  async function loadSchedMonth(){
    try{
      schedCtx.counts = await fetchDayCountsForMonth(schedCtx.month);
    }catch{ schedCtx.counts = {}; }
    renderSchedCalendar();
  }

  function openMaps(addresses){
    const list = (addresses || []).filter(Boolean);
    if (!list.length) return;
    const origin = encodeURIComponent(list[0]);
    const dest   = encodeURIComponent(list[list.length-1]);
    const way    = list.slice(1,-1).map(encodeURIComponent).join('|');
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}${way?`&waypoints=${way}`:''}`;
    window.open(url,'_blank','noopener');
  }

  // ===== Existing "Map Orders" quick tool =====
  async function loadConfirmed(){
    const { apiBase, adminToken } = cfg();
    if (!apiBase || !adminToken) { toast('Set API Base & Token'); return; }
    const date = $('#mapDate')?.value;
    if (!date){ toast('Pick a date'); return; }
    const win = $('#mapWindow')?.value;

    const url = new URL(buildUrl(apiBase, 'api/orders-feed'));
    url.searchParams.set('date', date);
    url.searchParams.set('status', 'confirmed');

    const r = await fetch(url.toString(), { headers: authHeaders(adminToken) });
    if (!r.ok){ toast('Load failed'); return; }
    const j = await r.json();
    const addresses = (j.orders || [])
      .filter(o => !win || o.preferred_window === win)
      .map(o => o.address)
      .filter(Boolean);

    const addrList = $('#addrList');
    const openMapBtn = $('#openMap');
    if (!addresses.length){
      if (addrList) addrList.textContent = 'No confirmed orders (or none in that window).';
      if (openMapBtn) openMapBtn.disabled = true;
      return;
    }
    const list = document.createElement('div');
    list.innerHTML = addresses.map(a => `<div>• ${escapeHtml(a)}</div>`).join('');
    if (addrList){ addrList.innerHTML = ''; addrList.appendChild(list); }
    if (openMapBtn){
      openMapBtn.disabled = false;
      openMapBtn.onclick = () => openMaps(addresses);
    }
  }

  // ===== Init =====
  (function init(){
    const defaultBase = (()=>{ try{ return new URL('.', window.location.href).href.replace(/\/$/,''); } catch { return window.location.origin; } })();
    const c = cfg();
    const apiBaseEl = $('#apiBase');
    const adminTokenEl = $('#adminToken');
    if (apiBaseEl) apiBaseEl.value = c.apiBase || defaultBase;
    if (adminTokenEl) adminTokenEl.value = c.adminToken || '';

    const today = todayStr();
    const applyDateEl = $('#applyDate');
    const mapDateEl = $('#mapDate');
    if (applyDateEl) applyDateEl.value = today;
    if (mapDateEl) mapDateEl.value = today;

    $('#saveCfg')?.addEventListener('click', () => { saveCfg($('#apiBase')?.value.trim(), $('#adminToken')?.value.trim()); toast('Saved'); refreshPreview(); });
    $('#openDispatch')?.addEventListener('click', () => window.open('dispatch.html','_self'));
    $('#addDriver')?.addEventListener('click', () => {
      const host = $('#driversList');
      if (!host) return;
      host.appendChild(driverCardEl({ name:'', capacity:5, active:true, windows:WINDOWS }));
      saveDrivers(serializeDrivers());
      refreshPreview();
    });
    $('#resetDrivers')?.addEventListener('click', () => {
      const host = $('#driversList');
      if (!host) return;
      host.innerHTML = '';
      host.appendChild(driverCardEl({ name:'You', capacity:5, active:true, windows:WINDOWS }));
      saveDrivers(serializeDrivers());
      refreshPreview();
    });
    applyDateEl?.addEventListener('change', refreshPreview);

    // Apply capacities to Airtable
    $('#applyCapacity')?.addEventListener('click', async () => {
      const { apiBase, adminToken } = cfg();
      if (!apiBase || !adminToken) { toast('Set API Base & Token'); return; }
      const date = $('#applyDate')?.value;
      if (!date) { toast('Choose a date'); return; }

      const caps = computeCapsByWindowAndDriver();
      const capsList = [];
      for (const [w, obj] of Object.entries(caps)){
        for (const [driver, cap] of Object.entries(obj.drivers)){
          capsList.push({ driver, window: w, capacity: cap });
        }
      }

      const u = buildUrl(apiBase, 'api/drivers-capacity-set');
      const r = await fetch(u, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', ...authHeaders(adminToken) },
        body: JSON.stringify({ date, caps: capsList })
      });

      if (!r.ok) { toast('Apply failed'); return; }
      toast('Per-driver capacity applied');
      await refreshPreview();
    });

    $('#loadMapOrders')?.addEventListener('click', loadConfirmed);

    renderDrivers();
    refreshPreview();

    // Right-side schedule calendar (if present)
    if (schedEls.prev) schedEls.prev.addEventListener('click', async () => {
      const d = schedCtx.month; schedCtx.month = new Date(d.getFullYear(), d.getMonth()-1, 1);
      await loadSchedMonth();
    });
    if (schedEls.next) schedEls.next.addEventListener('click', async () => {
      const d = schedCtx.month; schedCtx.month = new Date(d.getFullYear(), d.getMonth()+1, 1);
      await loadSchedMonth();
    });
    if (schedEls.title && schedEls.days) { loadSchedMonth().then(()=> { showDay(today).catch(()=>{}); }); }
  })();
})();
