/* Sean’s Muffins — app.js (FULL FILE, mobile nav fix, subs disabled, cart + checkout) */

/* ============ Tiny helpers ============ */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);

/* Footer year */
const y = $('#y'); if (y) y.textContent = new Date().getFullYear();

/* Smooth scroll for in-page anchors */
$$('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

/* ============ Mobile nav (“waffle”) ============ */
(function mobileNav(){
  const navToggle = $('.nav-toggle');
  const nav = $('#primary-nav');

  function closeNav(){
    if (!navToggle || !nav) return;
    navToggle.setAttribute('aria-expanded', 'false');
    nav.classList.remove('open');
  }
  function openNav(){
    if (!navToggle || !nav) return;
    navToggle.setAttribute('aria-expanded', 'true');
    nav.classList.add('open');
  }

  on(navToggle, 'click', () => {
    const expanded = navToggle.getAttribute('aria-expanded') === 'true';
    if (expanded) closeNav(); else openNav();
  });

  // Close when a link is clicked (common mobile pattern)
  on(nav, 'click', (e) => {
    const t = e.target;
    if (t && t.tagName === 'A') closeNav();
  });

  // Escape closes
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape') closeNav();
  });

  // Click outside (only on small screens)
  on(document, 'click', (e) => {
    if (!navToggle || !nav) return;
    const expanded = navToggle.getAttribute('aria-expanded') === 'true';
    if (!expanded) return;
    const within = nav.contains(e.target) || navToggle.contains(e.target);
    if (!within) closeNav();
  });
})();

/* ============ Toasts + a11y live ============ */
const a11yLive = $('#a11y-live');
const toastHost = $('#toast');
let toastTimer = null;
function say(msg){
  if (a11yLive){ a11yLive.textContent = ''; setTimeout(()=> a11yLive.textContent = msg, 10); }
}
function toast(msg, ms=2200){
  say(msg);
  if (!toastHost) return;
  toastHost.textContent = msg;
  toastHost.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{
    toastHost.classList.remove('show');
    toastHost.textContent = '';
  }, ms);
}

/* ============ Cart state ============ */
const CART_KEY = 'sm_cart_v1';
let cart = [];

const CLIENT_ID = Math.random().toString(36).slice(2);
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sm_cart') : null;
if (bc){
  bc.onmessage = (ev) => {
    try {
      if (!ev?.data || ev.data.from === CLIENT_ID) return;
      if (ev.data.type === 'cart'){
        cart = ev.data.cart || [];
        renderCart();
        updateCartBadge();
      }
    } catch {}
  };
}

function loadCart(){
  try {
    const raw = localStorage.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cart = Array.isArray(parsed) ? parsed : [];
  } catch { cart = []; }
}
function saveCart(){
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    if (bc) bc.postMessage({ type:'cart', from:CLIENT_ID, cart: cart.map(i => ({...i})) });
  } catch {}
}
function cartItemsTotal(){
  return cart.reduce((n,i)=> n + (parseInt(i.quantity||0,10) || 0), 0);
}

