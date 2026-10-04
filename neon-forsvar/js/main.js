// NEON FORSVAR – samler det hele: skærme, spil-løkke, input og gemt fremskridt.
(function () {
  'use strict';

  var TD = window.TD;
  var UI = TD.UI;

  function $(id) { return document.getElementById(id); }

  var screen = 'menu';
  var game = null;
  var levelIndex = 0;
  var speed = 1;
  var auto = false;
  var paused = false;
  var autoTimer = 0;
  var endTimer = null;
  var music = 'menu';
  var audioReady = false;
  var lastFrame = 0;

  // ---------- Fejlvisning ----------

  window.addEventListener('error', function (e) {
    UI.showError('Der opstod en fejl: ' + e.message + '\n' + (e.filename || '') + ':' + (e.lineno || ''));
  });

  // ---------- Skalering til vinduet ----------

  function fit() {
    var scale = Math.min(window.innerWidth / TD.C.APP_W, window.innerHeight / TD.C.APP_H);
    $('app').style.transform = 'scale(' + scale + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // ---------- Lyd ----------

  function applyVolumes() {
    if (audioReady) TD.Audio.setVolumes(TD.Save.data.settings);
    UI.syncSettings(TD.Save.data.settings);
  }

  function setMusic(name) {
    music = name;
    if (audioReady) TD.Audio.setMusic(name);
  }

  // Browsere tillader først lyd efter et klik eller tastetryk.
  function unlockAudio() {
    if (audioReady) return;
    try {
      TD.Audio.init();
      audioReady = true;
      TD.Audio.setVolumes(TD.Save.data.settings);
      TD.Audio.setMusic(music);
    } catch (err) {
      console.error('Lyden kunne ikke startes:', err);
    }
  }
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  // ---------- Skærme ----------

  function progressText() {
    var total = TD.DATA.levels.length;
    var cleared = 0;
    var stars = 0;
    for (var i = 0; i < total; i++) {
      var s = TD.Save.data.stars[i] || 0;
      if (s > 0) cleared++;
      stars += s;
    }
    if (cleared === 0) return 'Ingen baner klaret endnu – ' + total + ' venter';
    return cleared + ' af ' + total + ' baner klaret · ' + stars + ' af ' + (total * 3) + ' stjerner';
  }

  function goMenu() {
    game = null;
    screen = 'menu';
    UI.showDialog(null);
    UI.setMenuProgress(progressText());
    UI.showScreen('menu');
    setMusic('menu');
  }

  function goMap() {
    game = null;
    screen = 'map';
    clearTimeout(endTimer);
    UI.showDialog(null);
    TD.MapScreen.setProgress({
      unlocked: Math.min(TD.Save.data.unlocked, TD.DATA.levels.length),
      stars: TD.Save.data.stars
    });
    UI.showScreen('map');
    setMusic('menu');
  }

  function startLevel(index) {
    levelIndex = index;
    clearTimeout(endTimer);
    game = new TD.Game(TD.DATA.levels[index]);
    paused = false;
    autoTimer = 0;
    screen = 'game';
    UI.resetGameView();
    UI.showDialog(null);
    UI.showScreen('game');
    TD.Renderer.reset(game);
    setMusic('battle');
    UI.banner(game.level.name, false);
  }

  // ---------- Spilhandlinger ----------

  function selectBuild(typeId) {
    UI.state.buildType = typeId;
    if (typeId) UI.state.selected = null;
  }

  function startWave() {
    if (game && !paused && game.state === 'build') game.startNextWave();
  }

  function toggleSpeed() { speed = speed >= 3 ? 1 : speed + 1; }
  function toggleAuto() { auto = !auto; autoTimer = 0; }

  function togglePause() {
    if (!game || game.state === 'won' || game.state === 'lost') return;
    if (UI.dialog === 'pause') {
      paused = false;
      UI.showDialog(null);
    } else if (!UI.dialog) {
      paused = true;
      UI.showDialog('pause');
    }
  }

  function toggleMute() { setVolume('muted', !TD.Save.data.settings.muted); }

  function setVolume(key, value) {
    TD.Save.data.settings[key] = value;
    TD.Save.save();
    applyVolumes();
  }

  function upgrade() {
    var t = UI.state.selected;
    if (!game || !t) return;
    if (!game.upgrade(t)) TD.events.emit('uiError', {});
  }

  function sell() {
    var t = UI.state.selected;
    if (!game || !t) return;
    game.sell(t);
    UI.state.selected = null;
  }

  var settingsFrom = null;   // dialogen der skal vises igen, når indstillinger lukkes

  function dialogAction(name) {
    switch (name) {
      case 'resume': togglePause(); break;
      case 'restart': startLevel(levelIndex); break;
      case 'map': goMap(); break;
      case 'next': startLevel(Math.min(levelIndex + 1, TD.DATA.levels.length - 1)); break;
      case 'settings': settingsFrom = UI.dialog; UI.showDialog('settings'); break;
      case 'close-settings': UI.showDialog(settingsFrom); settingsFrom = null; break;
      case 'close-help': UI.showDialog(null); break;
      case 'reset-save':
        if (window.confirm('Vil du slette alt fremskridt og starte forfra?')) {
          var settings = TD.Save.data.settings;
          TD.Save.reset();
          TD.Save.data.settings = settings;
          TD.Save.save();
          settingsFrom = null;
          goMenu();
        }
        break;
    }
  }

  // ---------- Hændelser fra spillet ----------

  TD.events.on('waveStart', function (e) {
    UI.banner('Bølge ' + (e.index + 1), false);
  });

  TD.events.on('bossSpawn', function (e) {
    UI.banner(e && e.surprise ? 'Overraskelse! ' + e.name + '!' : 'Boss på vej!', true);
    setMusic('boss');
  });

  TD.events.on('waveEnd', function () {
    if (music === 'boss') setMusic('battle');
  });

  TD.events.on('win', function (e) {
    var lives = e.lives !== undefined ? e.lives : game.lives;
    var maxLives = e.maxLives || game.maxLives || lives;
    var stars = lives >= maxLives ? 3 : (lives >= maxLives / 2 ? 2 : 1);
    var data = TD.Save.data;
    data.stars[levelIndex] = Math.max(data.stars[levelIndex] || 0, stars);
    data.unlocked = Math.max(data.unlocked, Math.min(levelIndex + 2, TD.DATA.levels.length));
    TD.Save.save();

    var isLast = levelIndex >= TD.DATA.levels.length - 1;
    var text = isLast
      ? 'Du har klaret alle ' + TD.DATA.levels.length + ' baner og reddet galaksen!'
      : 'Du har ' + lives + ' af ' + maxLives + ' liv tilbage. Næste bane er låst op.';
    endTimer = setTimeout(function () { UI.showWin(stars, text, !isLast); }, 1400);
  });

  TD.events.on('lose', function () {
    var wave = game ? game.waveIndex + 1 : 1;
    var count = game ? game.waveCount : 1;
    endTimer = setTimeout(function () {
      UI.showLose('Fjenderne brød igennem i bølge ' + wave + ' af ' + count + '. Prøv en anden opstilling.');
    }, 1400);
  });

  // ---------- Mus på spilfeltet ----------

  var field = $('field');

  function cellFromEvent(e) {
    var rect = field.getBoundingClientRect();
    var x = (e.clientX - rect.left) * TD.C.FIELD_W / rect.width;
    var y = (e.clientY - rect.top) * TD.C.FIELD_H / rect.height;
    var cx = Math.floor(x / TD.C.CELL);
    var cy = Math.floor(y / TD.C.CELL);
    if (cx < 0 || cy < 0 || cx >= TD.C.COLS || cy >= TD.C.ROWS) return null;
    return { cx: cx, cy: cy };
  }

  field.addEventListener('mousemove', function (e) { UI.state.hover = cellFromEvent(e); });
  field.addEventListener('mouseleave', function () { UI.state.hover = null; });

  field.addEventListener('click', function (e) {
    if (!game || paused || game.state === 'won' || game.state === 'lost') return;
    var cell = cellFromEvent(e);
    if (!cell) return;
    var st = UI.state;

    if (st.buildType) {
      if (game.canBuild(cell.cx, cell.cy) && game.build(st.buildType, cell.cx, cell.cy)) {
        // Valget beholdes, så man kan bygge flere af samme slags i træk.
      } else {
        TD.events.emit('uiError', {});
      }
      return;
    }

    var tower = game.towerAt(cell.cx, cell.cy);
    st.selected = tower && tower !== st.selected ? tower : null;
    if (tower) TD.events.emit('uiClick', {});
  });

  field.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    UI.state.buildType = null;
    UI.state.selected = null;
  });

  // ---------- Tastatur ----------

  window.addEventListener('keydown', function (e) {
    if (screen !== 'game' || !game) return;
    var key = e.key.toLowerCase();

    if (key === 'escape') {
      if (UI.state.buildType || UI.state.selected) {
        UI.state.buildType = null;
        UI.state.selected = null;
      } else {
        togglePause();
      }
      return;
    }
    if (key === 'p') { togglePause(); return; }
    if (key === 'm') { toggleMute(); return; }
    if (UI.dialog) return;

    if (key >= '1' && key <= '9') {
      var id = TD.DATA.towerOrder[Number(key) - 1];
      if (id) selectBuild(UI.state.buildType === id ? null : id);
    } else if (key === ' ') {
      e.preventDefault();
      startWave();
    } else if (key === 'f') {
      toggleSpeed();
    } else if (key === 'u') {
      upgrade();
    } else if (key === 's') {
      sell();
    }
  });

  // ---------- Menubaggrund ----------

  var menuCtx = $('menuCanvas').getContext('2d');
  var stars = [];
  for (var i = 0; i < 220; i++) {
    stars.push({ x: Math.random() * 1280, y: Math.random() * 720, z: 0.2 + Math.random() * 0.8, hue: Math.random() < 0.5 ? 185 : 305 });
  }

  function drawMenu(dt, time) {
    var ctx = menuCtx;
    var g = ctx.createLinearGradient(0, 0, 0, 720);
    g.addColorStop(0, '#03050f');
    g.addColorStop(1, '#0b0a2a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1280, 720);

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.x -= s.z * 26 * dt;
      if (s.x < 0) { s.x = 1280; s.y = Math.random() * 720; }
      ctx.fillStyle = 'hsla(' + s.hue + ', 100%, 75%, ' + (0.25 + 0.6 * s.z) + ')';
      ctx.fillRect(s.x, s.y, 1 + s.z * 1.6, 1 + s.z * 1.6);
    }

    // Perspektivgitter i bunden
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 61, 240, 0.35)';
    ctx.lineWidth = 1;
    var horizon = 500;
    for (var x = -20; x <= 20; x++) {
      ctx.beginPath();
      ctx.moveTo(640 + x * 26, horizon);
      ctx.lineTo(640 + x * 180, 720);
      ctx.stroke();
    }
    var offset = (time * 0.35) % 1;
    for (var r = 0; r < 12; r++) {
      var p = (r + offset) / 12;
      var y = horizon + p * p * 220;
      ctx.globalAlpha = 0.15 + 0.6 * p;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1280, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- Løkke ----------

  function frame(now) {
    var dt = Math.min(0.1, (now - lastFrame) / 1000 || 0);
    lastFrame = now;

    if (screen === 'menu') {
      drawMenu(dt, now / 1000);
    } else if (screen === 'map') {
      TD.MapScreen.draw(dt);
    } else if (screen === 'game' && game) {
      if (!paused) {
        var remaining = dt * speed;
        while (remaining > 0.0001) {
          var step = Math.min(0.033, remaining);
          game.update(step);
          remaining -= step;
        }
        if (auto && game.state === 'build' && game.waveIndex > 0) {
          autoTimer += dt;
          if (autoTimer > 2.5) { autoTimer = 0; game.startNextWave(); }
        } else {
          autoTimer = 0;
        }
      }
      // Et solgt eller fjernet tårn må ikke blive stående som valgt.
      if (UI.state.selected && game.towers.indexOf(UI.state.selected) < 0) UI.state.selected = null;
      TD.Renderer.draw(game, UI.state, paused ? 0 : dt);
      UI.refresh(game, { speed: speed, auto: auto, paused: paused });
    }

    window.requestAnimationFrame(frame);
  }

  // ---------- Start ----------

  function boot() {
    var missing = ['DATA', 'Game', 'Renderer', 'Audio', 'MapScreen'].filter(function (name) { return !TD[name]; });
    if (missing.length) {
      UI.showError('Spillet kan ikke starte – disse dele mangler: ' + missing.join(', '));
      return;
    }

    TD.Save.load();

    UI.init({
      selectBuild: selectBuild,
      startWave: startWave,
      toggleSpeed: toggleSpeed,
      toggleAuto: toggleAuto,
      togglePause: togglePause,
      toggleMute: toggleMute,
      upgrade: upgrade,
      sell: sell,
      setVolume: setVolume,
      dialogAction: dialogAction
    });
    UI.syncSettings(TD.Save.data.settings);

    TD.Renderer.init(field);
    TD.MapScreen.init($('mapCanvas'), {
      onSelect: function (index) {
        if (index < TD.Save.data.unlocked) startLevel(index);
      }
    });

    function click(id, fn) {
      $(id).addEventListener('click', function () {
        TD.events.emit('uiClick', {});
        fn();
      });
    }
    click('btn-play', goMap);
    click('btn-map-back', goMenu);
    click('btn-settings', function () { settingsFrom = null; UI.showDialog('settings'); });
    click('btn-map-settings', function () { settingsFrom = null; UI.showDialog('settings'); });
    click('btn-help', function () { UI.showDialog('help'); });

    goMenu();

    // Adgang udefra til afprøvning og fejlsøgning (bruges ikke af spillet selv).
    TD.app = {
      game: function () { return game; },
      startLevel: startLevel
    };

    // Til afprøvning: index.html?kort åbner galaksekortet, index.html?bane=3 starter bane 3 direkte.
    var direct = /[?&]bane=(\d+)/.exec(window.location.search);
    if (direct && TD.DATA.levels[Number(direct[1]) - 1]) startLevel(Number(direct[1]) - 1);
    else if (/[?&]kort/.test(window.location.search)) goMap();

    window.requestAnimationFrame(frame);
  }

  boot();
})();
