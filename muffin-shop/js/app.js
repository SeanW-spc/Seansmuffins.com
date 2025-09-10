/* =========================
   Sean’s Muffins – app.js (FULL)
   ========================= */

/* Tiny helpers */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);

/* Footer year */
const y = document.getElementById('y'); if (y) y.textContent = new Date().getFullYear();

/* Smooth scroll for in-page anchors */
$$('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* A11y live + toasts */
const $live = document.getElementById('a11y-live');
const $toasts = document.getElementById('toast');
function announce(msg){ try{ if ($live){ $live.textContent=''; setTimeout(()=>{ $live.textContent=msg; },10);} }catch{} }
function toast(msg){ if(!$toasts){ alert(msg); return; }
  const el=document.createElement('div'); el.className='toast'; el.textContent=msg;
  $toasts.appendChild(el); setTimeout(()=>el.remove(),2600);
}

/* =====================
   CART (cross-tab safe)
   ===================== */
const CLIENT_ID = Math.random().toString(36).slice(2);
const CART_KEY  = 'sm_cart_v1';
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

const $date   = $('#delivery-date');
const $time   = $('#delivery-time');
const $notes  = $('#order-notes');

const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sm_cart') : null;
let cart = [];

/* Delivery windows (keep in sync with backend) */
function getWindows(){ return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM']; }

/* Local storage */
function loadCart(){ try{ const raw=localStorage.getItem(CART_KEY); const parsed=raw?JSON.parse(raw):[]; cart = Array.isArray(parsed)?parsed:[]; }catch{ cart=[]; } }
function saveCart(){ try{ localStorage.setItem(CART_KEY, JSON.stringify(cart)); if (bc) bc.postMessage({ type:'cart', from:CLIENT_ID, cart:cart.map(i=>({...i})) }); }catch{} }

/* Pending order (for thank-you) */
function savePendingOrder(payload){
  try{ localStorage.setItem(PENDING_KEY, JSON.stringify(payload)); }catch{}
}
function readPendingOrder(){ try{ const raw=localStorage.getItem(PENDING_KEY); return raw?JSON.parse(raw):null; }catch{ return null; } }
function clearPendingOrder(){ try{ localStorage.removeItem(PENDING_KEY); }catch{} }

/* Cart UI */
function cartItemsTotal(){ return cart.reduce((n,i)=> n + (parseInt(i.quantity||0,10) || 0), 0); }
function renderCart(noSave=false){
  if ($cartItems){
    $cartItems.innerHTML = '';
    if (!cart.length){
      $cartItems.innerHTML = '<p style="color:#6a6f76;margin:8px 0 16px;">Your cart is empty.</p>';
    }else{
      cart.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = 'cart-item';
        div.innerHTML = `
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-qty">
            <button data-act="dec" aria-label="Decrease" type="button">–</button>
            <span>${item.quantity}</span>
            <button data-act="inc" aria-label="Increase" type="button">+</button>
            <button data-act="remove" aria-label="Remove" title="Remove" type="button" style="margin-left:6px;border-color:#ffd3db">✕</button>
          </div>
        `;
        on(div.querySelector('[data-act="dec"]'),'click',()=>{ item.quantity = Math.max(1, (item.quantity||1)-1); updateCartUI(); });
        on(div.querySelector('[data-act="inc"]'),'click',()=>{ item.quantity = (item.quantity||0)+1; updateCartUI(); });
        on(div.querySelector('[data-act="remove"]'),'click',()=>{ cart.splice(idx,1); updateCartUI(); });
        $cartItems.appendChild(div);
      });
    }
  }
  const total = cartItemsTotal();
  if ($cartCount)     $cartCount.textContent = String(total);
  if ($cartItemCount) $cartItemCount.textContent = String(total);
  if (!noSave) saveCart();
}
function updateCartUI(){ renderCart(false); }

/* Cross-tab sync */
if (bc){
  bc.onmessage = (ev) => {
    const d = ev && ev.data;
    if (!d || d.type !== 'cart' || d.from === CLIENT_ID) return;
    if (!Array.isArray(d.cart)) return;
    cart = d.cart;
    renderCart(true);
  };
}
window.addEventListener('storage', (e) => {
  if (e.key !== CART_KEY) return;
  try{
    if (!e.newValue) return;
    const parsed = JSON.parse(e.newValue);
    if (!Array.isArray(parsed)) return;
    cart = parsed;
    renderCart(true);
  }catch{}
});

