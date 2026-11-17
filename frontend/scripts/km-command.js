/* Mockup only: Microsoft-style command bar. Each page's own actions move out of the page
   header into one bar under the app bar. Buttons keep their data attributes, so they still work. */
(function(){
  function arrange(){
    var main=document.querySelector('#app .content');if(!main)return;
    var lw=main.querySelector(':scope>.lw-actions'),ctas=main.querySelector(':scope>.page-head .page-ctas');
    if(!lw&&!ctas)return;
    var bar=main.querySelector(':scope>.km-cmdbar');
    if(!bar){bar=document.createElement('div');bar.className='km-cmdbar';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','Commands');main.prepend(bar)}
    if(lw&&lw.parentElement!==bar)[].slice.call(lw.children).forEach(function(b){bar.appendChild(b)}),lw.remove();
    if(ctas&&ctas.children.length)[].slice.call(ctas.children).forEach(function(b){bar.appendChild(b)});
    if(ctas&&!ctas.children.length)ctas.remove();
  }
  var q=false;new MutationObserver(function(){if(q)return;q=true;requestAnimationFrame(function(){q=false;arrange()})}).observe(document.body,{childList:true,subtree:true});
  arrange();
})();
