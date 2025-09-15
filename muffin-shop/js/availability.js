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

  // ===== Dynamic hourly window grid (default 6:00 AM → 7:00 PM, step 60m)
  const DASH_EN = '–';
  function pad2(n){ return String(n).padStart(2,'0'); }
  function minsTo12hLabel(m){
    let hh = Math.floor(m/60) % 24;
    const mm = m % 60;
    const am = hh < 12;
    let h12 = hh % 12; if (h12 === 0) h12 = 12;
    return `${h12}:${pad2(mm)} ${am ? 'AM' : 'PM'}`;
  }
  function expandGrid(startH=6, endH=19, step=60){
    const out = [];
    for (let t = startH*60; t + step <= endH*60; t += step){
      out.push(`${minsTo12hLabel(t)}${DASH_EN}${minsTo12hLabel(t+step)}`);
    }
    return out;
  }
  const ALL_WINDOWS = expandGrid(6, 19, 60); // 6:00 AM–7:00 PM hourly

  const cfg = () => ({ apiBase: localStorage.getItem(LS.apiBase) || '', adminToken: localStorage.getItem(LS.adminToken) || '' });
  const saveCfg = (b,t)=>{ if(b!=null)localStorage.setItem(LS.apiBase,b); if(t!=null)localStorage.setItem(LS.adminToken,t); };
  const toast = (m)=>{ try{ let t=$('#toast'); if(!t){alert(m);return;} const d=document.createElement('div'); d.className='toast'; d.textContent=m; t.appendChild(d); setTimeout(()=>d.remove(),2200);}catch{alert(m);} };
  const todayStr = () => new Date().toISOString().slice(0,10);
  const escapeHtml = s => String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));

  // Robust URL join + auth headers
  const buildUrl = (base, path) => `${String(base||'').replace(/\/+$/,'')}/${String(path||'').replace(/^\/+/,'')}`;
  const authHeaders = (token) => ({ 'Authorization': `Bearer ${token}`, 'X-Admin-Token': token });

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

  // Normalize/compare window labels
  function normDash(s){ return String(s||'').replace(/–|—|-/g, DASH_EN).trim(); }
  function normalizeWin(raw){
    if (!raw) return '';
    let s = String(raw).trim();
    s = s.replace(/\s*-\s*/g, DASH_EN).replace(/\s*–\s*/g, DASH_EN);
    s = s.replace(/\s*(am|pm)$/i, m => ' ' + m.toUpperCase());
    return s;
  }

  function startMinutes(win){
    try{
      const start = String(win).split(DASH_EN)[0].trim();
      const m = start.match(/^(\d{1,2}):?(\d{2})?\s*(AM|PM)$/i);
      if (!m) return Number.MAX_SAFE_INTEGER;
      let h = parseInt(m[1],10);
      const mm = parseInt(m[2] ?? '0',10);
      const ap = m[3].toUpperCase();
      if (h === 12) h = 0;
      if (ap === 'PM') h += 12;
      return h*60 + mm;
    }catch{ return Number.MAX_SAFE_INTEGER; }
  }

  function effectiveWindowsFor(name, defaultWins, date){
    const ov = getDriverOverrides(name)[date];
    return Array.isArray(ov) ? ov : (defaultWins && defaultWins.length ? defaultWins : ALL_WINDOWS);
  }

  function shortHour(win){
    // "6:00–7:00 AM" -> "6–7 AM"; "12:00–1:00 PM" -> "12–1 PM"
    const m = String(win).match(/^(\d{1,2})(?::\d{2})?–(\d{1,2})(?::\d{2})?\s*(AM|PM)$/i);
    if (!m) return win;
    return `${m[1]}–${m[2]} ${m[3].toUpperCase()}`;
  }
  function windowsSummary(wins){
    const list = (wins || []).slice().sort((a,b)=> startMinutes(a)-startMinutes(b));
    return list.map(shortHour).join(', ') || 'None';
  }

  function computeCapsByWindowAndDriver(){
    const out = {}; // window -> { total, drivers: { name:cap } }
    const date = $('#applyDate')?.value || todayStr();
    serializeDrivers().forEach(d => {
      if (!d.active) return;
      const effWins = effectiveWindowsFor(d.name, d.windows, date);
      (effWins || []).forEach(w => {
        if (!out[w]) out[w] = { total:0, drivers:{} };
        out[w].drivers[d.name] = (out[w].drivers[d.name] || 0) + Number(d.capacity||0);
        out[w].total += Number(d.capacity||0);
      });
    });
    // Sort keys chronologically
    const sorted = {};
    Object.keys(out).sort((a,b)=> startMinutes(a)-startMinutes(b)).forEach(k => sorted[k]=out[k]);
    return sorted;
  }

  function renderAvailPreview(date, avail, caps){
    const host = $('#capsRows'); if (!host) return;
    host.innerHTML = '';
    const wins = Object.keys(caps);
    if (!wins.length){ host.textContent = date ? 'No planned hours selected.' : 'No date selected.'; return; }
    wins.forEach(w => {
      const a = (avail && avail.windows && avail.windows[w]) ? avail.windows[w] : { capacity:0, current:0, available:0, drivers:{} };
      const capPlan = caps[w] || { total:0, drivers:{} };
      const div = document.createElement('div');
      const totalLine = `<div><strong>${w}</strong>: ${a.current}/${a.capacity} used — <em>${a.available} open</em> (plan total: ${capPlan.total})</div>`;
      const driverLines = Object.keys(capPlan.drivers).map(d => {
        const da = a.drivers?.[d] || { capacity:0, current:0, available:0 };
        return `<div style="font-size:12px;margin-left:8px;">• ${escapeHtml(d)}: ${da.current}/${da.capacity} used — ${da.available} open (plan: ${capPlan.drivers[d]})</div>`;
      }).join('');
      div.innerHTML = totalLine + driverLines;
      host.appendChild(div);
    });
  }

  async function fetchAvailability(date){
    const { apiBase, adminToken } = cfg(); if (!apiBase || !date) return null;
    const u = new URL(buildUrl(apiBase, 'api/slot-availability'));
    u.searchParams.set('date', date);
    u.searchParams.set('detailed', '1'); // ask for per-driver details
    const r = await fetch(u.toString(), { headers: authHeaders(adminToken) }); // include token
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
    const wins = row.dataset.windows ? JSON.parse(row.dataset.windows) : ALL_WINDOWS;

    const card = row.closest('.driver-card');
    card.querySelector('.drv-title').textContent = name;
    card.querySelector('.drv-cap-pill').textContent = `Cap: ${cap} per window`;
    card.querySelector('.drv-wins-pill').textContent = `Hours: ${windowsSummary(wins) || 'None'}`;
    const pill = card.querySelector('.drv-active-pill');
    pill.textContent = active ? 'Active' : 'Inactive';
    pill.classList.toggle('green', active);

    const chipsHost = card.querySelector('.drv-plan-chips');
    const chips = (wins || []).sort((a,b)=>startMinutes(a)-startMinutes(b)).map(w => `<span class="pill">${escapeHtml(shortHour(w))} × ${cap}</span>`).join(' ');
    chipsHost.innerHTML = chips || '';
  }

  function serializeDrivers(){
    return $$('#driversList .driver-card .driver-body').map(body => {
      const name = body.querySelector('.drv-name').value.trim() || 'Driver';
      const cap  = Math.max(1, Number(body.querySelector('.drv-cap').value||1));
      const act  = body.querySelector('.drv-active').checked;
      const wins = body.dataset.windows ? JSON.parse(body.dataset.windows) : ALL_WINDOWS.slice();
      return { name, capacity: cap, active: act, windows: wins };
    });
  }

  // Route helpers (generalized)
  function routeTimeKey(win){ return startMinutes(win); }
  function timeToWindow(hhmm){
    // '06:00' → '6:00–7:00 AM', etc.
    const m = String(hhmm||'').match(/^(\d{2}):(\d{2})$/);
    if (!m) return '';
    const h = parseInt(m[1],10), mm = parseInt(m[2],10);
    const start = minsTo12hLabel(h*60 + mm);
    const end   = minsTo12hLabel(h*60 + mm + 60);
    return `${start}${DASH_EN}${end}`;
  }

  function getScheduledLocal(){
    try{ return JSON.parse(localStorage.getItem(LS.scheduled) || '[]'); }catch{ return []; }
  }

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

  // Build route using cached remote + local
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
      .filter(o => (o.driver || '') === driverName && (!winFilter || normalizeWin(o.preferred_window) === normalizeWin(winFilter)))
      .map(makeRouteItemFromApi);

    const l = local
      .filter(x => x.driver === driverName && x.date === date && (!winFilter || normalizeWin(timeToWindow(x.time||'')) === normalizeWin(winFilter)))
      .map(makeRouteItemFromLocal);

    const seen = new Set(l.map(i => i.session));
    const combined = l.concat(r.filter(i => !seen.has(i.session)));
    combined.sort((a,b) => {
      if ((a.confirmedAt||0)!==(b.confirmedAt||0)) return (a.confirmedAt||0)-(b.confirmedAt||0);
      return routeTimeKey(a.window)-routeTimeKey(b.window);
    });
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

  // Existing per-driver card, now dynamic windows
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

    const selWins = Array.isArray(d.windows) && d.windows.length ? d.windows : ALL_WINDOWS.slice();
    body.dataset.windows = JSON.stringify(selWins);

    const emit = () => { saveDrivers(serializeDrivers()); syncSummaryFromRow(body); refreshPreview(); };
    name.addEventListener('input', emit);
    cap.addEventListener('input', emit);
    act.addEventListener('change', emit);
    rem.addEventListener('click', () => { details.remove(); emit(); });
    fold.addEventListener('click', () => { details.open = !details.open; });

    // Route tools
    // Populate window filter with dynamic options + "All windows"
    routeWin.innerHTML = '<option value="">All windows</option>' + ALL_WINDOWS.map(w => `<option>${w}</option>`).join('');
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

    btnHours.addEventListener('click', () => openHoursModal(body));

    syncSummaryFromRow(body);
    return details;
  }

  function renderDrivers(){
    const list = loadDrivers();
    const host = $('#driversList');
    if (!host) return;
    host.innerHTML = '';
    if (!list.length){
      host.appendChild(driverCardEl({ name:'You', capacity:5, active:true, windows:ALL_WINDOWS.slice(0,3) })); // default 6–9 AM to start
      saveDrivers(serializeDrivers());
      return;
    }
    list.forEach(d => host.appendChild(driverCardEl(d)));
  }

  // ===== Hours modal calendar =====
  let modalCtx = { row: null, calMonth: new Date(), selDate: null };

  function buildWeeklyGrid(host, winsArr){
    host.innerHTML = '';
    const wanted = Array.isArray(winsArr) && winsArr.length ? winsArr : ALL_WINDOWS;
    ALL_WINDOWS.forEach(w => {
      const id = 'wk_' + Math.random().toString(36).slice(2);
      const wrap = document.createElement('label');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '6px';
      wrap.innerHTML = `<input type="checkbox" id="${id}" ${wanted.includes(w)?'checked':''}> ${w}`;
      wrap.dataset.window = w;
      host.appendChild(wrap);
    });
  }
  function readWeeklyGrid(host){
    return Array.from(host.querySelectorAll('label')).filter(l => l.querySelector('input')?.checked).map(l => l.dataset.window);
  }

  function monthStart(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
  function monthEnd(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0); }
  function ymd(date){ const y=date.getFullYear(); const m=String(date.getMonth()+1).padStart(2,'0'); const dd=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }

  function renderCalendar(){
    const title = $('#calTitle'), daysHost = $('#calDays');
    if (!title || !daysHost) return;
    const m0 = monthStart(modalCtx.calMonth);
    const mZ = monthEnd(modalCtx.calMonth);
    title.textContent = m0.toLocaleString(undefined, { month:'long', year:'numeric' });

    daysHost.innerHTML = '';
    const pad = m0.getDay();
    for (let i=0;i<pad;i++){
      const cell = document.createElement('div');
      cell.className = 'calendar-cell other-month';
      daysHost.appendChild(cell);
    }
    const drvName = modalCtx.row?.querySelector('.drv-name')?.value.trim() || 'Driver';
    const defaultWins = JSON.parse(modalCtx.row?.dataset?.windows || '[]');
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
      cell.addEventListener('click', () => openDayEditor(cur));
      daysHost.appendChild(cell);
    }
  }

  function openDayEditor(dateObj){
    modalCtx.selDate = dateObj;
    const host = $('#dayEditor');
    const lbl  = $('#deDate');
    const grid = $('#deGrid');
    if (!host || !lbl || !grid || !modalCtx.row) return;

    const drvName = modalCtx.row.querySelector('.drv-name').value.trim() || 'Driver';
    const defWins = JSON.parse(modalCtx.row.dataset.windows || '[]');
    const curOv = getDriverOverrides(drvName)[ymd(dateObj)];
    const wins = Array.isArray(curOv) ? curOv : defWins;

    lbl.textContent = `Edit: ${ymd(dateObj)} (${dateObj.toLocaleDateString(undefined, { weekday:'short' })})`;
    buildWeeklyGrid(grid, wins);
    host.style.display = 'block';

    $('#deUseDefault').onclick = () => { setDriverOverride(drvName, ymd(dateObj), undefined); renderCalendar(); openDayEditor(dateObj); };
    $('#deClear').onclick      = () => { setDriverOverride(drvName, ymd(dateObj), []); renderCalendar(); openDayEditor(dateObj); };
    $('#deAll').onclick        = () => { setDriverOverride(drvName, ymd(dateObj), ALL_WINDOWS.slice()); renderCalendar(); openDayEditor(dateObj); };

    grid.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        const selected = readWeeklyGrid(grid);
        setDriverOverride(drvName, ymd(dateObj), selected);
        renderCalendar();
      });
    });
  }

  function openHoursModal(rowBody){
    modalCtx.row = rowBody;
    modalCtx.calMonth = new Date($('#applyDate')?.value || todayStr());
    modalCtx.selDate = null;

    const wkGrid = $('#hoursGrid');
    const currentDefault = JSON.parse(rowBody.dataset.windows || JSON.stringify(ALL_WINDOWS.slice(0,3)));
    if (wkGrid) buildWeeklyGrid(wkGrid, currentDefault);

    $('#hoursModal')?.style && ($('#hoursModal').style.display = 'flex');

    renderCalendar();
    $('#calPrev')?.addEventListener('click', () => { const m = modalCtx.calMonth; modalCtx.calMonth = new Date(m.getFullYear(), m.getMonth()-1, 1); renderCalendar(); });
    $('#calNext')?.addEventListener('click', () => { const m = modalCtx.calMonth; modalCtx.calMonth = new Date(m.getFullYear(), m.getMonth()+1, 1); renderCalendar(); });
  }
  function closeHoursModal(){ const m=$('#hoursModal'); if (m) m.style.display='none'; modalCtx = { row:null, calMonth:new Date(), selDate:null }; }
  $('#hoursCancel')?.addEventListener('click', closeHoursModal);
  $('#hoursSave')?.addEventListener('click', () => {
    if (!modalCtx.row) return closeHoursModal();
    const selectedDefault = readWeeklyGrid($('#hoursGrid'));
    modalCtx.row.dataset.windows = JSON.stringify(selectedDefault);
    saveDrivers(serializeDrivers());
    syncSummaryFromRow(modalCtx.row);
    refreshPreview();
    closeHoursModal();
  });

  // ===== New: Schedule Calendar (month view) =====
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

  function monthStart(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
  function monthEnd(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0); }
  function ymd2(date){ const y=date.getFullYear(); const m=String(date.getMonth()+1).padStart(2,'0'); const dd=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }

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
      const dateStr = ymd2(cur);
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
        summary.innerHTML = `<strong>${escapeHtml(name)}</strong> • ${total} stop${total===1?'':'s'}`;

        const listWrap = document.createElement('div');
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

  // ===== Existing "Map Orders" quick tool (kept) =====
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
      .filter(o => !win || normalizeWin(o.preferred_window) === normalizeWin(win))
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
    // Default base = current folder (e.g., https://site/SM-REV/admin)
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
      host.appendChild(driverCardEl({ name:'', capacity:5, active:true, windows:ALL_WINDOWS.slice(0,3) }));
      saveDrivers(serializeDrivers());
      refreshPreview();
    });
    $('#resetDrivers')?.addEventListener('click', () => {
      const host = $('#driversList');
      if (!host) return;
      host.innerHTML = '';
      host.appendChild(driverCardEl({ name:'You', capacity:5, active:true, windows:ALL_WINDOWS.slice(0,3) }));
      saveDrivers(serializeDrivers());
      refreshPreview();
    });
    applyDateEl?.addEventListener('change', refreshPreview);

    // APPLY CAPACITY: enumerate exact driver windows (most precise)
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

    // Schedule Calendar hooks
    const schedTitleOK = (schedEls.title && schedEls.days);
    if (schedEls.prev) schedEls.prev.addEventListener('click', async () => {
      const d = schedCtx.month; schedCtx.month = new Date(d.getFullYear(), d.getMonth()-1, 1);
      await loadSchedMonth();
    });
    if (schedEls.next) schedEls.next.addEventListener('click', async () => {
      const d = schedCtx.month; schedCtx.month = new Date(d.getFullYear(), d.getMonth()+1, 1);
      await loadSchedMonth();
    });

    if (schedTitleOK) { loadSchedMonth().then(()=> { showDay(today).catch(()=>{}); }); }
  })();
})();
