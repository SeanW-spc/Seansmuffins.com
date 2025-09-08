// ===== Footer year =====
const y = document.getElementById('y');
if (y) y.textContent = new Date().getFullYear();

// ===== Smooth scroll =====
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const el = document.querySelector(a.getAttribute('href'));
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// ===== Mobile nav toggle =====
(function mobileNav(){
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('primary-nav');
  if (!toggle || !nav) return;
  function closeNav(){ toggle.setAttribute('aria-expanded','false'); nav.classList.remove('open'); document.body.style.overflow=''; }
  function openNav(){ toggle.setAttribute('aria-expanded','true'); nav.classList.add('open'); document.body.style.overflow='hidden'; }
  toggle.addEventListener('click', () => (toggle.getAttribute('aria-expanded')==='true'?closeNav():openNav()));
  nav.querySelectorAll('a').forEach(l => l.addEventListener('click', closeNav));
})();

// ===== Section background images =====
(function applySectionBGs(){
  document.querySelectorAll('.has-bg, .has-bg-optional').forEach(sec => {
    const url = sec.getAttribute('data-bg');
    if (url) sec.style.backgroundImage = `url("${url}")`;
  });
})();

// ===== Parallax hero (disabled on small/reduced motion) =====
(function initParallax(){
  const sec = document.querySelector('.parallax');
  if (!sec) return;
  const bg = sec.querySelector('.parallax-bg');
  const url = sec.getAttribute('data-bg');
  if (bg && url) bg.style.backgroundImage = `url("${url}")`;
  else if (url){ sec.style.backgroundImage = `url("${url}")`; sec.style.backgroundSize='cover'; sec.style.backgroundPosition='center'; }
  const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isSmall = matchMedia('(max-width: 980px)').matches;
  if (prefersReduced || isSmall || !bg) return;
  let ticking=false; const speed=0.25;
  function update(){ const r=sec.getBoundingClientRect(); bg.style.transform=`translate3d(0, ${-r.top*speed}px, 0)`; ticking=false; }
  function onScroll(){ if(!ticking){ requestAnimationFrame(update); ticking=true; } }
  addEventListener('scroll', onScroll, {passive:true}); addEventListener('resize', onScroll, {passive:true}); update();
})();

// ===== Muffin tapper (fun counter) =====
(function initMuffinTapper(){
  const btn = document.getElementById('muffin-tapper'); if (!btn) return;
  const emojiEl = btn.querySelector('.mt-emoji'); const countEl = btn.querySelector('.mt-count');
  const KEY='muffin_tapper_count_v1'; const EMOJIS=['🧁','🧁✨','🧁🍫','🧁💙','🧁🍌','🧁🌰'];
  if (emojiEl) emojiEl.textContent = EMOJIS[Math.floor(Math.random()*EMOJIS.length)];
  let count = 0; try{ const saved=localStorage.getItem(KEY); if(saved) count=Math.max(0,parseInt(saved,10)||0);}catch{}
  if (countEl) countEl.textContent=String(count);
  btn.addEventListener('click',()=>{ count+=1; if(countEl) countEl.textContent=String(count); try{localStorage.setItem(KEY,String(count));}catch{} btn.classList.add('bump'); setTimeout(()=>btn.classList.remove('bump'),120); });
})();

// ===================== CART =====================
const CART_KEY = 'sm_cart_v1';
const $cartBtn = document.getElementById('cart-button');
const $cartDrawer = document.getElementById('cart-drawer');
const $cartBackdrop = document.getElementById('cart-backdrop');
const $cartClose = document.getElementById('cart-close');
const $cartItems = document.getElementById('cart-items');
const $cartCount = document.getElementById('cart-count');
const $cartItemCount = document.getElementById('cart-item-count');
const $cartClear = document.getElementById('cart-clear');
const $cartCheckout = document.getElementById('cart-checkout');

// State
let cart = [];
function saveCart(){ try{ localStorage.setItem(CART_KEY, JSON.stringify(cart)); }catch{} }
function loadCart(){ try{ const raw=localStorage.getItem(CART_KEY); cart = raw? JSON.parse(raw):[]; }catch{ cart=[]; } }
function cartItemsTotal(){ return cart.reduce((n,i)=>n+i.quantity,0); }

