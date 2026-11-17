/* Mockup only (round 8). In the real code each of these is a markup change in the screen renderers.
   1 Smart Email rows: two compact lines; tags join line 2 and wrap only when they don't fit.
   2 Record pages: sections below the highlights strip collapse; click a heading to open.
   3 Manager View: salesperson progress sits under the counts; nothing selected until clicked. */
(function(){
  var openSecs={};
  function mailRows(){
    document.querySelectorAll('#app .mail-row:not([data-km])').forEach(function(r){
      r.setAttribute('data-km','1');
      var l1=r.querySelector('.line1'),co=r.querySelector('.company-name'),su=r.querySelector('.subject'),pr=r.querySelector('.preview'),tg=r.querySelector('.line3');
      if(!l1||!su)return;
      var a=document.createElement('div');a.className='km-l1';
      var b=document.createElement('div');b.className='km-l2';
      var s=l1.querySelector('strong'),t=l1.querySelector('time');
      if(s)a.appendChild(s);if(co){co.removeAttribute('style');a.appendChild(co)}if(t)a.appendChild(t);
      b.appendChild(su);if(pr)b.appendChild(pr);if(tg)b.appendChild(tg);
      l1.replaceWith(a);a.after(b);
    });
  }
  function title(sec){var h=sec.querySelector('.km-head h2')||sec.querySelector('.section-title h2');return h?h.textContent.trim():''}
  function collapsibles(){
    document.querySelectorAll('#app .km-record>.profile-section:not(.km-highlights):not([data-km-col])').forEach(function(sec){
      var head=sec.querySelector(':scope>.section-title');sec.setAttribute('data-km-col','1');
      if(!head){var w=sec.firstElementChild;head=w&&w.querySelector(':scope>.section-title:first-child');if(head)w.classList.add('km-headwrap')}
      if(!head)return;head.classList.add('km-head');
      var key=title(sec);sec.classList.add('km-collapsible');
      var open=!!openSecs[key];sec.classList.toggle('km-closed',!open);
      head.setAttribute('role','button');head.setAttribute('tabindex','0');head.setAttribute('aria-expanded',String(open));
    });
  }
  function toggle(head){
    var sec=head.closest('.km-collapsible'),key=title(sec),open=sec.classList.contains('km-closed');
    sec.classList.toggle('km-closed',!open);head.setAttribute('aria-expanded',String(open));openSecs[key]=open;
  }
  document.addEventListener('click',function(e){
    var head=e.target.closest('.km-collapsible .km-head');
    if(head&&!e.target.closest('a,button,select,input,label,option')){toggle(head);return}
    if(e.target.closest('.rep-card'))document.body.classList.add('km-rep-chosen');
  },true);
  document.addEventListener('keydown',function(e){
    var head=e.target.closest&&e.target.closest('.km-collapsible .km-head');
    if(head&&e.target===head&&(e.key==='Enter'||e.key===' ')){e.preventDefault();toggle(head)}
  });
  function manager(){
    if(typeof ui==='undefined'||ui.page!=='manager')return;
    var main=document.querySelector('#app .content');if(!main)return;
    var h=[].slice.call(main.querySelectorAll('h2')).find(function(x){return /Individual Salesperson Progress/.test(x.textContent)});
    var stats=main.querySelector(':scope>.grid.g4');if(!h||!stats)return;
    var box=h;while(box.parentElement&&box.parentElement!==main)box=box.parentElement;
    if(box.parentElement===main&&stats.nextElementSibling!==box)stats.after(box);
  }
  function run(){mailRows();collapsibles();manager()}
  var q=false;new MutationObserver(function(){if(q)return;q=true;requestAnimationFrame(function(){q=false;run()})}).observe(document.body,{childList:true,subtree:true});
  run();
})();
