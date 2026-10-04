// NEON FORSVAR – brugerflade: butik, tårninfo, HUD, dialoger og indstillinger (kun DOM).
(function () {
  'use strict';

  var TD = window.TD = window.TD || {};

  function $(id) { return document.getElementById(id); }

  var actions = {};
  var shopItems = {};
  var last = {};          // senest viste værdier, så DOM kun røres ved ændringer
  var bannerTimer = null;

  var UI = TD.UI = {
    // Læses af TD.Renderer.draw
    state: { hover: null, buildType: null, selected: null },
    dialog: null
  };

  // ---------- Formatering ----------

  function cells(px) { return (px / TD.C.CELL).toFixed(1).replace('.', ',') + ' felter'; }
  function num(n, digits) { return Number(n).toFixed(digits === undefined ? 0 : digits).replace('.', ','); }

  var STAT_ROWS = [
    ['damage', 'Skade', function (v) { return num(v); }],
    ['dps', 'Skade pr. sek.', function (v) { return num(v); }],
    ['fireRate', 'Skud pr. sek.', function (v) { return num(v, 1); }],
    ['range', 'Rækkevidde', cells],
    ['splash', 'Sprængradius', cells],
    ['slow', 'Bremser', function (v) { return num(v * 100) + ' %'; }],
    ['duration', 'Varighed', function (v) { return num(v, 1) + ' s'; }],
    ['chains', 'Lynhop', function (v) { return num(v); }]
  ];

  function statTable(def, levelIndex, showNext) {
    var cur = def.levels[levelIndex];
    var next = showNext ? def.levels[levelIndex + 1] : null;
    var html = '<table>';
    STAT_ROWS.forEach(function (row) {
      var key = row[0];
      if (cur[key] === undefined) return;
      var value = row[2](cur[key]);
      if (next && next[key] !== undefined && next[key] !== cur[key]) {
        value += ' <span class="gain">→ ' + row[2](next[key]) + '</span>';
      }
      html += '<tr><td>' + row[1] + '</td><td>' + value + '</td></tr>';
    });
    return html + '</table>';
  }

  function pips(level) {
    var s = '';
    for (var i = 0; i < 3; i++) s += i <= level ? '◆' : '◇';
    return s;
  }

  function drawIcon(canvas, fnName, typeId, level) {
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try {
      TD.Renderer[fnName](ctx, typeId, canvas.width / 2, canvas.height / 2, canvas.width * 0.8, level || 0);
    } catch (err) {
      // Ikonet er kun pynt – butikken virker uden.
    }
  }

  // ---------- Opbygning ----------

  UI.init = function (handlers) {
    actions = handlers;

    var shop = $('shop');
    TD.DATA.towerOrder.forEach(function (id, i) {
      var def = TD.DATA.towers[id];
      var item = document.createElement('div');
      item.className = 'shop-item';
      item.title = def.desc;
      item.innerHTML =
        '<span class="shop-key">' + (i + 1) + '</span>' +
        '<canvas width="92" height="92"></canvas>' +
        '<span class="shop-name">' + def.name + '</span>' +
        '<span class="shop-cost">' + def.cost + '</span>';
      item.addEventListener('click', function () {
        TD.events.emit('uiClick', {});
        actions.selectBuild(UI.state.buildType === id ? null : id);
      });
      shop.appendChild(item);
      shopItems[id] = item;
      drawIcon(item.querySelector('canvas'), 'drawTowerIcon', id, 0);
    });

    function click(id, fn) {
      $(id).addEventListener('click', function () {
        TD.events.emit('uiClick', {});
        fn();
      });
    }
    click('btn-start-wave', function () { actions.startWave(); });
    click('btn-speed', function () { actions.toggleSpeed(); });
    click('btn-auto', function () { actions.toggleAuto(); });
    click('btn-pause', function () { actions.togglePause(); });
    click('btn-mute', function () { actions.toggleMute(); });

    $('info').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'upgrade') actions.upgrade();
      if (btn.dataset.action === 'sell') actions.sell();
    });

    $('overlay').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action]');
      if (!btn) return;
      TD.events.emit('uiClick', {});
      actions.dialogAction(btn.dataset.action);
    });

    ['master', 'sfx', 'music'].forEach(function (key) {
      $('vol-' + key).addEventListener('input', function (e) {
        actions.setVolume(key, Number(e.target.value) / 100);
      });
    });
    $('vol-muted').addEventListener('change', function (e) {
      actions.setVolume('muted', e.target.checked);
    });
  };

  UI.syncSettings = function (settings) {
    $('vol-master').value = Math.round(settings.master * 100);
    $('vol-sfx').value = Math.round(settings.sfx * 100);
    $('vol-music').value = Math.round(settings.music * 100);
    $('vol-muted').checked = !!settings.muted;
    $('btn-mute').textContent = settings.muted ? 'Lyd: fra' : 'Lyd: til';
  };

  // ---------- Skærme og dialoger ----------

  UI.showScreen = function (name) {
    ['menu', 'map', 'game'].forEach(function (s) {
      $('screen-' + s).classList.toggle('active', s === name);
    });
  };

  UI.showDialog = function (name) {
    UI.dialog = name;
    $('overlay').classList.toggle('hidden', !name);
    ['pause', 'win', 'lose', 'settings', 'help'].forEach(function (d) {
      $('dialog-' + d).classList.toggle('hidden', d !== name);
    });
  };

  UI.showWin = function (stars, text, hasNext) {
    var html = '';
    for (var i = 0; i < 3; i++) html += '<span class="' + (i < stars ? 'on' : '') + '">★</span>';
    $('win-stars').innerHTML = html;
    $('win-text').textContent = text;
    $('dialog-win').querySelector('[data-action="next"]').classList.toggle('hidden', !hasNext);
    UI.showDialog('win');
  };

  UI.showLose = function (text) {
    $('lose-text').textContent = text;
    UI.showDialog('lose');
  };

  UI.banner = function (text, isBoss) {
    var el = $('banner');
    el.textContent = text;
    el.classList.toggle('boss', !!isBoss);
    el.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  };

  UI.showError = function (text) {
    var el = $('error-box');
    el.textContent = text;
    el.classList.remove('hidden');
  };

  UI.setMenuProgress = function (text) { $('menu-progress').textContent = text; };

  // ---------- Opdatering hver frame ----------

  function setText(id, value) {
    if (last[id] !== value) {
      last[id] = value;
      $(id).textContent = value;
    }
  }

  function renderInfo(game) {
    var st = UI.state;
    var html;
    if (st.selected) {
      var t = st.selected;
      var cost = game.upgradeCost(t);
      html = '<h3>' + t.def.name + ' <span class="pips">' + pips(t.level) + '</span></h3>' +
        statTable(t.def, t.level, cost !== null) +
        '<div class="row">' +
        (cost !== null
          ? '<button class="btn primary" data-action="upgrade"' + (game.money < cost ? ' disabled' : '') + '>Opgrader ' + cost + '</button>'
          : '<button class="btn" disabled>Maks. trin</button>') +
        '<button class="btn danger" data-action="sell">Sælg +' + game.sellValue(t) + '</button>' +
        '</div>';
    } else if (st.buildType) {
      var def = TD.DATA.towers[st.buildType];
      html = '<h3>' + def.name + ' – ' + def.cost + ' kreditter</h3>' +
        '<p class="desc">' + def.desc + '</p>' + statTable(def, 0, false);
    } else {
      html = '<h3>Byg dit forsvar</h3><p class="desc">Vælg et tårn ovenfor, og klik på en ledig celle ved ruten. ' +
        'Klik på et bygget tårn for at opgradere eller sælge det.</p>';
    }
    $('info').innerHTML = html;
  }

  function renderNextWave(game) {
    var list = $('next-wave-list');
    var index = game.state === 'wave' ? game.waveIndex + 1 : game.waveIndex;
    var title = $('next-wave').querySelector('h3');
    list.innerHTML = '';
    if (index >= game.waveCount) {
      title.textContent = game.state === 'wave' ? 'Sidste bølge er i gang' : 'Ingen flere bølger';
      return;
    }
    title.textContent = 'Næste bølge (' + (index + 1) + ' af ' + game.waveCount + ')';
    game.wavePreview(index).forEach(function (entry) {
      var def = TD.DATA.enemies[entry.type];
      if (!def) return;
      var el = document.createElement('div');
      el.className = 'wave-entry';
      el.title = def.name;
      el.innerHTML = '<canvas width="52" height="52"></canvas><span><b>' + entry.count + '</b> × ' + def.name + '</span>';
      list.appendChild(el);
      drawIcon(el.querySelector('canvas'), 'drawEnemyIcon', entry.type);
    });
  }

  UI.resetGameView = function () {
    last = {};
    UI.state.hover = null;
    UI.state.buildType = null;
    UI.state.selected = null;
  };

  // flags = { speed, auto, paused }
  UI.refresh = function (game, flags) {
    var st = UI.state;

    setText('hud-level', 'Bane ' + game.level.id + ' · ' + game.level.name);
    setText('hud-lives', String(Math.max(0, game.lives)));
    setText('hud-money', String(Math.floor(game.money)));
    setText('hud-wave', Math.min(game.waveIndex + 1, game.waveCount) + ' / ' + game.waveCount);

    var done = game.state === 'won' ? game.waveCount : game.waveIndex;
    var pct = Math.round(100 * done / game.waveCount) + '%';
    if (last.progress !== pct) {
      last.progress = pct;
      $('wave-progress-fill').style.width = pct;
    }

    var shopSig = st.buildType + '|' + TD.DATA.towerOrder.map(function (id) {
      return game.money >= TD.DATA.towers[id].cost ? '1' : '0';
    }).join('');
    if (last.shop !== shopSig) {
      last.shop = shopSig;
      TD.DATA.towerOrder.forEach(function (id) {
        shopItems[id].classList.toggle('selected', st.buildType === id);
        shopItems[id].classList.toggle('poor', game.money < TD.DATA.towers[id].cost);
      });
    }

    var infoSig;
    if (st.selected) {
      var cost = game.upgradeCost(st.selected);
      infoSig = 't' + st.selected.id + ':' + st.selected.level + ':' + (cost !== null && game.money >= cost);
    } else {
      infoSig = 'b' + st.buildType;
    }
    if (last.info !== infoSig) {
      last.info = infoSig;
      renderInfo(game);
    }

    var waveSig = game.state + ':' + game.waveIndex;
    if (last.wave !== waveSig) {
      last.wave = waveSig;
      renderNextWave(game);
      $('btn-start-wave').disabled = game.state !== 'build';
    }

    setText('btn-speed', flags.speed + '×');
    setText('btn-auto', flags.auto ? 'Auto: til' : 'Auto: fra');
    if (last.auto !== flags.auto) {
      last.auto = flags.auto;
      $('btn-auto').classList.toggle('active', flags.auto);
    }
  };
})();
