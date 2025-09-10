/* =========================
   Sean’s Muffins – app.js (FULL FILE, with Notes)
   ========================= */

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

/* Footer year */
const y = document.getElementById('y'); if (y) y.textContent = new Date().getFullYear();

/* Smooth scroll */
$$('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* A11y + toasts */
const $live = document.getElementById('a11y-live');
const $toasts = document.getElementById('toast');
function announce(msg){ try{ if ($live){ $live.textContent=''; setTimeout(()=>{ $live.textContent=msg; },10);} }catch{} }
function toast(msg){ if(!$toasts){ alert(msg); return; } const el=document.createElement('div'); el.className='toast'; el.textContent=msg; $toasts.appendChild(el); setTimeout(()=>el.remove(),2600); }

/* Cart */
const CLIENT_ID = Math.random().toString(36).slice(2);
const CART_KEY  = 'sm_cart_v1';

const $cartBtn       = document.getElementById('cart-button');
const $cartDrawer    = document.getElementById('cart-drawer');
const $cartBackdrop  = document.getElementById('cart-backdrop');
const $cartClose     = document.getElementById('cart-close');
const $cartItems     = document.getElementById('cart-items');
const $cartCount     = document.getElementById('cart-count');
const $cartItemCount = document.getElementById('cart-item-count');
const $cartClear     = document.getElementById('cart-clear');
const $cartCheckout  = document.getElementById('cart-checkout');

const $date   = document.getElementById('delivery-date');
const $time   = document.getElementById('delivery-time');
const $notes  = document.getElementById('order-notes');

const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sm_cart') : null;
let cart = [];

function getWindows(){ return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM']; }
function loadCart(){ try{ const raw=localStorage.getItem(CART_KEY); const parsed=raw?JSON.parse(raw):[]; cart = Array.isArray(parsed)?parsed:[]; }catch{ cart=[]; } }
function saveCart(){ try{ localStorage.setItem(CART_KEY, JSON.stringify(cart)); if (bc) bc.postMessage({ type:'cart', from:CLIENT_ID, cart:cart.map(i=>({...i})) }); }catch{} }
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
        div.querySelector('[data-act="dec"]').addEventListener('click', ()=>{ item.quantity = Math.max(1, (item.quantity||1)-1); updateCartUI(); });
        div.querySelector('[data-act="inc"]').addEventListener('click', ()=>{ item.quantity = (item.quantity||0)+1; updateCartUI(); });
        div.querySelector('[data-act="remove"]').addEventListener('click', ()=>{ cart.splice(idx,1); updateCartUI(); });
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

/* Cross-tab */
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
if ($cartBtn)      $cartBtn.addEventListener('click', openCart);
if ($cartClose)    $cartClose.addEventListener('click', closeCart);
if ($cartBackdrop) $cartBackdrop.addEventListener('click', closeCart);
if ($cartClear)    $cartClear.addEventListener('click', ()=>{ cart=[]; updateCartUI(); toast('Cart cleared'); announce('Cart cleared'); });

/* ===== Delivery popup for Buy Now (includes notes) ===== */
let deliveryModalEl = null;
function buildDeliveryModal(){
  const el = document.createElement('div');
  el.id = 'delivery-modal';
  el.setAttribute('role','dialog');
  el.setAttribute('aria-modal','true');
  el.style.cssText = `position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.48); padding:16px;`;
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

/* Product buttons */
function initProductButtons(){
  $$('[data-add], [data-buy-now]').forEach(btn=>{ if (!btn.hasAttribute('type')) btn.setAttribute('type','button'); });

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

  $$('[data-buy-now]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const price = btn.getAttribute('data-price');
      const qty   = parseInt(btn.getAttribute('data-qty')||'1', 10) || 1;
      const mode  = (btn.getAttribute('data-mode')||'payment').toLowerCase(); // 'subscription' or 'payment'
      const name  = btn.getAttribute('data-name') || 'Item';
      if (!price){ alert('Missing price id'); return; }

      let deliveryDate = $date ? $date.value : '';
      let timeWindow   = $time ? $time.value : '';
      let notes        = $notes ? $notes.value : '';
      if (!deliveryDate || !timeWindow){
        const picked = await promptDeliveryDetails();
        if (!picked) return;
        deliveryDate = picked.date;
        timeWindow   = picked.time;
        notes        = picked.notes || notes || '';
      }

      const prev = btn.textContent;
      btn.disabled = true; btn.textContent = 'Processing…';

      try{
        const res = await fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({
            mode,
            items: [{ price, quantity: qty, name }],
            deliveryDate,
            timeWindow,
            notes
          })
        });

        let data = {};
        try { data = await res.json(); } catch {}
        if (!res.ok){
          if (res.status === 409 && data?.error === 'SLOT_FULL'){
            const s = (data.suggestions||[]).join(' • ') || 'another time';
            alert(`That window is full. Try: ${s}`);
            return;
          }
          const msg = data?.message || data?.error || `Checkout failed (${res.status}).`;
          console.error('Checkout failed', res.status, data);
          alert(msg);
          return;
        }
        if (data?.url) window.location.href = data.url;
        else alert('Could not start checkout. Please try again.');
      }catch(err){
        console.error(err);
        alert('Checkout failed (network).');
      }finally{
        btn.disabled = false; btn.textContent = prev;
      }
    });
  });
}

