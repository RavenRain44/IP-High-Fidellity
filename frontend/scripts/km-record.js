/* Mockup only: Salesforce-style record page. The key-facts block moves up under the record
   header as a highlights strip. In the real code this is a markup reorder in the profile renderers. */
(function(){
  function arrange(){
    document.querySelectorAll('#app .profile-head').forEach(function(h){
      var box=h.parentElement;if(!box||box.dataset.kmRecord)return;box.dataset.kmRecord='1';box.classList.add('km-record');
      var hl=[].slice.call(box.children).find(function(s){return s.classList.contains('profile-section')&&s.querySelector(':scope>.info-grid')});
      if(hl){hl.classList.add('km-highlights');h.after(hl)}
    });
  }
  var q=false;new MutationObserver(function(){if(q)return;q=true;requestAnimationFrame(function(){q=false;arrange()})}).observe(document.body,{childList:true,subtree:true});
  arrange();
})();