/* Drawer open/close */
function openCart(){ if ($cartDrawer) $cartDrawer.classList.add('open'); if ($cartBackdrop) $cartBackdrop.classList.add('open'); document.body.style.overflow='hidden'; }
function closeCart(){ if ($cartDrawer) $cartDrawer.classList.remove('open'); if ($cartBackdrop) $cartBackdrop.classList.remove('open'); document.body.style.overflow=''; }
on($cartBtn,'click',openCart);
on($cartClose,'click',closeCart);
on($cartBackdrop,'click',closeCart);
on($cartClear,'click',()=>{ cart=[]; updateCartUI(); toast('Cart cleared'); announce('Cart cleared'); });

/* =====================
   AVAILABILITY helper UI (on 409 from server)
   ===================== */
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
      b.type='button';
      b.textContent = w;
      b.style.cssText = 'padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#fafafa;cursor:pointer';
      b.addEventListener('click', ()=>{ el.remove(); resolve(w); });
      $slots.appendChild(b);
    });
    el.querySelector('[data-x]').addEventListener('click', ()=>{ el.remove(); resolve(null); });
  });
}

/* =====================
   BUY-NOW Delivery popup (date/time/notes)
   ===================== */
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
        <h3 style="margin:0;font-size:18px;">Delivery Details</h3>
        <button type="button" data-close style="border:none;background:#fff;font-size:20px;line-height:1;cursor:pointer;">✕</button>
      </div>
      <div style="padding:18px 20px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            <label for="bn-date" style="display:block;font-size:12px;color:#555;margin-bottom:6px;">Date</label>
            <input type="date" id="bn-date" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:10px;">
          </div>
          <div>
            <label for="bn-time" style="display:block;font-size:12px;color:#555;margin-bottom:6px;">Preferred time</label>
            <select id="bn-time" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:10px;">
              <option value="">Select a window…</option>
            </select>
          </div>
        </div>
        <label for="bn-notes" style="display:block;font-size:12px;color:#555;margin:12px 0 6px;">Delivery / allergy notes (optional)</label>
        <textarea id="bn-notes" rows="3" placeholder="Gate code, leave on porch, nut allergy, etc." style="width:100%;padding:10px;border:1px solid #ddd;border-radius:10px;"></textarea>
        <p style="margin:12px 0 0;font-size:12px;color:#6a6f76;">We currently deliver in Wadsworth (44281). Checkout is handled securely by Stripe.</p>
      </div>
      <div style="padding:14px 20px;border-top:1px solid #eee;display:flex;gap:10px;justify-content:flex-end;">
        <button type="button" data-cancel class="btn btn-ghost" style="padding:10px 14px;border-radius:10px;border:1px solid #ddd;background:#fff;cursor:pointer;">Cancel</button>
        <button type="button" data-continue class="btn btn-primary" style="padding:10px 14px;border-radius:10px;border:1px solid #111;background:#111;color:#fff;cursor:pointer;">Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  // Populate windows
  const sel = el.querySelector('#bn-time');
  getWindows().forEach(w=>{
    const opt = document.createElement('option');
    opt.value = w; opt.textContent = w;
    sel.appendChild(opt);
  });

  // Min + default date
  const input = el.querySelector('#bn-date');
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth()+1).padStart(2,'0');
  const dd = String(today.getDate()).padStart(2,'0');
  input.min = `${yyyy}-${mm}-${dd}`;
  input.value = `${yyyy}-${mm}-${dd}`;

  // Prefill notes from cart if present
  const notesEl = el.querySelector('#bn-notes');
  if (typeof $notes !== 'undefined' && $notes && $notes.value) { notesEl.value = $notes.value; }

  // Close handlers
  el.querySelector('[data-close]').addEventListener('click', ()=> closeDeliveryModal());
  el.querySelector('[data-cancel]').addEventListener('click', ()=> closeDeliveryModal());

  deliveryModalEl = el;
}
function closeDeliveryModal(){ if (!deliveryModalEl) return; deliveryModalEl.remove(); deliveryModalEl=null; }
function promptDeliveryDetails(){
  return new Promise(resolve=>{
    buildDeliveryModal();
    const el = deliveryModalEl;
    const dateInput = el.querySelector('#bn-date');
    const timeSel   = el.querySelector('#bn-time');
    const notesEl   = el.querySelector('#bn-notes');
    el.querySelector('[data-continue]').addEventListener('click', ()=>{
      const d = dateInput.value;
      const t = timeSel.value;
      const n = (notesEl.value || '').slice(0,500);
      if (!d){ alert('Choose a delivery date.'); dateInput.focus(); return; }
      if (!t){ alert('Choose a time window.'); timeSel.focus(); return; }

      // Sync to cart inputs if present
      if ($date) $date.value = d;
      if ($time) { $time.value = t; if ($time.value !== t){ const opt=document.createElement('option'); opt.value=t; opt.textContent=t; $time.appendChild(opt); $time.value=t; } }
      if ($notes) $notes.value = n;

      closeDeliveryModal();
      resolve({ date: d, time: t, notes: n });
    }, { once:true });
  });
}

