/* LLM 모델 대시보드 — 순수 JavaScript (빌드 없음) */
(function () {
  'use strict';

  // 고정 순서 = 제공사 식별색 순서 (필터가 바뀌어도 색이 바뀌지 않음)
  var PROVIDER_ORDER = ['OpenAI', 'Anthropic', 'Google', 'Meta', 'xAI', 'DeepSeek', 'Mistral', 'Qwen (Alibaba)'];
  var VARIANT_LABEL = { batch: 'Batch', free: '무료', extended: '확장', thinking: 'Thinking', beta: 'Beta', nitro: 'Nitro', floor: 'Floor', online: 'Online' };
  var LATEST_COUNT = 8;
  var PAGE_SIZE = window.matchMedia && matchMedia('(max-width: 720px)').matches ? 20 : 60;
  var NEW_DAYS = 30;

  var state = {
    models: [],
    meta: null,
    bench: null,
    sortKey: 'created',
    sortDir: 'desc',
    search: '',
    provider: '',
    limit: PAGE_SIZE,
    chartPer: 2,
    chart: null,
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 포맷 ---------- */
  var intFmt = new Intl.NumberFormat('ko-KR');
  function fmtPrice(n) {
    if (n === null || n === undefined || !isFinite(n)) return '–';
    if (n === 0) return '무료';
    var digits = n < 0.01 ? 4 : n < 0.1 ? 3 : 2;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
  }
  function fmtInt(n) { return n === null || n === undefined || !isFinite(n) ? '–' : intFmt.format(n); }
  function fmtCtx(n) { return n ? fmtInt(n) : '–'; }
  function fmtCtxShort(n) {
    if (!n) return '–';
    if (n >= 1e6) return Math.round(n / 1e5) / 10 + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return fmtInt(n);
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : null; }
  function daysSince(dateStr) {
    if (!dateStr) return Infinity;
    return (Date.now() - new Date(dateStr + 'T00:00:00+09:00').getTime()) / 86400000;
  }
  function providerHtml(p) { return '<span class="provider" data-p="' + esc(p) + '">' + esc(p) + '</span>'; }
  function byNewest(a, b) { return String(b.created || '').localeCompare(String(a.created || '')); }

  /* ---------- 변형(batch 등) ---------- */
  function variantLabel(v) { return VARIANT_LABEL[v.type] || v.type; }
  function variantBadges(m) {
    return (m.variants || []).map(function (v) {
      var label = variantLabel(v);
      var off = m.outputPrice > 0 && v.outputPrice > 0 ? Math.round((1 - v.outputPrice / m.outputPrice) * 100) : 0;
      var text = v.type === 'free' ? '무료 버전' : label + (off > 0 ? ' −' + off + '%' : '');
      var title = label + ' 변형 (' + v.id + '): 입력 ' + fmtPrice(v.inputPrice) + ' / 출력 ' + fmtPrice(v.outputPrice) + ' per 1M';
      return '<span class="badge badge-variant" title="' + esc(title) + '">' + esc(text) + '</span>';
    }).join('');
  }
  function variantPriceLine(m, field) {
    var v = (m.variants || []).filter(function (x) { return x.type !== 'free'; })[0];
    if (!v) return '';
    return '<span class="price-sub">' + esc(variantLabel(v)) + ' ' + fmtPrice(v[field]) + '</span>';
  }

  /* ---------- 데이터 로드 ---------- */
  function loadJson(path) {
    return fetch(path, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(path + ' (HTTP ' + r.status + ')');
      return r.json();
    });
  }

  function init() {
    setupTheme();
    Promise.allSettled([loadJson('data/models.json'), loadJson('data/meta.json'), loadJson('data/benchmarks.json')])
      .then(function (res) {
        var errors = [];
        if (res[0].status === 'fulfilled' && Array.isArray(res[0].value.models)) state.models = res[0].value.models;
        else errors.push('모델 데이터');
        if (res[1].status === 'fulfilled') state.meta = res[1].value; else errors.push('메타 정보');
        if (res[2].status === 'fulfilled') state.bench = res[2].value; else errors.push('벤치마크 데이터');

        if (errors.length) {
          var el = $('load-error');
          el.textContent = errors.join(', ') + '를 불러오지 못했습니다. ' +
            (location.protocol === 'file:' ? '파일을 직접 열면 브라우저가 JSON 로드를 막습니다. README의 로컬 실행 방법(간단한 웹 서버)을 참고하세요.' : '잠시 후 다시 시도해 주세요.');
          el.hidden = false;
        }
        renderMeta();
        renderKpis();
        renderShare();
        renderLatest();
        setupTable();
        renderTable();
        setupChart();
        renderBench();
      });
  }

  /* ---------- 테마 ---------- */
  function systemDark() { return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); }
  function effectiveTheme() {
    return document.documentElement.getAttribute('data-theme') || (systemDark() ? 'dark' : 'light');
  }
  function updateThemeButton() {
    var label = effectiveTheme() === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환';
    $('theme-toggle').setAttribute('aria-label', label);
    $('theme-toggle').title = label;
  }
  function setupTheme() {
    updateThemeButton();
    $('theme-toggle').addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      // 시스템 설정과 같아지면 강제값을 지우고 다시 시스템을 따름
      if ((next === 'dark') === systemDark()) {
        document.documentElement.removeAttribute('data-theme');
        try { localStorage.removeItem('theme'); } catch (e) {}
      } else {
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) {}
      }
      updateThemeButton();
      renderChart(true);
    });
    if (window.matchMedia) {
      var mq = matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { updateThemeButton(); renderChart(true); };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ---------- (1) 상단: 메타·지표·제공사 비중 ---------- */
  function renderMeta() {
    var m = state.meta;
    $('meta-updated').textContent = m && m.lastUpdatedKST ? m.lastUpdatedKST : '–';
    if (m && m.lastUpdated) $('meta-updated').setAttribute('title', m.lastUpdated);
    var sources = (m && m.sources) || [];
    if (sources.length) {
      var html = sources.map(function (s) {
        var u = safeUrl(s.docs || s.url);
        return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(s.name) + '</a>' : esc(s.name);
      }).join(', ');
      $('meta-source').innerHTML = html;
      $('footer-sources').innerHTML = html;
    }
    $('sample-banner').hidden = !(m && m.isSample);
  }

  function kpi(label, value, sub) {
    return '<div class="kpi"><span class="kpi-label">' + esc(label) + '</span><span class="kpi-value">' + value + '</span>' +
      (sub ? '<span class="kpi-sub" title="' + esc(sub) + '">' + esc(sub) + '</span>' : '') + '</div>';
  }
  function renderKpis() {
    var ms = state.models;
    if (!ms.length) return;
    var providers = {};
    ms.forEach(function (m) { providers[m.provider] = true; });
    var recent = ms.filter(function (m) { return daysSince(m.created) <= NEW_DAYS; }).length;
    var paid = ms.filter(function (m) { return m.inputPrice > 0; });
    var cheapest = paid.slice().sort(function (a, b) { return a.inputPrice - b.inputPrice || byNewest(a, b); })[0];
    var longest = ms.slice().sort(function (a, b) { return (b.contextLength || 0) - (a.contextLength || 0) || byNewest(a, b); })[0];
    $('kpis').innerHTML =
      kpi('추적 중인 모델', fmtInt(ms.length) + '<small>개</small>', Object.keys(providers).length + '개 제공사') +
      kpi('최근 30일 신규', fmtInt(recent) + '<small>개</small>', '등록일 기준') +
      kpi('최저 입력가 /1M', cheapest ? esc(fmtPrice(cheapest.inputPrice)) : '–', cheapest ? cheapest.name : '') +
      kpi('최장 컨텍스트', longest ? esc(fmtCtxShort(longest.contextLength)) + '<small>토큰</small>' : '–', longest ? longest.name : '');
  }

  function orderedProviders() {
    var list = PROVIDER_ORDER.filter(function (p) { return state.models.some(function (m) { return m.provider === p; }); });
    state.models.forEach(function (m) { if (list.indexOf(m.provider) < 0) list.push(m.provider); });
    return list;
  }
  function countBy(p) { return state.models.filter(function (m) { return m.provider === p; }).length; }

  function renderShare() {
    var total = state.models.length;
    if (!total) return;
    var ps = orderedProviders();
    $('share-bar').innerHTML = ps.map(function (p) {
      var n = countBy(p);
      return '<span class="share-seg" data-p="' + esc(p) + '" style="flex:' + n + '" title="' + esc(p + ' ' + n + '개') + '"></span>';
    }).join('');
    $('share-bar').setAttribute('aria-label', '제공사별 모델 수: ' + ps.map(function (p) { return p + ' ' + countBy(p) + '개'; }).join(', '));
    $('share-legend').innerHTML = ps.map(function (p) {
      return '<li>' + providerHtml(p) + '<b>' + countBy(p) + '</b></li>';
    }).join('');
    $('share').hidden = false;
  }

  /* ---------- (2) 최신 모델 ---------- */
  function renderLatest() {
    var list = state.models.slice().sort(byNewest).slice(0, LATEST_COUNT);
    if (!list.length) { $('latest-cards').innerHTML = '<p class="muted">표시할 모델이 없습니다.</p>'; return; }
    $('latest-cards').innerHTML = list.map(function (m) {
      var isNew = daysSince(m.created) <= NEW_DAYS;
      var badges = (isNew ? '<span class="badge badge-new">NEW</span>' : '') + variantBadges(m);
      return '<article class="model-card" data-p="' + esc(m.provider) + '">' +
        '<div class="card-top">' +
          '<span class="card-who"><span class="avatar" aria-hidden="true">' + esc(m.provider.charAt(0)) + '</span>' + esc(m.provider) + '</span>' +
          '<span class="date">' + esc(m.created || '') + '</span>' +
        '</div>' +
        '<div><h3>' + esc(m.name) + '</h3><div class="model-id">' + esc(m.id) + '</div></div>' +
        (badges ? '<div class="badges">' + badges + '</div>' : '') +
        (m.description ? '<p class="desc" lang="en">' + esc(m.description) + '</p>' : '') +
        '<dl class="stats">' +
          '<div><dt>입력 /1M</dt><dd>' + fmtPrice(m.inputPrice) + '</dd></div>' +
          '<div><dt>출력 /1M</dt><dd>' + fmtPrice(m.outputPrice) + '</dd></div>' +
          '<div><dt>컨텍스트</dt><dd title="' + esc(fmtCtx(m.contextLength)) + ' 토큰">' + fmtCtxShort(m.contextLength) + '</dd></div>' +
        '</dl>' +
      '</article>';
    }).join('');
  }

  /* ---------- (3) 가격 비교표 ---------- */
  function setupTable() {
    var chips = '<button type="button" class="chip" data-value="" aria-pressed="true">전체 <span class="count">' + fmtInt(state.models.length) + '</span></button>' +
      orderedProviders().map(function (p) {
        return '<button type="button" class="chip" data-p="' + esc(p) + '" data-value="' + esc(p) + '" aria-pressed="false">' +
          esc(p) + ' <span class="count">' + countBy(p) + '</span></button>';
      }).join('');
    $('provider-chips').innerHTML = chips;
    $('provider-chips').addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      state.provider = btn.getAttribute('data-value');
      state.limit = PAGE_SIZE;
      $('provider-chips').querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c === btn)); });
      renderTable();
    });

    var timer;
    $('search').addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () { state.search = e.target.value.trim().toLowerCase(); state.limit = PAGE_SIZE; renderTable(); }, 120);
    });

    document.querySelectorAll('#price-table th[data-key] button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.parentElement.getAttribute('data-key');
        if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = key; state.sortDir = (key === 'created' || key === 'contextLength') ? 'desc' : 'asc'; }
        syncMobileSort();
        renderTable();
      });
    });
    $('mobile-sort').addEventListener('change', function (e) {
      var parts = e.target.value.split(':');
      state.sortKey = parts[0]; state.sortDir = parts[1];
      renderTable();
    });
    $('show-more').addEventListener('click', function () { state.limit += PAGE_SIZE; renderTable(); });
  }

  function syncMobileSort() {
    var v = state.sortKey + ':' + state.sortDir;
    var sel = $('mobile-sort');
    var has = Array.prototype.some.call(sel.options, function (o) { return o.value === v; });
    if (!has) {
      var o = document.createElement('option');
      o.value = v; o.textContent = '사용자 지정';
      sel.appendChild(o);
    }
    sel.value = v;
  }

  function compare(a, b, key, dir) {
    var va = a[key], vb = b[key];
    var na = va === null || va === undefined || va === '';
    var nb = vb === null || vb === undefined || vb === '';
    if (na && nb) return 0;
    if (na) return 1; // 빈 값은 항상 뒤로
    if (nb) return -1;
    var r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ko');
    return dir === 'asc' ? r : -r;
  }

  function filteredModels() {
    var q = state.search;
    return state.models.filter(function (m) {
      if (state.provider && m.provider !== state.provider) return false;
      if (q && (m.name + ' ' + m.id).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) {
      return compare(a, b, state.sortKey, state.sortDir) || compare(a, b, 'name', 'asc');
    });
  }

  function renderTable() {
    var rows = filteredModels();
    document.querySelectorAll('#price-table th[data-key]').forEach(function (th) {
      if (th.getAttribute('data-key') === state.sortKey) th.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
    $('result-count').textContent = '총 ' + fmtInt(rows.length) + '개 모델' + (rows.length > state.limit ? ' 중 ' + fmtInt(state.limit) + '개 표시' : '');
    var shown = rows.slice(0, state.limit);
    $('price-tbody').innerHTML = shown.length ? shown.map(function (m) {
      return '<tr>' +
        '<td class="cell-provider span-2" data-label="제공사">' + providerHtml(m.provider) + '</td>' +
        '<td class="cell-model span-2" data-label="모델명"><span class="name">' + esc(m.name) + '</span>' + variantBadges(m) +
          '<span class="model-id">' + esc(m.id) + '</span></td>' +
        '<td class="num" data-label="입력가 (/1M)"><span class="price">' + fmtPrice(m.inputPrice) + '</span>' + variantPriceLine(m, 'inputPrice') + '</td>' +
        '<td class="num" data-label="출력가 (/1M)"><span class="price">' + fmtPrice(m.outputPrice) + '</span>' + variantPriceLine(m, 'outputPrice') + '</td>' +
        '<td class="num" data-label="컨텍스트 (토큰)">' + fmtCtx(m.contextLength) + '</td>' +
        '<td class="num" data-label="등록일">' + esc(m.created || '–') + '</td>' +
      '</tr>';
    }).join('') : '<tr class="empty-row"><td colspan="6">조건에 맞는 모델이 없습니다.</td></tr>';
    $('show-more').hidden = rows.length <= state.limit;
  }

  /* ---------- (4) 차트 ---------- */
  function setupChart() {
    document.querySelectorAll('.seg button[data-per]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.chartPer = Number(btn.getAttribute('data-per'));
        document.querySelectorAll('.seg button[data-per]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        renderChart();
      });
    });
    ['chart-sort', 'chart-log'].forEach(function (id) { $(id).addEventListener('change', function () { renderChart(); }); });
    var resizeTimer;
    window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { renderChart(); }, 200); });
    renderChart();
  }

  function chartModels() {
    var picked = [];
    PROVIDER_ORDER.forEach(function (p) {
      state.models.filter(function (m) { return m.provider === p && m.inputPrice > 0 && m.outputPrice > 0; })
        .sort(byNewest)
        .slice(0, state.chartPer)
        .forEach(function (m) { picked.push(m); });
    });
    var sort = $('chart-sort').value;
    if (sort === 'output') picked.sort(function (a, b) { return b.outputPrice - a.outputPrice; });
    if (sort === 'input') picked.sort(function (a, b) { return b.inputPrice - a.inputPrice; });
    return picked;
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  var lastChartKey = '';
  function renderChart(force) {
    if (!window.Chart) {
      if (document.readyState === 'complete') { $('chart-fallback').hidden = false; $('chart-box').hidden = true; }
      return;
    }
    var models = chartModels();
    var mobile = window.innerWidth <= 720;
    var key = [models.length, state.chartPer, $('chart-sort').value, $('chart-log').checked, effectiveTheme(), mobile].join('|');
    if (!force && key === lastChartKey && state.chart) return;
    lastChartKey = key;

    $('chart-box').style.height = Math.max(240, models.length * (mobile ? 40 : 36) + 60) + 'px';
    var log = $('chart-log').checked;
    var text2 = cssVar('--text-2'), grid = cssVar('--grid'), surface = cssVar('--surface');
    var font = { family: getComputedStyle(document.body).fontFamily };

    var data = {
      labels: models.map(function (m) { return mobile && m.name.length > 22 ? m.name.slice(0, 21) + '…' : m.name; }),
      datasets: [
        { label: '입력가', data: models.map(function (m) { return m.inputPrice; }), backgroundColor: cssVar('--series-input') },
        { label: '출력가', data: models.map(function (m) { return m.outputPrice; }), backgroundColor: cssVar('--series-output') },
      ],
    };
    data.datasets.forEach(function (d) {
      d.borderRadius = 4; d.borderSkipped = 'start'; d.borderWidth = 0;
      d.barPercentage = 0.82; d.categoryPercentage = 0.72; d.maxBarThickness = 14;
    });

    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('price-chart'), {
      type: 'bar',
      data: data,
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false, axis: 'y' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: surface, titleColor: cssVar('--text'), bodyColor: text2,
            borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 12, boxPadding: 4, cornerRadius: 10,
            titleFont: font, bodyFont: font,
            callbacks: {
              title: function (items) { var m = models[items[0].dataIndex]; return m.name + ' · ' + m.provider; },
              label: function (c) { return ' ' + c.dataset.label + ': ' + fmtPrice(c.raw) + ' / 1M 토큰'; },
            },
          },
        },
        scales: {
          x: {
            type: log ? 'logarithmic' : 'linear',
            beginAtZero: !log,
            grid: { color: grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: text2, padding: 6, maxTicksLimit: mobile ? 5 : 8, font: font,
              callback: function (v) {
                if (log) { var e = Math.log10(v); if (Math.abs(e - Math.round(e)) > 1e-9) return ''; }
                return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
              },
            },
            title: { display: !mobile, text: 'USD / 1M 토큰', color: text2, font: font },
          },
          y: {
            grid: { display: false },
            border: { color: cssVar('--border-strong') },
            ticks: { color: text2, autoSkip: false, font: { family: font.family, size: mobile ? 11 : 12 } },
          },
        },
      },
    });
  }
  window.addEventListener('load', function () { if (!state.chart) renderChart(); });

  /* ---------- (5) 벤치마크 ---------- */
  function renderBench() {
    var b = state.bench;
    var defs = (b && Array.isArray(b.benchmarks)) ? b.benchmarks : [];
    var entries = (b && Array.isArray(b.entries)) ? b.entries : [];

    // 열별 최고점
    var best = {};
    defs.forEach(function (d) {
      entries.forEach(function (e) {
        var v = e.scores && e.scores[d.key];
        if (typeof v === 'number' && isFinite(v) && (best[d.key] === undefined || v > best[d.key])) best[d.key] = v;
      });
    });

    $('bench-thead').innerHTML = '<tr><th scope="col">모델</th><th scope="col">설명</th>' +
      defs.map(function (d) { return '<th scope="col" class="num" title="' + esc(d.description || '') + '">' + esc(d.name) + '</th>'; }).join('') +
      '<th scope="col" class="num">기준일</th><th scope="col">출처</th></tr>';

    if (!entries.length) {
      $('bench-tbody').innerHTML = '<tr class="empty-row"><td colspan="' + (defs.length + 4) + '">등록된 벤치마크가 없습니다.</td></tr>';
    } else {
      $('bench-tbody').innerHTML = entries.map(function (e) {
        var scores = e.scores || {};
        var url = safeUrl(e.sourceUrl);
        var price = state.models.find(function (m) { return m.id === e.modelId; });
        return '<tr>' +
          '<td class="cell-model span-2" data-label="모델">' + (e.provider ? providerHtml(e.provider) : '') +
            '<span class="name" style="display:block;margin-top:2px">' + esc(e.modelName || e.modelId) + '</span>' +
            (price ? '<span class="model-id">입력 ' + fmtPrice(price.inputPrice) + ' · 출력 ' + fmtPrice(price.outputPrice) + ' /1M</span>' : '') +
          '</td>' +
          '<td class="bench-summary span-2" data-label="설명">' + esc(e.summary || '') +
            (e.note ? '<span class="bench-note">' + esc(e.note) + '</span>' : '') + '</td>' +
          defs.map(function (d) {
            var v = scores[d.key];
            if (!(typeof v === 'number' && isFinite(v))) {
              return '<td class="num" data-label="' + esc(d.name) + '"><span class="score-empty" title="미입력">–</span></td>';
            }
            var isBest = best[d.key] === v && entries.filter(function (x) { return x.scores && typeof x.scores[d.key] === 'number'; }).length > 1;
            var pct = d.unit === '%' ? Math.max(0, Math.min(100, v)) : 100 * v / best[d.key];
            return '<td class="num" data-label="' + esc(d.name) + '"><span class="score' + (isBest ? ' is-best' : '') + '">' +
              '<span class="score-val">' + (isBest ? '<span class="best-chip">최고</span> ' : '') +
                esc(v.toLocaleString('en-US', { maximumFractionDigits: 1 })) + (d.unit ? '<small>' + esc(d.unit) + '</small>' : '') + '</span>' +
              '<span class="meter" aria-hidden="true"><i style="width:' + pct.toFixed(1) + '%"></i></span>' +
            '</span></td>';
          }).join('') +
          '<td class="num" data-label="기준일">' + esc(e.asOf || '–') + '</td>' +
          '<td data-label="출처">' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">출처 보기 ↗</a>' : '–') + '</td>' +
        '</tr>';
      }).join('');
    }

    $('bench-defs').innerHTML = defs.map(function (d) {
      var u = safeUrl(d.url);
      return '<li><strong>' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(d.name) + '</a>' : esc(d.name)) + '</strong> — ' + esc(d.description || '') + '</li>';
    }).join('');
    if (b && b.updatedAt) $('bench-desc').insertAdjacentHTML('beforeend', ' (파일 수정일: ' + esc(b.updatedAt) + ')');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
