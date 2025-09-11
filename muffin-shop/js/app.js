/* js/app.js — Sean’s Muffins (Buy Now modal + robust checkout)
   - Fixes “missing fields” by reliably capturing price/date/time
   - Works with cart checkout and thank-you summary
*/

// ---------- Utilities ----------
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const fmt = (n) => `$${(Number(n)||0).toFixed(2)}`;
function escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}
function todayISO(){
  const d=new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function toast(msg){
  const t = $('#toast');
  if (!t){ alert(msg); return; }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  t.appendChild(el);
  setTimeout(()=> el.remove(), 2600);
}

// ---------- Cart store ----------
const CART_KEY = 'cart_v1';
const LAST_ORDER_KEY = 'lastOrder';

function loadCart(){
  try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; }
}
function saveCart(items){
  localStorage.setItem(CART_KEY, JSON.stringify(items || []));
  updateCartBadge();
}
function clearCart(){
  saveCart([]);
  renderCart();
}
function addToCart(item){
  const cart = loadCart();
  const i = cart.findIndex(x => x.price === item.price);
  if (i >= 0){ cart[i].quantity += item.quantity || 1; }
  else { cart.push({ price: item.price, name: item.name || 'Item', quantity: item.quantity || 1 }); }
  saveCart(cart);
  renderCart();
  toast('Added to cart');
}
function updateCartBadge(){
  const count = loadCart().reduce((s, it)=> s + (it.quantity||0), 0);
  const badge = $('#cart-count'); if (badge) badge.textContent = String(count);
}

// ---------- Buy-Now Modal (injected) ----------
function ensureBuyNowModal(){
  if ($('#bn-modal')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div id="bn-backdrop" class="cart-backdrop" aria-hidden="true"></div>
  <div id="bn-modal" class="cart-drawer" role="dialog" aria-modal="true" aria-label="Select delivery">
    <div class="cart-header">
      <h2>Delivery details</h2>
      <button id="bn-close" class="cart-close" aria-label="Close">✕</button>
    </div>
    <div class="cart-items" style="padding:12px;">
      <div class="cart-delivery">
        <div class="row">
          <div>
            <label for="bn-date">Date</label>
            <input type="date" id="bn-date" required>
          </div>
          <div>
            <label for="bn-time">Preferred time</label>
            <select id="bn-time" required>
              <option value="">Select a window…</option>
              <option>6:00–7:00 AM</option>
              <option>7:00–8:00 AM</option>
              <option>8:00–9:00 AM</option>
            </select>
          </div>
        </div>
        <div style="margin-top:12px;">
          <label for="bn-notes">Notes (optional)</label>
          <textarea id="bn-notes" rows="3" placeholder="Delivery notes / allergies (optional)"></textarea>
        </div>
      </div>
      <div class="cart-actions" style="margin-top:12px;">
        <button id="bn-cancel" class="btn btn-ghost">Cancel</button>
        <button id="bn-go" class="btn btn-primary">Continue to Checkout</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  $('#bn-close')?.addEventListener('click', hideBuyNowModal);
  $('#bn-cancel')?.addEventListener('click', hideBuyNowModal);
}
function showBuyNowModal(prefill){
  ensureBuyNowModal();
  $('#bn-backdrop').setAttribute('aria-hidden', 'false');
  $('#bn-modal').setAttribute('data-open', '1');
  $('#bn-date').value = prefill?.date || todayISO();
  $('#bn-time').value = prefill?.time || '';
  $('#bn-notes').value = prefill?.notes || '';
}
function hideBuyNowModal(){
  $('#bn-backdrop')?.setAttribute('aria-hidden', 'true');
  $('#bn-modal')?.removeAttribute('data-open');
}

// ---------- Cart Drawer UI ----------
function openCart(){
  $('#cart-backdrop')?.setAttribute('aria-hidden', 'false');
  $('#cart-drawer')?.setAttribute('aria-hidden', 'false');
  renderCart();
}
function closeCart(){
  $('#cart-backdrop')?.setAttribute('aria-hidden', 'true');
  $('#cart-drawer')?.setAttribute('aria-hidden', 'true');
}
function renderCart(){
  const items = loadCart();
  const list = $('#cart-items');
  if (!list) return;
  list.innerHTML = '';
  if (!items.length){
    list.innerHTML = `<div class="empty">Your cart is empty</div>`;
  } else {
    items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'cart-item';
      row.innerHTML = `
        <div>
          <div class="ci-name">${escapeHtml(it.name || 'Item')}</div>
          <div class="ci-meta">Qty: ${it.quantity}</div>
        </div>
        <button class="btn btn-ghost" data-remove="${idx}">Remove</button>
      `;
      list.appendChild(row);
    });
  }
  $('#cart-item-count').textContent = String(items.reduce((s,i)=> s + (i.quantity||0), 0));
  $$( '[data-remove]', list ).forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const i = Number(e.currentTarget.getAttribute('data-remove'));
      const cart = loadCart(); cart.splice(i,1); saveCart(cart); renderCart();
    });
  });
}