/* =====================
   PRODUCT BUTTONS
   ===================== */
function initProductButtons(){
  // defensive: prevent implicit submits
  $$('[data-add], [data-buy-now]').forEach(btn=>{ if (!btn.hasAttribute('type')) btn.setAttribute('type','button'); });

  // add-to-cart
  $$('[data-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const price = btn.getAttribute('data-price');
      const name  = btn.getAttribute('data-name') || 'Item';
      if (!price){ alert('Missing price id'); return; }
      const exist = cart.find(i => i.price === price);
      if (exist) exist.quantity += 1;
      else cart.push({ price, name, quantity: 1 });
      updateCartUI();
      openCart();
      toast(`${name} added to cart`);
      announce(`${name} added to cart`);
    });
  });

  // buy-now (single item checkout)
  $$('[data-buy-now]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const price = btn.getAttribute('data-price');
      const qty   = parseInt(btn.getAttribute('data-qty')||'1', 10) || 1;
      const mode  = (btn.getAttribute('data-mode')||'payment').toLowerCase(); // 'subscription' or 'payment'
      const name  = btn.getAttribute('data-name') || 'Item';
      if (!price){ alert('Missing price id'); return; }

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

      await startCheckout({
        mode,
        items: [{ price, quantity: qty, name }],
        deliveryDate, timeWindow, notes
      }, { retryOnFull: true });
    });
  });
}

/* =====================
   CHECKOUT (cart drawer)
   ===================== */
function disableCheckout(disabled){ if ($cartCheckout){ $cartCheckout.disabled=!!disabled; $cartCheckout.textContent = disabled ? 'Processing…' : 'Checkout'; } }

async function handleCartCheckout(){
  if (!cart.length){ toast('Your cart is empty.'); return; }
  const deliveryDate = $date ? $date.value : '';
  const timeWindow   = $time ? $time.value : '';
  const notes        = $notes ? ($notes.value || '').slice(0,500) : '';
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
      deliveryDate, timeWindow, notes
    }, { retryOnFull: true });
  }finally{
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
      // Handle capacity full with suggestions
      if (retryOnFull && res.status === 409 && data?.error === 'SLOT_FULL'){
        const pick = await pickNewWindowModal({ suggestions: data.suggestions || [], current: payload.timeWindow });
        if (pick){
          // update UI selects to the pick
          if ($time){ $time.value = pick; if ($time.value !== pick){ const opt=document.createElement('option'); opt.value=pick; opt.textContent=pick; $time.appendChild(opt); $time.value=pick; } }
          // update saved pending order to new window
          savePendingOrder({ ...(readPendingOrder()||{}), timeWindow: pick });
          // retry with new window
          return await startCheckout({ ...payload, timeWindow: pick }, { retryOnFull: false });
        }
        // user canceled selection
        return;
      }
      const msg = data?.message || data?.error || `Checkout failed (${res.status}).`;
      console.error('Checkout failed', res.status, data);
      alert(msg);
      return;
    }

    if (data?.url){ window.location.href = data.url; }
    else alert('Could not start checkout. Please try again.');
  }catch(err){
    console.error(err);
    alert('Checkout failed (network).');
  }
}

/* =====================
   DATE/TIME defaults
   ===================== */
(function initDateTime(){
  if ($date){
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    $date.min = `${yyyy}-${mm}-${dd}`;
    if (!$date.value) $date.value = `${yyyy}-${mm}-${dd}`;
  }
  if ($time && !$time.children.length){
    getWindows().forEach(w=>{ const opt=document.createElement('option'); opt.value=w; opt.textContent=w; $time.appendChild(opt); });
  }
})();

/* =====================
   THANK-YOU PAGE SUMMARY
   ===================== */