/* Checkout (cart drawer) */
function disableCheckout(disabled){ if ($cartCheckout){ $cartCheckout.disabled=!!disabled; $cartCheckout.textContent = disabled ? 'Processing…' : 'Checkout'; } }
async function handleCartCheckout(){
  if (!cart.length){ toast('Your cart is empty.'); return; }
  const deliveryDate = $date ? $date.value : '';
  const timeWindow   = $time ? $time.value : '';
  const notes        = $notes ? ($notes.value || '').slice(0,500) : '';
  if (!deliveryDate){ toast('Choose a delivery date first.'); if ($date) $date.focus(); return; }
  if (!timeWindow){ toast('Choose a time window first.'); if ($time) $time.focus(); return; }

  try{
    disableCheckout(true);
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        mode: 'payment',
        items: cart.map(i => ({ price: i.price, quantity: i.quantity, name: i.name })),
        deliveryDate,
        timeWindow,
        notes
      })
    });

    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok){
      if (res.status === 409 && data?.error === 'SLOT_FULL'){
        const s = (data.suggestions||[]).join(' • ') || 'another time';
        alert(`That window is full. Try: ${s}`);
        return;
      }
      const msg = data?.message || data?.error || `Checkout failed (${res.status}).`;
      console.error('Checkout failed', res.status, data);
      alert(msg);
      return;
    }
    const { url } = data;
    if (url) window.location.href = url;
  }catch(err){
    console.error(err);
    alert('Checkout failed (network).');
  }finally{
    disableCheckout(false);
  }
}
if ($cartCheckout) $cartCheckout.addEventListener('click', handleCartCheckout);

/* Date/time defaults */
(function initDateTime(){
  if ($date){
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    $date.min = `${yyyy}-${mm}-${dd}`;
    if (!$date.value) $date.value = `${yyyy}-${mm}-${dd}`;
  }
  if ($time && !$time.children.length){ getWindows().forEach(w=>{ const opt=document.createElement('option'); opt.value=w; opt.textContent=w; $time.appendChild(opt); }); }
})();

/* Optional forms */
const $voteForm = document.getElementById('vote-form');
const $voteMsg  = document.getElementById('vote-msg');
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
const $merchForm = document.getElementById('merch-form');
const $merchMsg  = document.getElementById('merch-msg');
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

/* Fun: Muffin Tapper */
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

/* Init */
(function init(){ loadCart(); renderCart(true); initProductButtons(); })();
