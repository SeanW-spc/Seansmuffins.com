// js/cookies.js
(function(){
  const KEY = 'cookie_consent_v1';
  const banner = document.getElementById('cookie-banner');
  const btn = document.getElementById('cookie-accept');
  if (!banner || !btn) return;

  // Show only if not previously accepted
  const accepted = localStorage.getItem(KEY);
  if (!accepted) banner.hidden = false;

  btn.addEventListener('click', ()=>{
    localStorage.setItem(KEY, String(Date.now()));
    banner.hidden = true;
  });
})();
