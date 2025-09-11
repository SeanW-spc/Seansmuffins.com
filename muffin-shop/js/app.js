/* Sean’s Muffins — app.js (FULL FILE, cleaned) */

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

/* ============ A11y live + toasts ============ */
const $live   = $('#a11y-live');
const $toasts = $('#toast');

function announce(msg){
  try{
    if ($live){
      $live.textContent = '';
      setTimeout(()=>{ $live.textContent = msg; }, 10);
    }
  }catch{}
}

function toast(msg){
  if (!$toasts){ alert(msg); return; }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(()=> el.remove(), 2600);
}

/* ============ Cart (cross-tab safe) ============ */
const CLIENT_ID   = Math.random().toString(36).slice(2);
const CART_KEY    = 'sm_cart_v1';
const PENDING_KEY = 'sm_last_order'; // for thank-you summary

const $cartBtn       = $('#cart-button');
const $cartDrawer    = $('#cart-drawer');
const $cartBackdrop  = $('#cart-backdrop');
const $cartClose     = $('#cart-close');
const $cartItems     = $('#cart-items');
const $cartCount     = $('#cart-count');
const $cartItemCount = $('#cart-item-count');
const $cartClear     = $('#cart-clear');
const $cartCheckout  = $('#cart-checkout');

const $date  = $('#delivery-date');
const $time  = $('#delivery-time');
const $notes = $('#order-notes'); // optional textarea if present

const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sm_cart') : null;
let cart = [];

/* Delivery windows (keep in sync with backend) */
function getWindows(){ return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM']; }

/* Local storage */
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
  updateCartUI();
}
function cartItemsTotal(){
  return cart.reduce((n,i)=> n + (parseInt(i.quantity||0,10) || 0), 0);
}

/* Pending order (for thank-you) */
function savePendingOrder(payload){
  try{ localStorage.setItem(PENDING_KEY, JSON.stringify(payload)); }catch{}
}
function readPendingOrder(){
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearPendingOrder(){ try{ localStorage.removeItem(PENDING_KEY); }catch{} }

/* Cart UI */
function renderCart(noSave){
  if ($cartItems){
    $cartItems.innerHTML = '';
    if (!cart.length){
      $cartItems.innerHTML = `<div class="empty">Your cart is empty</div>`;
    } else {
      cart.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = 'cart-item';
        div.innerHTML = `
          <div class="ci-main">
            <div class="ci-name">${escapeHtml(item.name || 'Item')}</div>
            <div class="ci-meta">Qty: ${item.quantity || 1}</div>
          </div>
          <div class="ci-actions">
            <button data-act="dec" type="button" aria-label="Decrease">−</button>
            <button data-act="inc" type="button" aria-label="Increase">+</button>
            <button data-act="remove" type="button" aria-label="Remove" title="Remove" style="margin-left:6px;border-color:#ffd3db">✕</button>
          </div>
        `;
        on(div.querySelector('[data-act="dec"]'), 'click', ()=>{ item.quantity = Math.max(1, (item.quantity||1)-1); updateCartUI(); });
        on(div.querySelector('[data-act="inc"]'), 'click', ()=>{ item.quantity = (item.quantity||0)+1; updateCartUI(); });
        on(div.querySelector('[data-act="remove"]'), 'click', ()=>{ cart.splice(idx,1); updateCartUI(); });
        $cartItems.appendChild(div);
      });
    }
    if ($cartItemCount) { $cartItemCount.textContent = String(cartItemsTotal()); }
  }
  if (!noSave) { saveCart(); }
}
function updateCartUI(){ renderCart(false); updateCartBadge(); }
function updateCartBadge(){ if ($cartCount) { $cartCount.textContent = String(cartItemsTotal()); } }

