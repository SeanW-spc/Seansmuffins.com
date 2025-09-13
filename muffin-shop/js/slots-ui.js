// muffin-shop/js/slots-ui.js
(() => {
  // --- tiny utils
  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const toastHost = $('#toast');
  let toastTimer = null;
  function toast(msg, ms=2200){
    if (!toastHost) { alert(msg); return; }
    toastHost.textContent = msg;
    toastHost.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{ toastHost.classList.remove('show'); toastHost.textContent=''; }, ms);
  }
  const normDash = s => String(s||'').replace(/–|—/g,'-').trim();
  const fmtDateInput = (d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const addDays = (d,n)=>{ const x=new Date(d); x.setDate(x.getDate()+n); x.setHours(0,0,0,0); return x; };

  // --- elements
  const $date = $('#delivery-date');
  const $time = $('#delivery-time');

  // Inject "Check availability" button if not present
  let $check = $('#check-availability');
  if (!$check && $date) {
    $check = document.createElement('button');
    $check.id = 'check-availability';
    $check.type = 'button';
    $check.className = 'btn btn-ghost';
    $check.style.marginTop = '8px';
    $check.textContent = 'Check availability';
    // place right under the date input
    const dateWrap = $date.closest('.row > div') || $date.parentElement;
    (dateWrap?.parentElement || $date.parentElement).appendChild($check);
  }

  // Prepare select options: keep a stable base label
  function setupTimeOptions(){
    if (!$time) return;
    Array.from($time.options).forEach(opt => {
      const label = (opt.textContent || '').trim();
      if (!opt.dataset.base) opt.dataset.base = label;
      if (!opt.hasAttribute('value') && label && opt.value === '') {
        opt.value = label;
      }
    });
  }

  // Disable select until user checks
  function disableTimeSelect(resetLabel=true){
    if (!$time) return;
    $time.disabled = true;
    $time.value = '';
    if (resetLabel) {
      Array.from($time.options).forEach(op => {
        if (!op.dataset.base) return;
        op.textContent = op.dataset.base;
        if (op.value) op.disabled = true; // keep disabled until check
      });
    }
  }

  // Cart qty (read from localStorage to avoid coupling with app.js internals)
  const CART_KEY = 'sm_cart_v1';
  function requestedQty(){
    try {
      const raw = localStorage.getItem(CART_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return (Array.isArray(arr) ? arr : []).reduce((s,i)=> s + (parseInt(i?.quantity||0,10) || 0), 0) || 1;
    } catch { return 1; }
  }

  // Availability fetch + normalize (object or array shapes)
  async function fetchAvailability(date){
    const r = await fetch(`/api/slot-availability?date=${encodeURIComponent(date)}`, { cache:'no-store' });
    if (!r.ok) throw new Error('avail_fetch');
    return await r.json();
  }
  function normalizeAvailability(data){
    const map = new Map();
    if (!data) return map;
    if (Array.isArray(data.windows)) {
      for (const w of data.windows){
        const label = w.window || w.label || w.name;
        const avail = Number(w.available ?? (Number(w.capacity||0) - Number(w.current||0)));
        if (label) map.set(normDash(label), Math.max(0, isNaN(avail)?0:avail));
      }
    } else if (data.windows && typeof data.windows === 'object') {
      for (const [label, v] of Object.entries(data.windows)){
        const raw = (v && (v.available ?? (v.capacity - v.current)));
        const avail = Number.isFinite(raw) ? Number(raw) : 0;
        map.set(normDash(label), Math.max(0, avail));
      }
    }
    return map;
  }

  // Apply availability into dropdown labels (inside the options)
  function paintOptions(map, need){
    if (!$time) return;
    Array.from($time.options).forEach(op => {
      const base = (op.dataset.base || op.value || op.textContent).trim();
      if (!op.value) { op.textContent = base; return; }
      const key = normDash(base);
      const avail = map.has(key) ? map.get(key) : null;
      if (avail == null) {
        op.disabled = true;
        op.textContent = `${base} — N/A`;
      } else if (avail < need) {
        op.disabled = true;
        op.textContent = `${base} — Full`;
      } else {
        op.disabled = false;
        op.textContent = `${base} — ${avail} left`;
      }
    });
  }

  // 14-day guard: set max attribute and enforce on click
  function enforceDateBounds(){
    if (!$date) return;
    const max = fmtDateInput(addDays(new Date(), 14));
    $date.max = max;
    // keep whatever min your app.js already sets
    if ($date.value && $date.value > max) $date.value = max;
  }

  async function runCheck(){
    if (!$date || !$time) return;
    const date = $date.value;
    if (!date){ toast('Please choose a delivery date'); return; }

    // 14-day check
    const maxIso = $date.max || fmtDateInput(addDays(new Date(), 14));
    if (date > maxIso) { toast('Please choose a date within the next 14 days'); return; }

    // fetch & paint
    try{
      const need = requestedQty();
      const data = await fetchAvailability(date);
      const map = normalizeAvailability(data);

      // Any window with enough room?
      const ok = Array.from(map.values()).some(v => (v||0) >= need);
      if (!ok){
        disableTimeSelect(true);
        toast('No slots available for that date');
        return;
      }

      // Show availability *inside* the dropdown and enable it
      paintOptions(map, need);
      $time.disabled = false;
      $time.focus();
    } catch {
      disableTimeSelect(true);
      toast('Could not check availability. Please try again.');
    }
  }

  // Wire up
  (function init(){
    if (!$date || !$time) return;

    setupTimeOptions();
    enforceDateBounds();
    disableTimeSelect(true); // locked until user clicks Check

    // When the date changes, require a new check
    on($date, 'change', () => disableTimeSelect(true));

    // Check button
    on($check, 'click', runCheck);

    // Prevent selecting a time before checking
    on($time, 'focus', () => { if ($time.disabled) toast('Pick a date and click “Check availability”'); });
  })();
})();