/* Pending order (for thank-you) */
const PENDING_KEY = 'sm_pending_order';
function rememberPendingOrder(payload){
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(payload || {})); } catch {}
}
function readPendingOrder(){
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearPendingOrder(){ try{ localStorage.removeItem(PENDING_KEY); }catch{} }

/* ============ Cart UI (DOM) ============ */
const $cartOpen   = $('#cart-button');
const $cartClose  = $('#cart-close');
const $cartDrawer = $('#cart-drawer');
const $cartBackdrop = $('#cart-backdrop');
const $cartItems  = $('#cart-items');
const $cartBadge  = $('#cart-count');
const $itemCount  = $('#cart-item-count');
const $cartClear  = $('#cart-clear');
const $cartCheckout = $('#cart-checkout');
const $deliveryDate = $('#delivery-date');
const $deliveryTime = $('#delivery-time');
const $orderNotes = $('#order-notes');

/* ---- Delivery date default + slot availability ---- */
function fmtDateInput(d){
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate()+n); x.setHours(0,0,0,0); return x; }
function computeDefaultDeliveryDate(now=new Date()){
  const cutoffH = 20, cutoffM = 30; // 8:30 PM
  const afterCutoff = (now.getHours()>cutoffH) || (now.getHours()===cutoffH && now.getMinutes()>=cutoffM);
  return addDays(now, afterCutoff ? 2 : 1);
}
async function fetchAvailability(date){
  const r = await fetch(`/api/slot-availability?date=${encodeURIComponent(date)}`);
  if (!r.ok) throw new Error('avail_fetch');
  return await r.json();
}
function normalizeAvailability(data){
  const map = new Map();
  if (!data) return map;
  // Supports { windows: { "6:00–7:00 AM": {capacity,current,available}, ... } } OR array
  if (Array.isArray(data.windows)){
    for (const w of data.windows){
      const label = w.window || w.label || w.name;
      const avail = Number(w.available ?? (Number(w.capacity||0) - Number(w.current||0)));
      if (label) map.set(label, Math.max(0, isNaN(avail) ? 0 : avail));
    }
  } else if (data.windows && typeof data.windows === 'object'){
    for (const [label, v] of Object.entries(data.windows)){
      const raw = (v && (v.available ?? (v.capacity - v.current)));
      const avail = Number.isFinite(raw) ? Number(raw) : 0;
      map.set(label, Math.max(0, avail));
    }
  }
  return map;
}
function requestedQty(){
  return cart.reduce((s,i)=> s + (parseInt(i.quantity||0,10) || 0), 0) || 1;
}

/* NEW: keep stable values for <option> and remember original labels */
function setupTimeOptions(){
  if (!$deliveryTime) return;
  Array.from($deliveryTime.options).forEach(opt => {
    const label = (opt.textContent || '').trim();
    if (!opt.dataset.base) opt.dataset.base = label;          // remember original label
    if (!opt.hasAttribute('value') && label && opt.value === '') {
      // only set if the option had no explicit value; skip placeholder with value=""
      opt.value = label;
    }
  });
}

async function refreshAvailability(){
  if (!$deliveryTime || !$deliveryDate) return;
  const date = $deliveryDate.value;
  if (!date) return;
  try{
    const data = await fetchAvailability(date);
    const map = normalizeAvailability(data);
    const need = requestedQty();

    Array.from($deliveryTime.options).forEach(opt => {
      if (!opt.value) return; // skip placeholder
      const base = (opt.dataset.base || opt.value || opt.textContent).trim(); // <-- stable base
      const avail = map.has(base) ? map.get(base) : null;
      if (avail != null){
        const isFullForUs = avail < need;
        opt.disabled = isFullForUs;
        opt.textContent = isFullForUs ? `${base} — Full` : `${base}${avail>=0 ? ` — ${avail} left` : ''}`;
      } else {
        opt.disabled = false; // unknown window -> assume ok
        opt.textContent = base;
      }
    });
    // If current selection is disabled, clear it
    const sel = $deliveryTime.selectedOptions[0];
    if (sel && sel.disabled) $deliveryTime.value = '';
  } catch(e){
    // Availability fetch failed; leave options as-is
  }
}

function updateCartBadge(){
  const total = cartItemsTotal();
  if ($cartBadge) $cartBadge.textContent = String(total);
  if ($itemCount) $itemCount.textContent = String(total);
}
function openCart(){
  if (!$cartDrawer) return;
  $cartDrawer.setAttribute('aria-hidden','false');
  $cartDrawer.classList.add('open');
  if ($cartBackdrop) $cartBackdrop.classList.add('show');
  // Lock page scroll while drawer is open (prevents background overlap/jank on mobile)
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  // Ensure options reflect current capacity when user opens the cart
  setupTimeOptions();
  refreshAvailability();
}
function closeCart(){
  if (!$cartDrawer) return;
  $cartDrawer.setAttribute('aria-hidden','true');
  $cartDrawer.classList.remove('open');
  if ($cartBackdrop) $cartBackdrop.classList.remove('show');
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
}
on($cartOpen, 'click', (e)=>{ e.preventDefault(); openCart(); });
on($cartClose,'click', (e)=>{ e.preventDefault(); closeCart(); });
on($cartBackdrop,'click', ()=> closeCart());
on(document, 'keydown', (e)=> { if (e.key === 'Escape') closeCart(); });

