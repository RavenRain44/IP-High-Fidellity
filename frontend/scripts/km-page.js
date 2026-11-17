/* Tags <body> with the current page so page-specific styles apply, and resets the Manager View selection on navigation. */
(function(){
  var orig=window.render;
  window.render=function(){
    document.body.setAttribute('data-page',ui.page);
    if(ui.page!=='manager')document.body.classList.remove('km-rep-chosen');
    return orig.apply(this,arguments);
  };
})();