function qs(key){ const u=new URL(window.location.href); return u.searchParams.get(key); }

function renderThankYou(){
  const isThanks = /thank-you(\.html)?$/i.test(location.pathname) || !!$('#order-summary');
  if (!isThanks) return;

  const sessionId = qs('session_id') || '';
  const data = readPendingOrder();

  // Build a simple summary block
  const host = $('#order-summary') || (()=>{
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

  host.innerHTML = ''; // clear existing

  const h = document.createElement('h2');
  h.textContent = 'Order summary';
  h.style.marginTop = '0';
  host.appendChild(h);

  if (data){
    const meta = document.createElement('div');
    meta.innerHTML = `
      <p style="margin:.2rem 0;"><strong>Delivery date:</strong> ${data.deliveryDate || '—'}</p>
      <p style="margin:.2rem 0;"><strong>Time window:</strong> ${data.timeWindow || '—'}</p>
      ${data.notes ? `<p style="margin:.2rem 0;"><strong>Notes:</strong> ${escapeHtml(data.notes)}</p>` : ''}
    `;
    host.appendChild(meta);

    const itemsTitle = document.createElement('p');
    itemsTitle.innerHTML = '<strong>Items:</strong>';
    host.appendChild(itemsTitle);

    const ul = document.createElement('ul');
    ul.style.marginTop = '6px';
    (data.items || []).forEach(it=>{
      const li = document.createElement('li');
      li.textContent = `${it.name} ×${it.quantity}`;
      ul.appendChild(li);
    });
    host.appendChild(ul);

    const small = document.createElement('p');
    small.style.color = '#6a6f76';
    small.style.fontSize = '12px';
    small.style.marginTop = '10px';
    small.textContent = 'A receipt has been emailed to you via Stripe.';
    host.appendChild(small);
  }else{
    const p = document.createElement('p');
    p.textContent = 'Thanks for your order! Your payment was processed.';
    host.appendChild(p);
  }

  // show session id (hidden) for debugging (optional)
  if (sessionId){
    const dbg = document.createElement('p');
    dbg.style.cssText = 'color:#a0a4aa;font-size:11px;margin-top:12px;';
    dbg.textContent = `Session: ${sessionId}`;
    host.appendChild(dbg);
  }

  // We don’t clear immediately in case user reloads once
  setTimeout(clearPendingOrder, 60_000);
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

/* =====================
   Optional forms
   ===================== */
const $voteForm = $('#vote-form');
const $voteMsg  = $('#vote-msg');
if ($voteForm){
  $voteForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const form = new FormData($voteForm);
    const flavor = (form.get('flavor')||'').toString().trim();
    if (!flavor){ toast('Pick a flavor first.'); return; }
    try{
      const r = await fetch('/api/vote-flavor', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ flavor }) });
      if (r.ok){ if ($voteMsg) $voteMsg.textContent='Thanks for voting!'; toast('Vote recorded. Thanks!'); $voteForm.reset(); }
      else toast('Could not record vote. Try again later.');
    }catch{ toast('Network error.'); }
  });
}

const $merchForm = $('#merch-form');
const $merchMsg  = $('#merch-msg');
if ($merchForm){
  $merchForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const form = new FormData($merchForm);
    const email = (form.get('email')||'').toString().trim();
    if (!email){ toast('Enter your email.'); return; }
    try{
      const r = await fetch('/api/notify-merch', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
      if (r.ok){ if ($merchMsg) $merchMsg.textContent='We’ll email you when merch drops!'; toast('Added to waitlist ✅'); $merchForm.reset(); }
      else toast('Could not add you right now. Try again later.');
    }catch{ toast('Network error.'); }
  });
}

/* =====================
   Fun: Muffin Tapper (floating button)
   ===================== */
(function initMuffinTapper(){
  const btn = document.getElementById('muffin-tapper');
  if (!btn) return;
  const countEl = btn.querySelector('.mt-count');
  let count = parseInt(localStorage.getItem('mt_count')||'0',10) || 0;
  if (countEl) countEl.textContent = String(count);
  btn.addEventListener('click', ()=>{
    count += 1;
    localStorage.setItem('mt_count', String(count));
    if (countEl) countEl.textContent = String(count);
    btn.classList.add('pop');
    setTimeout(()=> btn.classList.remove('pop'), 180);
  });
})();

/* =====================
   Init
   ===================== */
(function init(){
  loadCart();
  renderCart(true);
  initProductButtons();
  renderThankYou();
})();