function renderCart(){
  if (!$cartItems) return;
  $cartItems.innerHTML = '';
  if (cart.length === 0) {
    $cartItems.innerHTML = '<p style="color:#6a6f76;margin:8px 0 16px;">Your cart is empty.</p>';
  } else {
    cart.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'cart-item';
      div.innerHTML = `
        <div class="cart-item-name">${item.name}</div>
        <div class="cart-qty">
          <button data-act="dec" aria-label="Decrease">–</button>
          <span>${item.quantity}</span>
          <button data-act="inc" aria-label="Increase">+</button>
          <button data-act="remove" aria-label="Remove" title="Remove" style="margin-left:6px;border-color:#ffd3db">✕</button>
        </div>
      `;
      const btnDec = div.querySelector('[data-act="dec"]');
      const btnInc = div.querySelector('[data-act="inc"]');
      const btnRemove = div.querySelector('[data-act="remove"]');

      if (btnDec) btnDec.addEventListener('click', () => { item.quantity = Math.max(1, item.quantity-1); updateCartUI(); });
      if (btnInc) btnInc.addEventListener('click', () => { item.quantity += 1; updateCartUI(); });
      if (btnRemove) btnRemove.addEventListener('click', () => { cart.splice(idx,1); updateCartUI(); });

      $cartItems.appendChild(div);
    });
  }
  const totalItems = cartItemsTotal();
  if ($cartCount) $cartCount.textContent = String(totalItems);
  if ($cartItemCount) $cartItemCount.textContent = String(totalItems);
  saveCart();
}
function updateCartUI(){ renderCart(); }

// Open/close
function openCart(){ if($cartDrawer){ $cartDrawer.classList.add('open'); } if($cartBackdrop){ $cartBackdrop.classList.add('open'); } document.body.style.overflow='hidden'; }
function closeCart(){ if($cartDrawer){ $cartDrawer.classList.remove('open'); } if($cartBackdrop){ $cartBackdrop.classList.remove('open'); } document.body.style.overflow=''; }

if ($cartBtn) $cartBtn.addEventListener('click', openCart);
if ($cartClose) $cartClose.addEventListener('click', closeCart);
if ($cartBackdrop) $cartBackdrop.addEventListener('click', closeCart);
if ($cartClear) $cartClear.addEventListener('click', ()=>{ cart=[]; updateCartUI(); });

// Add / Buy buttons
function initProductButtons(){
  document.querySelectorAll('[data-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const price = btn.getAttribute('data-price');
      const name = btn.getAttribute('data-name') || 'Item';
      if (!price){ alert('Missing price id'); return; }
      const existing = cart.find(i => i.price === price);
      if (existing) existing.quantity += 1;
      else cart.push({ price, name, quantity: 1 });
      updateCartUI(); openCart();
    });
  });

  document.querySelectorAll('[data-buy-now]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const price = btn.getAttribute('data-price');
      const qty = parseInt(btn.getAttribute('data-qty')||'1',10);
      if (!price){ alert('Missing price id'); return; }
      await goToCheckout([{ price, quantity: Math.max(1, qty) }]);
    });
  });
}

// === Cart "Checkout" button ===
if ($cartCheckout) {
  $cartCheckout.addEventListener('click', async () => {
    if (!cart || cart.length === 0) {
      alert('Your cart is empty.');
      return;
    }

    // Validate items have Stripe PRICE IDs
    const bad = cart.find(i => !i.price || !String(i.price).startsWith('price_'));
    if (bad) {
      alert('One or more items are missing a valid Stripe Price ID (must start with price_).');
      return;
    }

    // Optional: disable button while creating session
    $cartCheckout.disabled = true;
    try {
      await goToCheckout(cart.map(({ price, quantity }) => ({ price, quantity })));
    } finally {
      $cartCheckout.disabled = false;
    }
  });
}


// ===== Stripe (safe init) =====
let stripe = null;
function tryInitStripe() {
  const pk = (window && window.STRIPE_PUBLISHABLE_KEY) ? String(window.STRIPE_PUBLISHABLE_KEY) : '';
  if (!pk || pk.startsWith('pk_REPLACE') || pk === 'undefined') {
    console.warn('Stripe publishable key not set. Cart works; checkout disabled.');
    return;
  }
  if (!window.Stripe) {
    setTimeout(tryInitStripe, 100);
    return;
  }
  try {
    stripe = window.Stripe(pk);
  } catch (e) {
    console.error('Stripe init failed:', e);
    stripe = null;
  }
}
if (document.readyState === 'complete') { tryInitStripe(); }
else { window.addEventListener('load', tryInitStripe); }
tryInitStripe();

async function goToCheckout(items){
  if (!stripe){
    alert('Checkout isn’t ready yet. Ensure publishable key in js/config.js and STRIPE_SECRET_KEY in Vercel.');
    return;
  }
  try{
    const res = await fetch('/api/create-checkout-session', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ items })
    });
    if (!res.ok){
      const text = await res.text();
      console.error('Checkout session failed', res.status, text);
      alert(`Checkout failed (${res.status}). ${text || 'See console.'}`);
      return;
    }
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else alert(data.error || 'No checkout URL returned.');
  } catch(e){
    console.error('Network error:', e);
    alert('Network error starting checkout.');
  }
}

// Boot
loadCart(); renderCart(); initProductButtons();
