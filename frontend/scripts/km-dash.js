/* Mockup only: the dashboard's sections go into independent columns so short boxes
   no longer leave holes. Two columns normally; on ultrawide screens (1800px+) a third
   column opens so more of the dashboard is visible without scrolling. In the real code
   this is column wrappers in the dashboard markup. */
(function(){
  var WIDE=window.matchMedia('(min-width:1800px)');
  var LEFT=/^(Needs Attention|Open Promises|Before Your Meeting|Your five priorities)/;
  /* In three-column mode these move into the middle column, leaving Capture and the rest on the right. */
  var MID=/^(Before Your Meeting|Your five priorities|Smart Email|Relationship Snapshots)/;
  function title(el){var h=el.querySelector('h2');return h?h.textContent.trim():''}
  function place(dash){
    var wide=WIDE.matches,cols=dash.children;
    dash.classList.toggle('wide',wide);
    dash._items.forEach(function(it){
      var t=title(it),col=it.classList.contains('hero')||(LEFT.test(t)&&!(wide&&MID.test(t)))?0:(wide&&MID.test(t)?1:2);
      cols[col].appendChild(it);
    });
  }
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
    var dash=document.createElement('div');dash.className='km-dash';
    ['km-col','km-col km-col-mid','km-col'].forEach(function(cls){var c=document.createElement('div');c.className=cls;dash.appendChild(c)});
    items.forEach(function(it){it.style.order=String(seq++)});
    dash._items=items;
    main.prepend(dash);
    place(dash);
    [].slice.call(main.children).forEach(function(c){if(c!==dash&&!c.classList.contains('footer-note')&&!c.children.length&&!c.textContent.trim())c.remove()});
    var foot=main.querySelector(':scope>.footer-note');if(foot)main.appendChild(foot);
  }
  WIDE.addEventListener('change',function(){var d=document.querySelector('.km-dash');if(d&&d._items)place(d)});
  var q=false;new MutationObserver(function(){if(q)return;q=true;requestAnimationFrame(function(){q=false;arrange()})}).observe(document.body,{childList:true,subtree:true});
  arrange();
})();
