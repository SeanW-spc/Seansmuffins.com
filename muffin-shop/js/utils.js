// utils.js — shared helpers (load first)
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);

// Normalize en/em dashes to hyphen for keys
const normDash = s => String(s || '').replace(/–|—/g, '-').trim();

// A11y + toast
const a11yLive = $('#a11y-live');
const toastHost = $('#toast');
let toastTimer = null;

function say(msg){
  if (!a11yLive) return;
  a11yLive.textContent = '';
  setTimeout(()=> a11yLive.textContent = msg, 10);
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

// Smooth-scroll for same-page anchors
$$('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// Mobile nav
(function mobileNav(){
  const navToggle = $('.nav-toggle');
  const nav = $('#primary-nav');
  function closeNav(){ if (!navToggle || !nav) return; navToggle.setAttribute('aria-expanded', 'false'); nav.classList.remove('open'); }
  function openNav(){ if (!navToggle || !nav) return; navToggle.setAttribute('aria-expanded', 'true'); nav.classList.add('open'); }
  on(navToggle, 'click', () => { const expanded = navToggle.getAttribute('aria-expanded') === 'true'; expanded ? closeNav() : openNav(); });
  on(nav, 'click', (e) => { if (e.target && e.target.tagName === 'A') closeNav(); });
  on(document, 'keydown', (e) => { if (e.key === 'Escape') closeNav(); });
  on(document, 'click', (e) => {
    if (!navToggle || !nav) return;
    const expanded = navToggle.getAttribute('aria-expanded') === 'true';
    if (!expanded) return;
    const within = nav.contains(e.target) || navToggle.contains(e.target);
    if (!within) closeNav();
  });
})();

// Footer year
const y = $('#y'); if (y) y.textContent = new Date().getFullYear();

// Date helpers
function fmtDateInput(d){
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function addDays(d, n){ const x=new Date(d); x.setDate(x.getDate()+n); x.setHours(0,0,0,0); return x; }
function computeDefaultDeliveryDate(now=new Date()){
  const cutoffH = 20, cutoffM = 30; // 8:30 PM
  const afterCutoff = (now.getHours()>cutoffH) || (now.getHours()===cutoffH && now.getMinutes()>=cutoffM);
  return addDays(now, afterCutoff ? 2 : 1);
}

// Expose a tiny utils namespace (optional)
window.SMUtils = { $, $$, on, normDash, toast, say, fmtDateInput, addDays, computeDefaultDeliveryDate };