function renderCart(){
  if ($cartItems){
    $cartItems.innerHTML = '';
    if (!cart.length){
      $cartItems.innerHTML = `<div class="empty">Your cart is empty</div>`;
    } else {
      cart.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = 'cart-item';
        // Hide the Stripe price ID in the UI (only show item name + qty controls)
        div.innerHTML = `
          <div class="ci-info">
            <div class="ci-name">${item.name || 'Item'}</div>
          </div>
          <div class="ci-qty">
            <button class="qty dec" aria-label="Decrease">−</button>
            <input class="qty-input" inputmode="numeric" pattern="[0-9]*" value="${item.quantity||1}" />
            <button class="qty inc" aria-label="Increase">+</button>
            <button class="qty remove" aria-label="Remove">✕</button>
          </div>`;

        const $dec = $('.dec', div);
        const $inc = $('.inc', div);
        const $inp = $('.qty-input', div);
        const $rem = $('.remove', div);

        on($dec, 'click', () => {
          const q = Math.max(0, (parseInt(cart[idx].quantity||0,10) || 0) - 1);
          cart[idx].quantity = q;
          if (q === 0){ cart.splice(idx,1); }
          saveCart(); renderCart(); updateCartBadge();
        });
        on($inc, 'click', () => {
          cart[idx].quantity = (parseInt(cart[idx].quantity||0,10) || 0) + 1;
          saveCart(); renderCart(); updateCartBadge();
        });
        on($inp, 'change', () => {
          let v = parseInt($inp.value||'0',10);
          if (!Number.isFinite(v) || v < 0) v = 0;
          cart[idx].quantity = v;
          if (v === 0){ cart.splice(idx,1); }
          saveCart(); renderCart(); updateCartBadge();
        });
        on($rem, 'click', () => {
          cart.splice(idx, 1);
          saveCart(); renderCart(); updateCartBadge();
        });

        $cartItems.appendChild(div);
      });
    }
  }
  updateCartBadge();
  // Re-evaluate which windows are selectable based on current cart qty
  refreshAvailability();
}
on($cartClear, 'click', () => {
  cart = [];
  saveCart(); renderCart(); updateCartBadge();
  toast('Cart cleared');
});

/* ============ Product buttons ============ */
/* Touch+click helper that avoids “ghost click” double-fires on mobile */
let _lastTouchTs = 0;
window.addEventListener('touchend', () => { _lastTouchTs = Date.now(); }, true);
function onTap(el, handler){
  if (!el) return;
  el.addEventListener('touchend', (e) => {
    _lastTouchTs = Date.now();
    handler(e);
  }, { passive: true });
  el.addEventListener('click', (e) => {
    if (Date.now() - _lastTouchTs < 500) { e.preventDefault(); return; } // ignore ghost-click
    handler(e);
  });
}