// ---------- Checkout helpers ----------
async function postJSON(path, body){
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = null;
  try { data = await r.json(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, data };
}

function persistLastOrder({ items, deliveryDate, timeWindow, notes }){
  const payload = { items, deliveryDate, timeWindow, notes };
  localStorage.setItem(LAST_ORDER_KEY, JSON.stringify(payload));
}

// ---------- Event wiring ----------
document.addEventListener('DOMContentLoaded', () => {
  updateCartBadge();

  // Nav toggle (mobile)
  const navToggle = $('.nav-toggle');
  if (navToggle){
    navToggle.addEventListener('click', ()=>{
      const nav = $('#primary-nav');
      const expanded = navToggle.getAttribute('aria-expanded') === 'true';
      navToggle.setAttribute('aria-expanded', String(!expanded));
      nav?.classList.toggle('open', !expanded);
    });
  }

  // Cart open/close
  $('#cart-button')?.addEventListener('click', openCart);
  $('#cart-close')?.addEventListener('click', closeCart);
  $('#cart-backdrop')?.addEventListener('click', closeCart);
  $('#cart-clear')?.addEventListener('click', clearCart);

  // Add-to-cart
  document.body.addEventListener('click', (e)=>{
    const addBtn = e.target.closest('[data-add]');
    if (!addBtn) return;
    const price = addBtn.getAttribute('data-price');
    const name  = addBtn.getAttribute('data-name') || 'Item';
    if (!price){
      toast('Missing price for this item.'); return;
    }
    addToCart({ price, name, quantity: 1 });
  });

  // Buy-now (one item)
  document.body.addEventListener('click', (e)=>{
    const bn = e.target.closest('[data-buy-now]');
    if (!bn) return;

    const price = bn.getAttribute('data-price');
    const name  = bn.getAttribute('data-name') || 'Item';
    const qty   = Number(bn.getAttribute('data-qty') || '1');
    if (!price){
      toast('Missing price for this item.'); return;
    }

    showBuyNowModal({ date: todayISO(), time: '', notes: '' });

    // one-shot handler
    const go = $('#bn-go');
    const handler = async () => {
      const deliveryDate = $('#bn-date').value;
      const timeWindow   = $('#bn-time').value;
      const orderNotes   = $('#bn-notes').value || '';

      if (!deliveryDate || !timeWindow){
        toast('Please select date and time.'); return;
      }

      const items = [{ price, quantity: qty }];
      persistLastOrder({ items: [{ name, quantity: qty }], deliveryDate, timeWindow, notes: orderNotes });

      const { ok, status, data } = await postJSON('/api/create-checkout-session', {
        items, deliveryDate, timeWindow, orderNotes
      });
      if (!ok){
        console.error('Checkout failed', status, data);
        if (data && data.error === 'window_full'){
          toast('That window is full. Please pick another.');
        } else if (data && data.error === 'missing_fields'){
          toast('Missing fields. Please reselect date & time.');
        } else {
          toast(`Checkout failed ${status}`);
        }
        return;
      }
      hideBuyNowModal();
      if (data && data.url) location.href = data.url;
    };

    // remove previous to avoid multiple binds
    go.replaceWith(go.cloneNode(true));
    $('#bn-go').addEventListener('click', handler, { once: true });
  });

  // Cart checkout (multi-item)
  $('#cart-checkout')?.addEventListener('click', async ()=>{
    const cart = loadCart();
    if (!cart.length){ toast('Your cart is empty'); return; }

    const deliveryDate = $('#delivery-date')?.value || '';
    const timeWindow   = $('#delivery-time')?.value || '';
    const orderNotes   = $('#bn-notes') ? $('#bn-notes').value : ''; // carry if present

    if (!deliveryDate || !timeWindow){
      toast('Please select delivery date and time.'); return;
    }

    const items = cart.map(it => ({ price: it.price, quantity: it.quantity || 1 }));
    persistLastOrder({
      items: cart.map(it => ({ name: it.name, quantity: it.quantity })),
      deliveryDate, timeWindow, notes: orderNotes
    });

    const { ok, status, data } = await postJSON('/api/create-checkout-session', {
      items, deliveryDate, timeWindow, orderNotes
    });
    if (!ok){
      console.error('Checkout failed', status, data);
      if (data && data.error === 'window_full'){
        toast('That window is full. Please pick another.');
      } else if (data && data.error === 'missing_fields'){
        toast('Missing fields. Please reselect date & time.');
      } else {
        toast(`Checkout failed ${status}`);
      }
      return;
    }
    if (data && data.url) location.href = data.url;
  });

  // Thank-you page summary
  if (location.pathname.endsWith('/thank-you.html') || location.pathname.endsWith('thank-you.html')){
    renderThankYou();
  }

  // Footer year
  const y = $('#y'); if (y) y.textContent = String(new Date().getFullYear());
});

// ---------- Thank-you summary ----------
async function renderThankYou(){
  const box = $('#order-summary');
  if (!box) return;
  const u = new URL(location.href);
  const sid = u.searchParams.get('session_id') || '(unknown)';

  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_ORDER_KEY) || 'null'); } catch {}
  const items = last?.items || [];
  const when = last ? `${last.deliveryDate || ''} • ${last.timeWindow || ''}` : '';
  const notes = last?.notes || '';

  box.innerHTML = `
    <div><strong>Session:</strong> ${escapeHtml(sid)}</div>
    ${when ? `<div><strong>Delivery:</strong> ${escapeHtml(when)}</div>` : ''}
    ${items.length ? `
      <div style="margin-top:8px;"><strong>Items:</strong>
        <ul style="margin:6px 0 0 18px;">
          ${items.map(i => `<li>${escapeHtml(i.name)} × ${i.quantity}</li>`).join('')}
        </ul>
      </div>` : ''
    }
    ${notes ? `<div style="margin-top:8px;"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : ''}
    <p class="muted" style="margin-top:10px;">We’ll email you a receipt and delivery updates. Thanks!</p>
  `;
}
