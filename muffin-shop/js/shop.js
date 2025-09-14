// shop.js — cart, product buttons, checkout, thank-you, voting, tapper
(() => {
  const { $, $$, on, toast, computeDefaultDeliveryDate, fmtDateInput } = window.SMUtils || {};

  // API base (SM REV). If not set, fall back to same-origin (dev).
  const API_BASE = (window.SM_REV_API_BASE || '').replace(/\/$/, '');
  const apiUrl = (path) => (API_BASE ? `${API_BASE}${path}` : path);

  // Cart state
  const CART_KEY = 'sm_cart_v1';
  let cart = [];

  // Broadcast across tabs
  const CLIENT_ID = Math.random().toString(36).slice(2);
  const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sm_cart') : null;
  if (bc){
    bc.onmessage = (ev) => {
      try {
        if (!ev?.data || ev.data.from === CLIENT_ID) return;
        if (ev.data.type === 'cart'){
          cart = sanitizeCartItems(ev.data.cart || []);
          renderCart(); updateCartBadge();
          document.dispatchEvent(new Event('sm:cartChanged'));
        }
      } catch {}
    };
  }

  function sanitizeCartItems(arr){
    return (Array.isArray(arr) ? arr : []).map(i => ({
      ...i,
      quantity: Math.max(1, parseInt(i.quantity ?? 1, 10) || 1)
    }));
  }

  function loadCart(){
    try {
      const raw = localStorage.getItem(CART_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      cart = sanitizeCartItems(parsed);
    } catch { cart = []; }
  }
  function saveCart(){
    try {
      cart = sanitizeCartItems(cart);
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
      if (bc) bc.postMessage({ type:'cart', from:CLIENT_ID, cart: cart.map(i => ({...i})) });
      document.dispatchEvent(new Event('sm:cartChanged'));
    } catch {}
  }
  function cartItemsTotal(){
    return cart.reduce((n,i)=> n + (parseInt(i.quantity||0,10) || 0), 0);
  }

  // Pending order (for thank-you page)
  const PENDING_KEY = 'sm_pending_order';
  function rememberPendingOrder(payload){
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(payload || {})); } catch {}
  }
  function readPendingOrder(){
    try { const raw = localStorage.getItem(PENDING_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  function clearPendingOrder(){ try{ localStorage.removeItem(PENDING_KEY); }catch{} }

  // Elements
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
  const $slotLeft = $('#slot-left');

  // Touch-friendly "tap"
  let _lastTouchTs = 0;
  window.addEventListener('touchend', () => { _lastTouchTs = Date.now(); }, true);
  function onTap(el, handler){
    if (!el) return;
    el.addEventListener('touchend', (e) => { _lastTouchTs = Date.now(); handler(e); }, { passive: true });
    el.addEventListener('click', (e) => { if (Date.now()-_lastTouchTs < 500){ e.preventDefault(); return; } handler(e); });
  }

  // Availability helpers from availability.js
  const refreshAvailability = () => (window.refreshAvailability && window.refreshAvailability());
  const preflightCapacity   = (...args) => (window.preflightCapacity ? window.preflightCapacity(...args) : Promise.resolve(true));

  function setupTimeOptions(){
    if (!$deliveryTime) return;
    Array.from($deliveryTime.options).forEach(opt => {
      const label = (opt.textContent || '').trim();
      if (!opt.dataset.base) opt.dataset.base = label;
      if (!opt.hasAttribute('value') && label && opt.value === '') {
        opt.value = label;
      }
    });
  }
  function selectedWindowBase(){
    if (!$deliveryTime) return '';
    const opt = $deliveryTime.selectedOptions[0];
    const base = (opt ? (opt.dataset.base || opt.value || opt.textContent) : '').trim();
    return base.replace(/\s+—.+$/,'');
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
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
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
    refreshAvailability();
  }

  on($cartClear, 'click', () => {
    cart = [];
    saveCart(); renderCart(); updateCartBadge();
    toast('Cart cleared');
  });

  function initProductButtons(){
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

    $$('[data-buy-now]').forEach(btn => {
      onTap(btn, () => {
        const price = btn.getAttribute('data-price');
        const name  = btn.getAttribute('data-name') || 'Muffin Box';
        const qty   = parseInt(btn.getAttribute('data-qty')||'1',10) || 1;
        const mode  = (btn.getAttribute('data-mode') || 'payment').toLowerCase();
        if (mode === 'subscription'){ toast('Subscriptions are coming soon.'); return; }
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

  on($cartCheckout, 'click', async () => {
    try {
      if (!cart.length){ toast('Your cart is empty'); return; }
      const date  = $deliveryDate?.value || '';
      const win   = $deliveryTime?.value || '';
      const notes = ($orderNotes?.value || '').trim();
      if (!date){ toast('Please choose a delivery date'); $deliveryDate?.focus(); return; }
      if (!win){  toast('Please choose a delivery window'); $deliveryTime?.focus(); return; }

      const need = cartItemsTotal() || 1;
      const ok = await preflightCapacity(date, win, need);
      if (!ok){
        toast('That delivery window is full for your quantity. Please pick another window.');
        refreshAvailability();
        $deliveryTime?.focus();
        return;
      }

      const payload = {
        mode: 'payment',
        items: cart.map(i => ({ price: i.price, quantity: parseInt(i.quantity||1,10) || 1 })),
        deliveryDate: date,
        timeWindow: win,
        orderNotes: notes || ''
      };

      rememberPendingOrder({ date, win, notes, items: cart.map(i => ({...i})) });

      const resp = await fetch(apiUrl('/api/create-checkout-session'), {
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
          driver_full: 'All drivers are booked for that window. Please pick another window.',
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
        if (['window_full','capacity_full','slots_reservation_failed'].includes(errCode)){
          refreshAvailability();
        }
        return;
      }

      const { id, url } = await resp.json();

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
        driver_full: 'All drivers are booked for that window. Please pick another window.',
        subscription_disabled: 'Subscriptions are coming soon.',
        invalid_price: 'That item is unavailable. Please refresh and try again.',
        stripe_key_mismatch: 'Payment system mode mismatch. Please try again shortly.',
        stripe_config: 'Payment system is being configured. Please try again shortly.',
        stripe_error: 'Payment processor error. Please try again.'
      };
      toast(map[msg] || 'Checkout failed. Please try again.');
    }
  });

  // Thank you page summary
  function renderThankYou(){
    const host = $('#order-summary'); // fixed id
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

  // Voting form → SM REV
  const $voteForm = $('#vote-form');
  if ($voteForm){
    on($voteForm, 'submit', async (e) => {
      e.preventDefault();
      const fd = new FormData($voteForm);
      const flavor = (fd.get('flavor') || '').toString().trim();
      if (!flavor){ toast('Pick a flavor'); return; }
      try {
        const resp = await fetch(apiUrl('/api/vote-flavor'), {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ flavor })
        });
        if (!resp.ok) throw new Error();
        toast('Thanks for voting!');
        $voteForm.reset();
      } catch {
        toast('Could not send your vote.');
      }
    });
  }

  // Optional: Merch notify form → SM REV
  const $merchForm = $('#merch-form');
  if ($merchForm){
    const $msg = $('#merch-msg');
    on($merchForm, 'submit', async (e) => {
      e.preventDefault();
      const email = (new FormData($merchForm).get('email') || '').toString().trim();
      if (!email){ toast('Enter your email'); return; }
      try{
        const r = await fetch(apiUrl('/api/notify-merch'), {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({ email })
        });
        if (!r.ok) throw new Error();
        if ($msg) $msg.textContent = 'You’re on the list! 🎉';
        $merchForm.reset();
      }catch{
        if ($msg) $msg.textContent = 'Could not save your email right now.';
      }
    });
  }

  // Muffin tapper
  (function initTapper(){
    const $tapper = $('#muffin-tapper');
    if (!$tapper) return;
    const $cnt = $('.mt-count', $tapper);
    let n = parseInt(($cnt?.textContent || '0'), 10) || 0;
    const tap = () => {
      n += 1;
      if ($cnt) $cnt.textContent = String(n);
      $tapper.classList.add('pop');
      setTimeout(()=> $tapper.classList.remove('pop'), 160);
    };
    $tapper.addEventListener('touchend', tap, { passive:true });
    $tapper.addEventListener('click', (e)=> { if (e.detail !== 0) tap(); });
  })();

  // Init on load
  (function init(){
    loadCart();
    renderCart();
    updateCartBadge();
    initProductButtons();
    renderThankYou();

    if ($deliveryDate){
      const def = computeDefaultDeliveryDate();
      const defStr = fmtDateInput(def);
      if (!$deliveryDate.value) $deliveryDate.value = defStr;
      $deliveryDate.min = defStr;
      on($deliveryDate, 'change', () => { refreshAvailability(); });
    }
    on($deliveryTime, 'change', refreshAvailability);

    setupTimeOptions();
    refreshAvailability();
  })();
})();