function initProductButtons(){
  // Add-to-cart
  $$('[data-add]').forEach(btn => {
    onTap(btn, () => {
      const price = btn.getAttribute('data-price');
      const name  = btn.getAttribute('data-name') || 'Muffin Box';
      const qty   = parseInt(btn.getAttribute('data-qty')||'1',10) || 1;
      if (!price){ toast('Missing price id'); return; }

      const idx = cart.findIndex(i => i.price === price);
      if (idx >= 0){
        cart[idx].quantity = (parseInt(cart[idx].quantity||0,10) || 0) + qty;
      } else {
        cart.push({ price, name, quantity: qty });
      }
      saveCart(); renderCart(); updateCartBadge(); openCart();
      toast(`Added ${qty} × ${name}`);
    });
  });

  // Buy-now (route through cart for date/window)
  $$('[data-buy-now]').forEach(btn => {
    onTap(btn, () => {
      const price = btn.getAttribute('data-price');
      const name  = btn.getAttribute('data-name') || 'Muffin Box';
      const qty   = parseInt(btn.getAttribute('data-qty')||'1',10) || 1;
      const mode  = (btn.getAttribute('data-mode') || 'payment').toLowerCase();
      if (mode === 'subscription'){
        toast('Subscriptions are coming soon.');
        return;
      }
      if (!price){ toast('Missing price id'); return; }

      const idx = cart.findIndex(i => i.price === price);
      if (idx >= 0) cart[idx].quantity = (parseInt(cart[idx].quantity||0,10) || 0) + qty;
      else cart.push({ price, name, quantity: qty });

      saveCart(); renderCart(); updateCartBadge(); openCart();
      toast(`Added ${qty} × ${name} — pick a delivery time to checkout.`);
      if ($deliveryDate) $deliveryDate.focus();
    });
  });
}

/* ============ Checkout ============ */
async function createCheckoutSession(payload){
  const resp = await fetch('/api/create-checkout-session', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok){
    let err = 'checkout_failed';
    try { const j = await resp.json(); err = j?.error || err; } catch {}
    throw new Error(err);
  }
  const data = await resp.json();
  return data; // expects { id } or { url }
}

on($cartCheckout, 'click', async () => {
  try {
    if (!cart.length){ toast('Your cart is empty'); return; }
    const date  = $deliveryDate?.value || '';
    const win   = $deliveryTime?.value || '';
    const notes = ($orderNotes?.value || '').trim();

    if (!date){ toast('Please choose a delivery date'); $deliveryDate?.focus(); return; }
    if (!win){  toast('Please choose a delivery window'); $deliveryTime?.focus(); return; }

    const payload = {
      mode: 'payment',
      items: cart.map(i => ({ price: i.price, quantity: parseInt(i.quantity||1,10) || 1 })),
      deliveryDate: date,
      timeWindow: win,
      orderNotes: notes || ''
    };

    rememberPendingOrder({ date, win, notes, items: cart.map(i => ({...i})) });

    const resp = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    if (!resp.ok){
      let errCode = 'checkout_failed';
      try { const j = await resp.json(); errCode = j?.error || errCode; } catch {}

      const map = {
        window_full: 'That delivery window is full. Please pick another window.',
        capacity_full: 'That delivery window is full. Please pick another window.',
        invalid_window: 'Please choose a delivery window.',
        invalid_date: 'Please choose a valid delivery date.',
        subscription_disabled: 'Subscriptions are coming soon.',
        method_not_allowed: 'Please refresh and try again.',
        missing_fields: 'Please refresh and try again.',
        invalid_price: 'That item is unavailable. Please refresh and try again.',
        stripe_key_mismatch: 'Payment system mode mismatch. Please try again shortly.',
        stripe_config: 'Payment system is being configured. Please try again shortly.',
        stripe_error: 'Payment processor error. Please try again.',
        slots_reservation_failed: 'Could not hold your delivery slot. Please try again in 30 seconds.'
      };

      toast(map[errCode] || 'Checkout failed. Please try again.');
      return;
    }

    const { id, url } = await resp.json();

    // Clear cart to avoid dupes on back-nav
    cart = []; saveCart(); renderCart(); updateCartBadge();

    if (url){ window.location.href = url; return; }

    if (!window.Stripe || !window.STRIPE_PUBLISHABLE_KEY){
      if (id){ window.location.href = `/thank-you.html?session_id=${encodeURIComponent(id)}`; }
      else throw new Error('missing_stripe_js');
      return;
    }
    const stripe = window.Stripe(window.STRIPE_PUBLISHABLE_KEY);
    const { error } = await stripe.redirectToCheckout({ sessionId: id });
    if (error){ throw error; }
  } catch (e){
    console.error('Checkout error', e);
    const msg = (e && e.message) ? e.message : '';
    const map = {
      subscription_disabled: 'Subscriptions are coming soon.',
      invalid_price: 'That item is unavailable. Please refresh and try again.',
      stripe_key_mismatch: 'Payment system mode mismatch. Please try again shortly.',
      stripe_config: 'Payment system is being configured. Please try again shortly.',
      stripe_error: 'Payment processor error. Please try again.'
    };
    toast(map[msg] || 'Checkout failed. Please try again.');
  }
});