/* Cross-tab sync */
if (bc){
  bc.onmessage = (ev) => {
    const d = ev && ev.data;
    if (!d || d.from === CLIENT_ID) return;
    if (d.type === 'cart'){
      cart = Array.isArray(d.cart) ? d.cart : [];
      renderCart(true); // noSave
      updateCartUI();
    }
  };
}
window.addEventListener('storage', (e) => {
  if (e.key === CART_KEY){
    try { cart = JSON.parse(e.newValue || '[]'); } catch { cart = []; }
    renderCart(true);
    updateCartUI();
  }
});

/* Drawer open/close */
function openCart(){ if ($cartDrawer) $cartDrawer.classList.add('open'); if ($cartBackdrop) $cartBackdrop.classList.add('open'); document.body.style.overflow='hidden'; }
function closeCart(){ if ($cartDrawer) $cartDrawer.classList.remove('open'); if ($cartBackdrop) $cartBackdrop.classList.remove('open'); document.body.style.overflow=''; }
on($cartBtn,'click',openCart);
on($cartClose,'click',closeCart);
on($cartBackdrop,'click',closeCart);
on($cartClear,'click',()=>{ cart=[]; updateCartUI(); toast('Cart cleared'); announce('Cart cleared'); });

/* ============ Availability helper (on 409) ============ */
function pickNewWindowModal({ suggestions=[], current='' }){
  return new Promise(resolve=>{
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.48);padding:16px;';
    el.innerHTML = `
      <div style="max-width:480px;width:100%;background:#fff;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.2);overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
        <div style="padding:16px 20px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-size:18px;">That window is full</h3>
          <button type="button" data-x style="font-size:20px;background:#fff;border:none;cursor:pointer;">✕</button>
        </div>
        <div style="padding:16px 20px;">
          <p style="margin:0 0 10px;color:#444">Try one of these:</p>
          <div style="display:flex;flex-wrap:wrap;gap:8px;" id="slots"></div>
          <p style="margin:12px 0 0;font-size:12px;color:#6a6f76;">Current choice: <strong>${current || '—'}</strong></p>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    const $slots = el.querySelector('#slots');
    const list = suggestions.length ? suggestions : getWindows().filter(w => w !== current);
    list.forEach(w=>{
      const b = document.createElement('button');
      b.type='button'; b.textContent = w;
      b.style.cssText = 'padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#fafafa;cursor:pointer';
      b.addEventListener('click', ()=>{ el.remove(); resolve(w); });
      $slots.appendChild(b);
    });
    el.querySelector('[data-x]').addEventListener('click', ()=>{ el.remove(); resolve(null); });
  });
}

/* ============ BUY-NOW Delivery popup (date/time/notes) ============ */
let deliveryModalEl = null;
function buildDeliveryModal(){
  const el = document.createElement('div');
  el.id = 'delivery-modal';
  el.setAttribute('role','dialog');
  el.setAttribute('aria-modal','true');
  el.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.48);padding:16px;';
  el.innerHTML = `
    <div style="max-width:520px;width:100%;background:#fff;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.2);overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
      <div style="padding:16px 20px;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:space-between;">
        <h3 style="margin:0;font-size:18px;">Delivery details</h3>
        <button type="button" data-close style="font-size:20px;background:#fff;border:none;cursor:pointer;">✕</button>
      </div>
      <div style="padding:16px 20px;">
        <div class="row" style="display:flex;gap:12px;flex-wrap:wrap;">
          <div style="flex:1;min-width:160px;">
            <label for="bn-date">Date</label>
            <input type="date" id="bn-date" required>
          </div>
          <div style="flex:1;min-width:160px;">
            <label for="bn-time">Preferred time</label>
            <select id="bn-time" required>
              <option value="">Select a window…</option>
              ${getWindows().map(w => `<option>${w}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="margin-top:12px;">
          <label for="bn-notes">Notes (optional)</label>
          <textarea id="bn-notes" rows="3" placeholder="Delivery notes / allergies (optional)"></textarea>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
          <button type="button" data-cancel class="btn btn-ghost">Cancel</button>
          <button type="button" data-continue class="btn btn-primary">Continue</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  // default date = today
  const input = el.querySelector('#bn-date');
  const d = new Date(), yyyy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  input.min = `${yyyy}-${mm}-${dd}`;
  input.value = `${yyyy}-${mm}-${dd}`;

  // Prefill notes from cart if present
  const notesEl = el.querySelector('#bn-notes');
  if ($notes && $notes.value) { notesEl.value = $notes.value; }

  // Close handlers
  el.querySelector('[data-close]').addEventListener('click', closeDeliveryModal);
  el.querySelector('[data-cancel]').addEventListener('click', closeDeliveryModal);

  deliveryModalEl = el;
}
function closeDeliveryModal(){ if (!deliveryModalEl) return; deliveryModalEl.remove(); deliveryModalEl=null; }

function promptDeliveryDetails(){
  if (!deliveryModalEl) buildDeliveryModal();
  return new Promise(resolve=>{
    const el = deliveryModalEl;
    const dateInput = el.querySelector('#bn-date');
    const timeSel   = el.querySelector('#bn-time');
    const notesEl   = el.querySelector('#bn-notes');
    if ($notes && $notes.value) { notesEl.value = $notes.value; }

    el.querySelector('[data-continue]').addEventListener('click', ()=>{
      const d = dateInput.value;
      const t = timeSel.value;
      const n = (notesEl.value || '').slice(0,500);
      if (!d){ alert('Choose a delivery date.'); dateInput.focus(); return; }
      if (!t){ alert('Choose a time window.'); timeSel.focus(); return; }

      if ($date) $date.value = d;
      if ($time){
        $time.value = t;
        if ($time.value !== t){
          const opt=document.createElement('option'); opt.value=t; opt.textContent=t;
          $time.appendChild(opt); $time.value=t;
        }
      }
      if ($notes) $notes.value = n;

      closeDeliveryModal();
      resolve({ date: d, time: t, notes: n });
    }, { once:true });
  });
}

/* ============ PRODUCT BUTTONS ============ */
function initProductButtons(){
  // Defensive: prevent implicit submits
  $$('[data-add], [data-buy-now]').forEach(btn=>{ if (!btn.hasAttribute('type')) btn.setAttribute('type','button'); });

  // Add-to-cart
  $$('[data-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const price = btn.getAttribute('data-price');
      const name  = btn.getAttribute('data-name') || 'Item';
      if (!price){ toast('Missing price for this item.'); return; }
      const existing = cart.find(i => i.price === price);
      if (existing) existing.quantity = (existing.quantity||0) + 1;
      else cart.push({ price, name, quantity: 1 });
      saveCart();
      toast('Added to cart');
      announce('Cart updated');
    });
  });

  // Buy-now (single item checkout) — supports one-time and subscription
  $$('[data-buy-now]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const price = btn.getAttribute('data-price');
      const name  = btn.getAttribute('data-name') || 'Item';
      const qty   = Number(btn.getAttribute('data-qty') || '1');
      const mode  = (btn.getAttribute('data-mode') || 'payment').toLowerCase(); // 'payment' | 'subscription'
      if (!price){ toast('Missing price for this item.'); return; }

      // Ensure we have date/time/notes
      let deliveryDate = $date ? $date.value : '';
      let timeWindow   = $time ? $time.value : '';
      let notes        = $notes ? ($notes.value || '') : '';
      if (!deliveryDate || !timeWindow){
        const picked = await promptDeliveryDetails();
        if (!picked) return;
        deliveryDate = picked.date; timeWindow = picked.time; notes = picked.notes || notes || '';
      }

      // Save a pending order summary for the thank-you page
      savePendingOrder({
        ts: Date.now(),
        source: 'buy_now',
        items: [{ name, quantity: qty }],
        deliveryDate, timeWindow, notes
      });

      // Start checkout
      await startCheckout({
        mode,
        items: [{ price, quantity: qty, name }],
        deliveryDate,
        timeWindow,
        orderNotes: notes
      }, { retryOnFull: true });
    });
  });
}

/* ============ CHECKOUT (cart drawer) ============ */
function disableCheckout(disabled){
  if ($cartCheckout){
    $cartCheckout.disabled = !!disabled;
    $cartCheckout.textContent = disabled ? 'Processing…' : 'Checkout';
  }
}

async function handleCartCheckout(){
  if (!cart.length){ toast('Your cart is empty.'); return; }
  const deliveryDate = $date ? $date.value : '';
  const timeWindow   = $time ? $time.value : '';
  const notes        = $notes ? ($notes.value || '') : '';

  if (!deliveryDate){ toast('Choose a delivery date first.'); if ($date) $date.focus(); return; }
  if (!timeWindow){ toast('Choose a time window first.'); if ($time) $time.focus(); return; }

  // Save a pending order summary for the thank-you page
  savePendingOrder({
    ts: Date.now(),
    source: 'cart',
    items: cart.map(i => ({ name:i.name, quantity:i.quantity })),
    deliveryDate, timeWindow, notes
  });

  try{
    disableCheckout(true);
    await startCheckout({
      mode: 'payment',
      items: cart.map(i => ({ price: i.price, quantity: i.quantity, name: i.name })),
      deliveryDate, timeWindow,
      orderNotes: notes
    }, { retryOnFull: true });
  } finally {
    disableCheckout(false);
  }
}
on($cartCheckout,'click', handleCartCheckout);

/* Core checkout starter with availability handling */
async function startCheckout(payload, { retryOnFull } = { retryOnFull: true }){
  try{
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    let data = {};
    try { data = await res.json(); } catch {}

    if (!res.ok){
      if (retryOnFull && res.status === 409 && data?.error === 'window_full'){
        const pick = await pickNewWindowModal({ suggestions: data.suggestions || [], current: payload.timeWindow });
        if (pick){
          if ($time){
            $time.value = pick;
            if ($time.value !== pick){
              const opt=document.createElement('option'); opt.value=pick; opt.textContent=pick; $time.appendChild(opt); $time.value=pick;
            }
          }
          savePendingOrder({ ...(readPendingOrder()||{}), timeWindow: pick });
          return await startCheckout({ ...payload, timeWindow: pick }, { retryOnFull: false });
        }
        return;
      }
      const msg = data?.message || data?.error || `Checkout failed (${res.status}).`;
      console.error('Checkout failed', res.status, data);
      toast(msg);
      return;
    }

    if (data?.url){ window.location.href = data.url; }
    else toast('Could not start checkout. Please try again.');
  } catch(err){
    console.error(err);
    toast('Checkout failed (network).');
  }
}

/* ============ DATE/TIME defaults ============ */
(function initDateTime(){
  if ($date){
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm   = String(today.getMonth()+1).padStart(2,'0');
    const dd   = String(today.getDate()).padStart(2,'0');
    $date.min = `${yyyy}-${mm}-${dd}`;
    if (!$date.value) $date.value = `${yyyy}-${mm}-${dd}`;
  }
  if ($time && !$time.children.length){
    getWindows().forEach(w=>{
      const opt=document.createElement('option');
      opt.value = w; opt.textContent = w;
      $time.appendChild(opt);
    });
  }
})();

/* ============ THANK-YOU PAGE SUMMARY ============ */
function qs(key){ const u=new URL(window.location.href); return u.searchParams.get(key); }
function escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[m]);
}

function renderThankYou(){
  const isThanks = /thank-you(\.html)?$/i.test(location.pathname) || !!$('#order-summary');
  if (!isThanks) return;

  const sessionId = qs('session_id') || '';
  const data = readPendingOrder();

  const host = $('#order-summary') || (function(){
    const wrap = document.createElement('section');
    wrap.id = 'order-summary';
    wrap.style.margin = '20px auto';
    wrap.style.maxWidth = '720px';
    wrap.style.padding = '16px';
    wrap.style.border = '1px solid #ece8e2';
    wrap.style.borderRadius = '12px';
    wrap.style.background = '#fff';
    document.body.appendChild(wrap);
    return wrap;
  })();
  host.innerHTML = '';

  const h = document.createElement('h2'); h.textContent = 'Order summary'; h.style.marginTop = '0'; host.appendChild(h);

  if (data){
    const meta = document.createElement('div');
    meta.innerHTML = `
      <p style="margin:.2rem 0;"><strong>Delivery date:</strong> ${data.deliveryDate || '—'}</p>
      <p style="margin:.2rem 0;"><strong>Time window:</strong> ${data.timeWindow || '—'}</p>
      ${data.notes ? `<p style="margin:.2rem 0;"><strong>Notes:</strong> ${escapeHtml(data.notes)}</p>` : ''}
    `;
    host.appendChild(meta);

    const itemsTitle = document.createElement('p'); itemsTitle.innerHTML = '<strong>Items:</strong>'; host.appendChild(itemsTitle);
    const ul = document.createElement('ul'); ul.style.marginTop = '6px';
    (data.items || []).forEach(it=>{
      const li = document.createElement('li'); li.textContent = `${it.name} ×${it.quantity}`; ul.appendChild(li);
    });
    host.appendChild(ul);

    const small = document.createElement('p');
    small.style.color = '#6a6f76'; small.style.fontSize = '12px'; small.style.marginTop = '10px';
    small.textContent = 'A receipt has been emailed to you via Stripe.';
    host.appendChild(small);
  } else {
    const p = document.createElement('p');
    p.textContent = 'Thanks for your order! Your payment was processed.';
    host.appendChild(p);
  }

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
const $voteMsg  = $('#vote-msg');
if ($voteForm){
  $voteForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if ($voteMsg) $voteMsg.textContent = 'Sending…';
    try{
      const fd = new FormData($voteForm);
      const r = await fetch('/api/vote-flavor', { method:'POST', body: fd });
      const j = await r.json().catch(()=> ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || 'Failed');
      if ($voteMsg) $voteMsg.textContent = 'Thanks for your vote!';
      $voteForm.reset();
    }catch{
      toast('Network error.');
      if ($voteMsg) $voteMsg.textContent = '';
    }
  });
}

const $merchForm = $('#merch-form');
const $merchMsg  = $('#merch-msg');
if ($merchForm){
  $merchForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if ($merchMsg) $merchMsg.textContent = 'Saving…';
    try{
      const fd = new FormData($merchForm);
      const r = await fetch('/api/notify-merch', { method:'POST', body: fd });
      const j = await r.json().catch(()=> ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || 'Failed');
      if ($merchMsg) $merchMsg.textContent = 'You’re on the list!';
      $merchForm.reset();
    }catch{
      toast('Network error.');
      if ($merchMsg) $merchMsg.textContent = '';
    }
  });
}

/* ============ Fun: Muffin Tapper (floating button) ============ */
(function initMuffinTapper(){
  const btn = $('#muffin-tapper');
  if (!btn) return;

  btn.style.position = 'fixed';
  btn.style.right = '16px';
  btn.style.bottom = '16px';
  btn.style.zIndex = 9999;

  let count = 0;
  on(btn, 'click', ()=>{
    count++;
    btn.textContent = `🧁 ${count}`;
    announce(`You tapped the muffin ${count} times`);
  });
})();

/* ============ Mobile nav toggle ============ */
(function initNav(){
  const navToggle = $('.nav-toggle');
  if (!navToggle) return;
  on(navToggle, 'click', ()=>{
    const nav = $('#primary-nav');
    const expanded = navToggle.getAttribute('aria-expanded') === 'true';
    navToggle.setAttribute('aria-expanded', String(!expanded));
    if (nav) nav.classList.toggle('open', !expanded);
  });
})();

/* ============ Init ============ */
(function init(){
  loadCart();
  renderCart(true);     // noSave
  initProductButtons();
  renderThankYou();
})();
