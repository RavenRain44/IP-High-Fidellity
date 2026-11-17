/* Mockup only (round 9): on narrower screens an opened email covers the body area.
   In the real code this is a "reading" state on the Smart Email screen. */
(function(){
  function addClose(){
    var p=document.querySelector('#app .inbox-grid>.detail-panel');
    if(!p||p.querySelector(':scope>.km-mail-close'))return;
    var b=document.createElement('button');b.type='button';b.className='btn sm km-mail-close';b.textContent='Close';b.setAttribute('aria-label','Close email');
    p.prepend(b);
  }
  function close(){document.body.classList.remove('km-mail-open')}
  document.addEventListener('click',function(e){
    if(e.target.closest('.km-mail-close')){close();return}
    if(e.target.closest('.mail-row'))document.body.classList.add('km-mail-open');
  },true);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&document.body.classList.contains('km-mail-open'))close()});
  var q=false;new MutationObserver(function(){if(q)return;q=true;requestAnimationFrame(function(){q=false;addClose()})}).observe(document.body,{childList:true,subtree:true});
  addClose();
})();
