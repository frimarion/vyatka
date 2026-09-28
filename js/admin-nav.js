/* Левый сайдбар служебных страниц (таймер, расписание, CRM) — как в админке
   Дойла, но в цветах Вятки: тёмная ink-колонка, оранжевый логотип и акцент.
   Работает только при ширине ≥900px; ниже страницы остаются прежними —
   с таббаром внизу и полоской .pagenav под шапкой.

   Своего меню у колонки нет, она зеркалит то, что уже есть на странице:
   - вкладки — кнопки #tabbar (клик по пункту жмёт соответствующую кнопку,
     так что вся логика переключения остаётся в странице). Пока таббар
     спрятан инлайн-стилем (список комнат, вход), вкладок в колонке нет;
   - ссылки — полоска .pagenav (текущая страница — .here). Скрытые ссылки
     (Дисплей до выбора комнаты) не показываются.
   Изменения таббара и полоски отслеживаются MutationObserver'ом.

   Подключается в <head> без defer: стили и отступ под колонку ставятся
   сразу, без прыжка вёрстки, а сама колонка дорисовывается к DOMContentLoaded. */
(function(){
  var ICONS = {
    'Таймер':'<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 3h6"/><path d="M12 3v2"/>',
    'Турнир':'<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/>',
    'Игроки':'<circle cx="8" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 7-7h2"/><circle cx="17" cy="11" r="3"/><path d="M14 21v-1.5a3 3 0 0 1 6 0V21"/>',
    'Оплата':'<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>',
    'Структура':'<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
    'Отчёты':'<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    'Расписание':'<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18"/><path d="M8 2.5v4"/><path d="M16 2.5v4"/><path d="M7.5 13.5h2M11 13.5h2M14.5 13.5h2M7.5 17h2M11 17h2"/>',
    'CRM':'<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>',
    'Дисплей':'<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    'Приложение':'<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>'
  };
  var DOT = '<circle cx="12" cy="12" r="3"/>';

  var css =
    '.anav{display:none;}' +
    '@media (min-width:900px){' +
      ':root{--anav:236px;}' +
      'body{padding-left:var(--anav);}' +
      '.anav{' +
        'display:flex;flex-direction:column;gap:4px;overflow-y:auto;' +
        'position:fixed;top:0;bottom:0;left:0;width:var(--anav);z-index:50;' +
        'padding:22px 0 24px;box-sizing:border-box;' +
        'background:linear-gradient(180deg,#2B2018,#1A130E);' +
        'box-shadow:8px 0 28px rgba(36,27,20,.18);' +
      '}' +
      /* колонка заменяет полоску переходов и логотип в шапке */
      '.pagenav,.apphead .logoLink{display:none !important;}' +
      '.tabbar{display:none !important;}' +
      'body .wrap{padding-bottom:32px;}' +
      '.errToast{left:calc(var(--anav) + 12px);bottom:20px;}' +
      '#btnScrollTop{bottom:20px;}' +
    '}' +
    '.anav-brand{display:block;padding:6px 24px 22px;margin-bottom:8px;border-bottom:1px solid rgba(255,252,244,.08);line-height:0;}' +
    '.anav-brand img{width:100%;height:auto;display:block;}' +
    '.anav-group{display:flex;flex-direction:column;gap:4px;}' +
    '.anav-sections{padding-bottom:10px;margin-bottom:8px;border-bottom:1px solid rgba(255,252,244,.08);}' +
    '.anav-sections:empty{display:none;}' +
    '.anav-item{position:relative;display:flex;align-items:center;gap:14px;height:48px;padding:0 18px;margin:0 12px;' +
      'border:none;background:none;box-shadow:none;cursor:pointer;font:inherit;text-align:left;box-sizing:border-box;' +
      'border-radius:14px;text-decoration:none;color:rgba(255,252,244,.5);transition:color .15s ease,background .15s ease;flex-shrink:0;}' +
    '.anav-item:hover{background:rgba(255,252,244,.06);color:rgba(255,252,244,.85);}' +
    '.anav-item.active{background:rgba(233,83,31,.18);color:#FF8A5C;}' +
    '.anav-item svg{width:21px;height:21px;flex-shrink:0;fill:none;stroke:currentColor;' +
      'stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}' +
    '.anav-label{font-size:14px;font-weight:800;letter-spacing:.01em;white-space:nowrap;}' +
    '.anav-ext{margin-left:auto;font-size:12px;opacity:.6;}';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var esc = function(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  // «Дисплей ↗» → «Дисплей»: стрелка внешней ссылки рисуется отдельно
  var clean = function(s){ return String(s || '').replace(/[↗↩←]/g, '').trim(); };

  function item(tag, attrs, label, active, ext){
    return '<' + tag + ' class="anav-item' + (active ? ' active' : '') + '" ' + attrs +
      (active ? ' aria-current="page"' : '') + '>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[label] || DOT) + '</svg>' +
      '<span class="anav-label">' + esc(label) + '</span>' +
      (ext ? '<span class="anav-ext">↗</span>' : '') + '</' + tag + '>';
  }

  function build(){
    var tabbar = document.getElementById('tabbar');
    var pagenav = document.querySelector('.pagenav');
    var nav = document.createElement('nav');
    nav.className = 'anav';
    nav.setAttribute('aria-label', 'Разделы админки');
    nav.innerHTML = '<a class="anav-brand" href="start.html" title="На главную"><img src="assets/logo.svg" alt="Vyatka Poker Club"></a>' +
      '<div class="anav-group anav-sections"></div><div class="anav-group anav-pages"></div>';
    var secBox = nav.querySelector('.anav-sections'), pageBox = nav.querySelector('.anav-pages');

    function sync(){
      var sec = '';
      if (tabbar && tabbar.style.display !== 'none'){
        tabbar.querySelectorAll('button[data-tab]').forEach(function(b){
          if (b.style.display === 'none') return;
          var ic = b.querySelector('.ic');
          var label = clean(b.textContent.replace(ic ? ic.textContent : '', ''));
          sec += item('button', 'type="button" data-sec="' + esc(b.dataset.tab) + '"', label, b.classList.contains('active'));
        });
      }
      if (secBox.innerHTML !== sec) secBox.innerHTML = sec;

      var pages = '';
      if (pagenav){
        Array.prototype.forEach.call(pagenav.children, function(el){
          if (el.style.display === 'none') return;
          var label = clean(el.textContent);
          // текущая страница: если у неё есть вкладки, они её и представляют
          if (el.tagName !== 'A'){ if (!sec) pages += item('span', '', label, true); return; }
          var blank = el.target === '_blank';
          pages += item('a', 'href="' + esc(el.getAttribute('href')) + '"' + (blank ? ' target="_blank" rel="noopener"' : ''), label, false, blank);
        });
      }
      if (pageBox.innerHTML !== pages) pageBox.innerHTML = pages;
    }

    nav.addEventListener('click', function(e){
      var b = e.target.closest('[data-sec]');
      if (!b || !tabbar) return;
      var src = tabbar.querySelector('button[data-tab="' + b.getAttribute('data-sec') + '"]');
      if (src) src.click();
    });

    sync();
    var mo = new MutationObserver(sync);
    var opts = { attributes:true, attributeFilter:['class','style','href'], subtree:true, childList:true, characterData:true };
    if (tabbar) mo.observe(tabbar, opts);
    if (pagenav) mo.observe(pagenav, opts);
    document.body.insertBefore(nav, document.body.firstChild);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
