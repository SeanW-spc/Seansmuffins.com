/* =========================
   Sean’s Muffins – app.js (FULL FILE)
   Paste this entire file over your existing js/app.js
   ========================= */

/* ===== Small helpers ===== */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

/* ===== Footer year ===== */
const y = document.getElementById('y'); if (y) y.textContent = new Date().getFullYear();

/* ===== Smooth scroll for on-page anchors ===== */
$$('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* ===== A11y live announcements + toasts ===== */
const $live = document.getElementById('a11y-live');
const $toasts = document.getElementById('toast');

function announce(msg){
  try{
    if ($live){
      $live.textContent = '';
      setTimeout(()=>{ $live.textContent = msg; }, 10);
    }
  }catch{}
}
function toast(msg){
  if (!$toasts) { alert(msg); return; }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(()=>{ el.remove(); }, 2600);
}

/* =====================
   CART (with cross-tab sync + flicker fix)
   ===================== */
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

const $date = document.getElementById('delivery-date');
const $time = document.getElementById('delivery-time');

const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sm_cart') : null;
let cart = [];

/* Windows should match backend's list for suggestions */
function getWindows(){ return ['6:00–7:00 AM', '7:00–8:00 AM', '8:00–9:00 AM']; }

function loadCart(){
  try{
    const raw = localStorage.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cart = Array.isArray(parsed) ? parsed : [];
  }catch{ cart = []; }
}
function saveCart(){
  try{
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    if (bc) bc.postMessage({ type:'cart', from: CLIENT_ID, cart: cart.map(i=>({...i})) });
  }catch{}
}

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

/* Cross-tab listeners (ignore self + bad payloads to prevent flicker) */
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
function openCart(){
  if ($cartDrawer)   $cartDrawer.classList.add('open');
  if ($cartBackdrop) $cartBackdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeCart(){
  if ($cartDrawer)   $cartDrawer.classList.remove('open');
  if ($cartBackdrop) $cartBackdrop.classList.remove('open');
  document.body.style.overflow = '';
}
if ($cartBtn)      $cartBtn.addEventListener('click', openCart);
if ($cartClose)    $cartClose.addEventListener('click', closeCart);
if ($cartBackdrop) $cartBackdrop.addEventListener('click', closeCart);
if ($cartClear)    $cartClear.addEventListener('click', ()=>{ cart=[]; updateCartUI(); toast('Cart cleared'); announce('Cart cleared'); });

/* =====================
   PRODUCT BUTTONS (single source of truth)
   ===================== */
function initProductButtons(){
  /* Defensive: ensure buttons never submit a form */
  $$('[data-add], [data-buy-now]').forEach(btn=>{
    if (!btn.hasAttribute('type')) btn.setAttribute('type','button');
  });

  /* Add to cart */
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

  /* Buy Now (supports subscription or one-time) */
  $$('[data-buy-now]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const price = btn.getAttribute('data-price');
      const qty   = parseInt(btn.getAttribute('data-qty')||'1', 10) || 1;
      const mode  = (btn.getAttribute('data-mode')||'payment').toLowerCase(); // 'subscription' or 'payment'
      const name  = btn.getAttribute('data-name') || 'Item';
      if (!price){ alert('Missing price id'); return; }

      const deliveryDate = $date ? $date.value : '';
      const timeWindow   = $time ? $time.value : '';
      if (!deliveryDate){ toast('Choose a delivery date first.'); if ($date) $date.focus(); return; }
      if (!timeWindow){ toast('Choose a time window first.'); if ($time) $time.focus(); return; }

      try{
        disableCheckout(true);
        const res = await fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({
            mode,
            items: [{ price, quantity: qty, name }],
            deliveryDate,
            timeWindow
          })
        });
        if (!res.ok){
          const data = await res.json().catch(()=>({}));
          if (res.status === 409 && data?.error === 'SLOT_FULL'){
            const s = (data.suggestions||[]).join(' • ') || 'another time';
            alert(`That window is full. Try: ${s}`);
            return;
          }
          console.error('Checkout failed', res.status, data);
          alert(`Checkout failed (${res.status}). ${data?.error || ''}`);
          return;
        }
        const { url } = await res.json();
        if (url) window.location.href = url;
      }catch(err){
        console.error(err);
        alert('Checkout failed (network).');
      }finally{
        disableCheckout(false);
      }
    });
  });
}

/* =====================
   CHECKOUT (cart drawer)
   ===================== */
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
        timeWindow
      })
    });
    if (!res.ok){
      const data = await res.json().catch(()=>({}));
      if (res.status === 409 && data?.error === 'SLOT_FULL'){
        const s = (data.suggestions||[]).join(' • ') || 'another time';
        alert(`That window is full. Try: ${s}`);
        return;
      }
      console.error('Checkout failed', res.status, data);
      alert(`Checkout failed (${res.status}). ${data?.error || ''}`);
      return;
    }
    const { url } = await res.json();
    if (url) window.location.href = url;
  }catch(err){
    console.error(err);
    alert('Checkout failed (network).');
  }finally{
    disableCheckout(false);
  }
}
if ($cartCheckout) $cartCheckout.addEventListener('click', handleCartCheckout);

/* =====================
   DATE / TIME helpers
   ===================== */
(function initDateTime(){
  if ($date){
    // Default to today
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    $date.min = `${yyyy}-${mm}-${dd}`;
    if (!$date.value) $date.value = `${yyyy}-${mm}-${dd}`;
  }
  if ($time){
    if (!$time.children.length){
      getWindows().forEach(w=>{
        const opt = document.createElement('option');
        opt.value = w; opt.textContent = w;
        $time.appendChild(opt);
      });
    }
  }
})();

/* =====================
   Flavor vote + Merch notify forms (optional)
   ===================== */
const $voteForm = document.getElementById('vote-form');
const $voteMsg  = document.getElementById('vote-msg');
if ($voteForm){
  $voteForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const form = new FormData($voteForm);
    const flavor = (form.get('flavor')||'').toString().trim();
    if (!flavor){ toast('Pick a flavor first.'); return; }
    try{
      const r = await fetch('/api/vote-flavor', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ flavor })
      });
      if (r.ok){
        if ($voteMsg){ $voteMsg.textContent = 'Thanks for voting!'; }
        toast('Vote recorded. Thanks!');
        $voteForm.reset();
      }else{
        toast('Could not record vote. Try again later.');
      }
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
      const r = await fetch('/api/notify-merch', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ email })
      });
      if (r.ok){
        if ($merchMsg){ $merchMsg.textContent = 'We’ll email you when merch drops!'; }
        toast('Added to waitlist ✅');
        $merchForm.reset();
      }else{
        toast('Could not add you right now. Try again later.');
      }
    }catch{ toast('Network error.'); }
  });
}

/* =====================
   Fun: Muffin Tapper (thank-you + home)
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
})();
