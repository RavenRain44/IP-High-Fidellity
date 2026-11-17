/* Mockup only: the dashboard's sections go into two independent columns so short boxes
   no longer leave holes. In the real code this is two column wrappers in the dashboard markup. */
(function(){
  function title(el){var h=el.querySelector('h2');return h?h.textContent.trim():''}
  function arrange(){
    if(typeof ui==='undefined'||ui.page!=='dashboard')return;
    var main=document.querySelector('#app main.content')||document.querySelector('#app .content');
    if(!main||main.querySelector(':scope>.km-dash'))return;
    var items=[],seq=0;
    [].slice.call(main.children).forEach(function(c){
      if(c.classList.contains('footer-note'))return;
      if(c.classList.contains('attention-split')||c.classList.contains('split')||c.classList.contains('lw-stack')){[].slice.call(c.children).forEach(function(k){items.push(k)})}
      else items.push(c);
    });
    if(!items.length)return;
    var LEFT=/^(Needs Attention|Open Promises|Before Your Meeting|Your five priorities)/;
    var dash=document.createElement('div');dash.className='km-dash';
    var l=document.createElement('div'),r=document.createElement('div');l.className=r.className='km-col';
    dash.appendChild(l);dash.appendChild(r);
    main.prepend(dash);
    items.forEach(function(it){it.style.order=String(seq++);(it.classList.contains('hero')||LEFT.test(title(it))?l:r).appendChild(it)});
    [].slice.call(main.children).forEach(function(c){if(c!==dash&&!c.classList.contains('footer-note')&&!c.children.length&&!c.textContent.trim())c.remove()});
    var foot=main.querySelector(':scope>.footer-note');if(foot)main.appendChild(foot);
  }
  var q=false;new MutationObserver(function(){if(q)return;q=true;requestAnimationFrame(function(){q=false;arrange()})}).observe(document.body,{childList:true,subtree:true});
  arrange();
})();