/* ============ Thank-you hydration (optional) ============ */
function renderThankYou(){
  const host = $('#thank-you-summary');
  if (!host) return;
  const po = readPendingOrder();
  const url = new URL(window.location.href);
  const sessionId = url.searchParams.get('session_id');

  const dl = document.createElement('dl'); dl.className = 'ty-dl';
  if (po?.date){
    const dt = document.createElement('dt'); dt.textContent = 'Delivery';
    const dd = document.createElement('dd'); dd.textContent = `${po.date} • ${po.win}`;
    dl.appendChild(dt); dl.appendChild(dd);
  }
  if (po?.items?.length){
    const dt = document.createElement('dt'); dt.textContent = 'Items';
    const dd = document.createElement('dd');
    dd.innerHTML = po.items.map(i => `${i.name} × ${i.quantity}`).join('<br>');
    dl.appendChild(dt); dl.appendChild(dd);
  }
  if (po?.notes){
    const dt = document.createElement('dt'); dt.textContent = 'Notes';
    const dd = document.createElement('dd'); dd.textContent = po.notes;
    dl.appendChild(dt); dl.appendChild(dd);
  }
  host.appendChild(dl);

  if (sessionId){
    const dbg = document.createElement('p');
    dbg.style.cssText = 'color:#a0a4aa;font-size:11px;margin-top:12px;';
    dbg.textContent = `Session: ${sessionId}`;
    host.appendChild(dbg);
  }

  setTimeout(clearPendingOrder, 60_000);
}

/* ============ Optional forms ============ */
const $voteForm = $('#vote-form');
if ($voteForm){
  on($voteForm, 'submit', async (e) => {
    e.preventDefault();
    const fd = new FormData($voteForm);
    const flavor = (fd.get('flavor') || '').toString().trim();
    if (!flavor){ toast('Pick a flavor'); return; }
    try {
      const resp = await fetch('/api/vote-flavor', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ flavor }) });
      if (!resp.ok) throw new Error();
      toast('Thanks for voting!');
      $voteForm.reset();
    } catch {
      toast('Could not send your vote.');
    }
  });
}

/* ============ Init ============ */
(function init(){
  loadCart();
  renderCart();
  updateCartBadge();
  initProductButtons();
  renderThankYou();

  // Prefill date (next day before 8:30 PM; else day after) + min date
  if ($deliveryDate){
    const def = computeDefaultDeliveryDate();
    const defStr = fmtDateInput(def);
    if (!$deliveryDate.value) $deliveryDate.value = defStr;
    $deliveryDate.min = defStr;
    on($deliveryDate, 'change', () => { refreshAvailability(); });
  }

  // Ensure stable option values and run first availability check
  setupTimeOptions();
  refreshAvailability();

  // Muffin tapper (if present on this page)
  const $tapper = $('#muffin-tapper');
  if ($tapper){
    const $cnt = $('.mt-count', $tapper);
    let n = parseInt(($cnt?.textContent || '0'), 10) || 0;
    const tap = () => {
      n += 1;
      if ($cnt) $cnt.textContent = String(n);
      $tapper.classList.add('pop');
      setTimeout(()=> $tapper.classList.remove('pop'), 160);
    };
    $tapper.addEventListener('touchend', tap, { passive:true });
    $tapper.addEventListener('click', (e)=> {
      // ignore ghost click after touch
      if (e.detail === 0) return;
      tap();
    });
  }
})();
