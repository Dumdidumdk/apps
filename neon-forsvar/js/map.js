// NEON FORSVAR – galaksekortet (TD.MapScreen): viser fremskridt og lader spilleren vælge bane.
(function () {
  'use strict';

  var TD = window.TD = window.TD || {};

  var W = 1280, H = 720;
  var FONT = "'Segoe UI', 'Trebuchet MS', Arial, sans-serif";
  var GOLD = '#ffd23d';
  var FALLBACK_SECTOR_COLORS = ['#2ee6ff', '#4dffa0', '#c77bff', '#ff6a3d'];
  var FALLBACK_DIFFICULTY = ['Let', 'Middel', 'Svær', 'Meget svær', 'Ekstrem'];
  var SECTOR_LABEL_Y = 682;
  var TOP_BAND = 90;        // herover ligger overskrift, fremskridtslinje og chefens hjørneknapper

  var canvas = null, ctx = null;
  var onSelect = null;
  var background = null;    // forhåndstegnet stjernehimmel med tåger
  var twinkles = [];
  var nodes = [];
  var sectors = [];
  var progress = { unlocked: 1, stars: [] };
  var hover = -1;
  var time = 0;

  // ------------------------------------------------------------ hjælpere

  // Fast tilfældighedsgenerator, så himlen ser ens ud hver gang.
  function rng(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rgba(hex, alpha) {
    var h = String(hex || '#ffffff').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (h.length !== 6 || isNaN(n)) n = 0xffffff;
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function levels() {
    return (TD.DATA && Array.isArray(TD.DATA.levels)) ? TD.DATA.levels : [];
  }

  function starsFor(i) {
    return clamp(Math.floor(Number(progress.stars[i]) || 0), 0, 3);
  }

  // 'cleared' | 'next' | 'open' | 'locked'
  function stateOf(i) {
    if (i >= progress.unlocked) return 'locked';
    if (starsFor(i) > 0) return 'cleared';
    return i === progress.unlocked - 1 ? 'next' : 'open';
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function starPath(c, x, y, r) {
    c.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5;
      var rr = i % 2 === 0 ? r : r * 0.45;
      if (i === 0) c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    c.closePath();
  }

  // Tre stjerner på række; de første 'count' er fyldt.
  function drawStars(c, x, y, count, size, gap) {
    for (var i = 0; i < 3; i++) {
      starPath(c, x + (i - 1) * gap, y, size);
      if (i < count) {
        c.fillStyle = GOLD;
        c.shadowColor = GOLD;
        c.shadowBlur = 8;
        c.fill();
        c.shadowBlur = 0;
      } else {
        c.fillStyle = 'rgba(10,14,32,0.85)';
        c.fill();
        c.lineWidth = 1;
        c.strokeStyle = 'rgba(150,170,210,0.55)';
        c.stroke();
      }
    }
  }

  // Tekst med mørk kant, så den kan læses oven på rute og tåger.
  function label(c, text, x, y, color) {
    c.lineJoin = 'round';
    c.lineWidth = 3.5;
    c.strokeStyle = 'rgba(3,5,16,0.9)';
    c.strokeText(text, x, y);
    c.fillStyle = color;
    c.fillText(text, x, y);
  }

  // ------------------------------------------------------- opbygning af kort

  function rebuild() {
    var list = levels();
    var sectorDefs = (TD.DATA && Array.isArray(TD.DATA.sectors)) ? TD.DATA.sectors : [];
    var bySector = {};
    var i;

    nodes = [];
    sectors = [];
    for (i = 0; i < list.length; i++) {
      var lv = list[i] || {};
      var name = lv.sector || 'Sektor';
      var sector = bySector[name];
      if (!sector) {
        var idx = sectors.length;
        var def = null;
        for (var k = 0; k < sectorDefs.length; k++) {
          if (sectorDefs[k] && sectorDefs[k].name === name) def = sectorDefs[k];
        }
        sector = bySector[name] = {
          name: name,
          color: (def && def.color) || FALLBACK_SECTOR_COLORS[idx % FALLBACK_SECTOR_COLORS.length],
          first: i,
          count: 0,
          x: 0
        };
        sectors.push(sector);
      }
      var pos = lv.mapPos || { x: 80 + (W - 160) * (i + 0.5) / list.length, y: H / 2 };
      var last = i === list.length - 1;
      var milestone = (i + 1) % 5 === 0;
      nodes.push({
        index: i,
        level: lv,
        sector: sector,
        x: clamp(Number(pos.x) || 0, 30, W - 30),
        y: clamp(Number(pos.y) || 0, TOP_BAND + 50, H - 90),
        r: last ? 25 : (milestone ? 21 : 16),
        color: (lv.theme && lv.theme.path) || sector.color,
        accent: (lv.theme && lv.theme.accent) || '#ffffff',
        boss: lv.boss !== undefined ? !!lv.boss : milestone,
        phase: i * 1.7
      });
      sector.count += 1;
      sector.x += nodes[i].x;
    }
    for (i = 0; i < sectors.length; i++) {
      sectors[i].x = clamp(sectors[i].x / sectors[i].count, 90, W - 90);
    }
    progress.unlocked = clamp(progress.unlocked, 1, Math.max(1, nodes.length));
    if (hover >= nodes.length) hover = -1;
    buildBackground();
  }

  function buildBackground() {
    background = document.createElement('canvas');
    background.width = W;
    background.height = H;
    var c = background.getContext('2d');
    var rand = rng(20261003);
    var i;

    var sky = c.createLinearGradient(0, 0, W, H);
    sky.addColorStop(0, '#04061a');
    sky.addColorStop(0.5, '#070a24');
    sky.addColorStop(1, '#030412');
    c.fillStyle = sky;
    c.fillRect(0, 0, W, H);

    // Tåger: hver sektor får sin egen farve omkring sine baner.
    c.globalCompositeOperation = 'lighter';
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var nx = n.x + (rand() - 0.5) * 120, ny = n.y + (rand() - 0.5) * 100;
      var nr = 130 + rand() * 110;
      var neb = c.createRadialGradient(nx, ny, 0, nx, ny, nr);
      neb.addColorStop(0, rgba(n.sector.color, 0.085));
      neb.addColorStop(0.5, rgba(n.sector.color, 0.035));
      neb.addColorStop(1, rgba(n.sector.color, 0));
      c.fillStyle = neb;
      c.fillRect(nx - nr, ny - nr, nr * 2, nr * 2);
    }
    for (i = 0; i < 7; i++) {
      var bx = rand() * W, by = rand() * H, br = 160 + rand() * 220;
      var tint = ['#3d5cff', '#ff3df0', '#19c8ff'][i % 3];
      var blob = c.createRadialGradient(bx, by, 0, bx, by, br);
      blob.addColorStop(0, rgba(tint, 0.05));
      blob.addColorStop(1, rgba(tint, 0));
      c.fillStyle = blob;
      c.fillRect(bx - br, by - br, br * 2, br * 2);
    }
    c.globalCompositeOperation = 'source-over';

    // Svagt hologramgitter.
    c.strokeStyle = 'rgba(90,150,255,0.035)';
    c.lineWidth = 1;
    c.beginPath();
    for (i = 80; i < W; i += 80) { c.moveTo(i + 0.5, 0); c.lineTo(i + 0.5, H); }
    for (i = 80; i < H; i += 80) { c.moveTo(0, i + 0.5); c.lineTo(W, i + 0.5); }
    c.stroke();

    // Stjerner.
    for (i = 0; i < 420; i++) {
      var sx = rand() * W, sy = rand() * H;
      var big = rand() < 0.08;
      var hue = rand();
      c.fillStyle = hue < 0.15 ? 'rgba(255,220,190,' : (hue < 0.35 ? 'rgba(170,210,255,' : 'rgba(255,255,255,');
      c.fillStyle += (0.25 + rand() * 0.6) + ')';
      c.beginPath();
      c.arc(sx, sy, big ? 1.3 + rand() * 0.6 : 0.4 + rand() * 0.7, 0, Math.PI * 2);
      c.fill();
    }
    twinkles = [];
    for (i = 0; i < 46; i++) {
      twinkles.push({ x: rand() * W, y: rand() * H, r: 0.9 + rand() * 1.1, speed: 0.8 + rand() * 2.2, phase: rand() * 6.28 });
    }

    // Mørkere kanter.
    var vig = c.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.72);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,6,0.6)');
    c.fillStyle = vig;
    c.fillRect(0, 0, W, H);
  }

  // ------------------------------------------------------------------- mus

  function nodeAt(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    var x = (clientX - rect.left) * W / rect.width;
    var y = (clientY - rect.top) * H / rect.height;
    var best = -1, bestSq = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var dx = x - nodes[i].x, dy = y - nodes[i].y;
      var reach = nodes[i].r + 10;
      var dSq = dx * dx + dy * dy;
      if (dSq <= reach * reach && dSq < bestSq) {
        bestSq = dSq;
        best = i;
      }
    }
    return best;
  }

  function onMove(ev) {
    hover = nodeAt(ev.clientX, ev.clientY);
    canvas.style.cursor = (hover >= 0 && stateOf(hover) !== 'locked') ? 'pointer' : 'default';
  }

  function onLeave() {
    hover = -1;
    canvas.style.cursor = 'default';
  }

  function onClick(ev) {
    var i = nodeAt(ev.clientX, ev.clientY);
    if (i < 0) return;
    hover = i;
    if (stateOf(i) === 'locked') {
      if (TD.events) TD.events.emit('uiError', {});
      return;
    }
    if (TD.events) TD.events.emit('uiClick', {});
    if (onSelect) onSelect(i);
  }

  // ---------------------------------------------------------------- tegning

  // Blød kurve gennem banerne (Catmull-Rom omsat til Bézier).
  function traceSegment(i) {
    var p0 = nodes[Math.max(0, i - 1)], p1 = nodes[i], p2 = nodes[i + 1], p3 = nodes[Math.min(nodes.length - 1, i + 2)];
    ctx.moveTo(p1.x, p1.y);
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y
    );
  }

  function drawRoute() {
    var i;
    ctx.lineCap = 'round';

    // Den del, spilleren endnu ikke har åbnet: svag og stiplet.
    ctx.setLineDash([3, 9]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(120,140,190,0.3)';
    ctx.beginPath();
    for (i = 0; i < nodes.length - 1; i++) {
      if (i + 1 >= progress.unlocked) traceSegment(i);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Den tilbagelagte rute: lysende i sektorens farve med lys, der løber fremad.
    for (i = 0; i < nodes.length - 1 && i + 1 < progress.unlocked; i++) {
      var color = nodes[i + 1].sector.color;
      ctx.beginPath();
      traceSegment(i);
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = rgba(color, 0.35);
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.shadowBlur = 6;
      ctx.strokeStyle = rgba(color, 0.95);
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.setLineDash([5, 23]);
    ctx.lineDashOffset = -time * 36;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    for (i = 0; i < nodes.length - 1 && i + 1 < progress.unlocked; i++) traceSegment(i);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  function drawLock(x, y, s) {
    ctx.strokeStyle = 'rgba(160,175,205,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y - s * 0.25, s * 0.42, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = 'rgba(160,175,205,0.8)';
    roundRect(ctx, x - s * 0.6, y - s * 0.25, s * 1.2, s * 0.95, 2);
    ctx.fill();
    ctx.fillStyle = '#141a2c';
    ctx.beginPath();
    ctx.arc(x, y + s * 0.2, s * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawNode(n) {
    var state = stateOf(n.index);
    var hovered = hover === n.index;
    var r = n.r * (hovered ? 1.12 : 1);
    var x = n.x, y = n.y;
    var pulse = 0.5 + 0.5 * Math.sin(time * 3.2);
    var g;

    if (state === 'locked') {
      g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
      g.addColorStop(0, '#2c3550');
      g.addColorStop(1, '#0d1122');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = hovered ? 'rgba(170,185,220,0.8)' : 'rgba(110,125,160,0.5)';
      ctx.stroke();
      if (n.boss) {
        ctx.strokeStyle = 'rgba(110,125,160,0.3)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.65, r * 0.5, -0.35, 0, Math.PI * 2);
        ctx.stroke();
      }
      drawLock(x, y + 1, r * 0.55);
    } else {
      // Pulserende ringe om den bane, spilleren er nået til.
      if (state === 'next') {
        for (var k = 0; k < 2; k++) {
          var wave = (time * 0.7 + k * 0.5) % 1;
          ctx.strokeStyle = rgba('#ffffff', (1 - wave) * 0.7);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, r + 6 + wave * 26, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Bagerste halvdel af ringen om bossbaner.
      if (n.boss) {
        ctx.strokeStyle = rgba(n.accent, 0.8);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.65, r * 0.5, -0.35, Math.PI, Math.PI * 2);
        ctx.stroke();
      }

      // Planeten.
      ctx.shadowColor = n.color;
      ctx.shadowBlur = state === 'next' ? 22 + pulse * 18 : (hovered ? 26 : 14);
      g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.25, n.color);
      g.addColorStop(1, rgba(n.color, 0.25));
      ctx.fillStyle = '#060a1c';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = g;
      ctx.fill();

      // Striber og skyggeside.
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,20,0.22)';
      ctx.lineWidth = r * 0.22;
      for (var b = -1; b <= 1; b++) {
        ctx.beginPath();
        ctx.ellipse(x, y + b * r * 0.55 + Math.sin(n.phase) * 2, r * 1.3, r * 0.28, -0.25, 0, Math.PI);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(2,4,18,0.45)';
      ctx.beginPath();
      ctx.arc(x + r * 0.55, y + r * 0.5, r * 1.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.lineWidth = state === 'next' ? 2.5 : 1.5;
      ctx.strokeStyle = state === 'next' || hovered ? '#ffffff' : rgba(n.color, 0.9);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();

      // Forreste halvdel af ringen og en lille måne i kredsløb.
      if (n.boss) {
        ctx.strokeStyle = rgba(n.accent, 0.95);
        ctx.lineWidth = 3;
        ctx.shadowColor = n.accent;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.65, r * 0.5, -0.35, 0, Math.PI);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      if (state === 'next') {
        var oa = time * 1.6;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(x + Math.cos(oa) * (r + 11), y + Math.sin(oa) * (r + 11) * 0.55, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Banens nummer.
      ctx.font = 'bold ' + (n.r >= 21 ? 16 : 13) + 'px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      label(ctx, String(n.index + 1), x, y + 1, '#ffffff');
    }

    // Under planeten: stjerner og navn.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var below = y + n.r + (n.boss ? 16 : 13);
    if (state !== 'locked') {
      drawStars(ctx, x, below, starsFor(n.index), 6, 15);
      below += 17;
    } else {
      below += 3;
    }
    ctx.font = (state === 'next' ? 'bold ' : '') + '12px ' + FONT;
    label(ctx, n.level.name || ('Bane ' + (n.index + 1)), x, below,
      state === 'locked' ? 'rgba(140,155,190,0.6)' : (state === 'next' || hovered ? '#ffffff' : 'rgba(215,228,255,0.92)'));

    // Pil og tekst over den næste bane.
    if (state === 'next') {
      var top = y - n.r - (n.boss ? 20 : 14) - Math.abs(Math.sin(time * 3)) * 5;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = n.color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x - 7, top - 9);
      ctx.lineTo(x + 7, top - 9);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.font = 'bold 11px ' + FONT;
      label(ctx, 'NÆSTE BANE', x, top - 19, '#ffffff');
    }
  }

  function drawSectors() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < sectors.length; i++) {
      var s = sectors[i];
      var done = 0;
      for (var k = s.first; k < s.first + s.count; k++) {
        if (starsFor(k) > 0 && k < progress.unlocked) done++;
      }
      var open = s.first < progress.unlocked;
      var color = open ? s.color : 'rgba(130,145,180,0.55)';

      ctx.font = 'bold 15px ' + FONT;
      var text = s.name.toUpperCase();
      var half = ctx.measureText(text).width / 2 + 14;
      ctx.strokeStyle = open ? rgba(s.color, 0.55) : 'rgba(130,145,180,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x - half - 34, SECTOR_LABEL_Y);
      ctx.lineTo(s.x - half, SECTOR_LABEL_Y);
      ctx.moveTo(s.x + half, SECTOR_LABEL_Y);
      ctx.lineTo(s.x + half + 34, SECTOR_LABEL_Y);
      ctx.stroke();
      if (open) {
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 10;
      }
      label(ctx, text, s.x, SECTOR_LABEL_Y, color);
      ctx.shadowBlur = 0;

      ctx.font = '11px ' + FONT;
      label(ctx, open ? (done + ' af ' + s.count + ' baner klaret') : 'Låst', s.x, SECTOR_LABEL_Y + 17,
        open ? 'rgba(200,215,245,0.8)' : 'rgba(130,145,180,0.5)');
    }
  }

  // Overskrift og fremskridtslinje midt i toppen – hjørnerne er chefens knapper.
  function drawHeader() {
    var total = nodes.length;
    var cleared = 0, starSum = 0, i;
    for (i = 0; i < total; i++) {
      if (i < progress.unlocked && starsFor(i) > 0) {
        cleared++;
        starSum += starsFor(i);
      }
    }
    var allDone = total > 0 && cleared === total;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px ' + FONT;
    ctx.shadowColor = '#19c8ff';
    ctx.shadowBlur = 14;
    label(ctx, 'G A L A K S E K O R T', W / 2, 24, '#eaf6ff');
    ctx.shadowBlur = 0;

    var barW = 400, barH = 10, barX = (W - barW) / 2, barY = 46;
    var gap = 2;
    var cell = total > 0 ? (barW - gap * (total - 1)) / total : barW;
    for (i = 0; i < total; i++) {
      var state = stateOf(i);
      var cx = barX + i * (cell + gap);
      var color = nodes[i].sector.color;
      if (state === 'cleared') {
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
      } else if (state === 'next') {
        ctx.fillStyle = rgba('#ffffff', 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(time * 3.2)));
      } else if (state === 'open') {
        ctx.fillStyle = rgba(color, 0.45);
      } else {
        ctx.fillStyle = 'rgba(70,84,120,0.4)';
      }
      roundRect(ctx, cx, barY, cell, barH, 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.font = 'bold 14px ' + FONT;
    ctx.textAlign = 'right';
    label(ctx, allDone ? ('Alle ' + total + ' baner klaret!') : ('Bane ' + progress.unlocked + ' af ' + total),
      barX - 14, barY + barH / 2, '#ffffff');

    ctx.textAlign = 'left';
    starPath(ctx, barX + barW + 22, barY + barH / 2, 7);
    ctx.fillStyle = GOLD;
    ctx.shadowColor = GOLD;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
    label(ctx, starSum + ' / ' + (total * 3), barX + barW + 36, barY + barH / 2, GOLD);

    ctx.textAlign = 'center';
    ctx.font = '12px ' + FONT;
    label(ctx, allDone ? 'Galaksen er reddet – spil banerne igen og saml alle stjerner'
      : 'Klik på en åben bane for at starte', W / 2, 76, 'rgba(190,205,240,0.6)');
  }

  function drawTooltip(n) {
    var lv = n.level;
    var state = stateOf(n.index);
    var names = (TD.DATA && TD.DATA.difficultyNames) || FALLBACK_DIFFICULTY;
    var diff = clamp(Math.round(Number(lv.difficulty) || (1 + Math.floor(n.index / 4))), 1, 5);
    var waves = Array.isArray(lv.waves) ? lv.waves.length : 0;
    var stars = starsFor(n.index);
    var status, statusColor;
    if (state === 'locked') {
      status = 'Låst – klar bane ' + n.index + ' først';
      statusColor = 'rgba(170,185,220,0.85)';
    } else if (state === 'cleared') {
      status = stars === 3 ? 'Klaret med alle stjerner' : 'Klaret – klik for at spille igen';
      statusColor = GOLD;
    } else {
      status = 'Klik for at starte';
      statusColor = '#ffffff';
    }

    var w = 262, h = n.boss ? 150 : 132;
    var color = n.sector.color;

    // Prøv højre, venstre, over og under – vælg den plads, der dækker færrest andre baner.
    var off = n.r + 24;
    var spots = [
      [n.x + off, n.y - h / 2], [n.x - off - w, n.y - h / 2],
      [n.x - w / 2, n.y - off - 24 - h], [n.x - w / 2, n.y + off + 34]
    ];
    var x = 0, y = 0, bestCost = Infinity;
    for (var s = 0; s < spots.length; s++) {
      var sx = clamp(spots[s][0], 10, W - w - 10);
      var sy = clamp(spots[s][1], TOP_BAND, H - h - 52);
      var cost = Math.abs(sx - spots[s][0]) + Math.abs(sy - spots[s][1]) > 1 ? 1.5 : 0;
      for (var m = 0; m < nodes.length; m++) {
        var o = nodes[m];
        var pad = o.r + 8;
        if (o.x > sx - pad && o.x < sx + w + pad && o.y > sy - pad && o.y < sy + h + pad + 24) {
          cost += o === n ? 100 : (stateOf(m) === 'locked' ? 1 : 2);
        }
      }
      if (cost < bestCost) {
        bestCost = cost;
        x = sx;
        y = sy;
      }
    }

    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = 'rgba(5,8,24,0.94)';
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.stroke();
    ctx.fillStyle = color;
    roundRect(ctx, x, y + 12, 4, h - 24, 2);
    ctx.fill();

    var tx = x + 18, ty = y + 22;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 16px ' + FONT;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Bane ' + (n.index + 1) + ' · ' + (lv.name || ''), tx, ty, w - 34);
    ty += 21;
    ctx.font = 'bold 12px ' + FONT;
    ctx.fillStyle = color;
    ctx.fillText(n.sector.name, tx, ty);

    ty += 24;
    ctx.font = '13px ' + FONT;
    ctx.fillStyle = 'rgba(190,205,240,0.85)';
    ctx.fillText('Bølger', tx, ty);
    ctx.fillText('Sværhedsgrad', tx, ty + 21);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px ' + FONT;
    ctx.fillText(String(waves), tx + 104, ty);
    ctx.fillText(names[diff - 1] || '', tx + 104, ty + 21);
    for (var i = 0; i < 5; i++) {
      ctx.fillStyle = i < diff ? ['#4dffa0', '#b4ff3d', GOLD, '#ff8a3d', '#ff3d6e'][diff - 1] : 'rgba(90,105,140,0.5)';
      roundRect(ctx, x + w - 18 - (5 - i) * 11, ty + 16, 8, 10, 2);
      ctx.fill();
    }
    ty += 21;

    if (n.boss) {
      ty += 20;
      ctx.font = 'bold 12px ' + FONT;
      ctx.fillStyle = '#ff5a7d';
      ctx.fillText(n.index === nodes.length - 1 ? 'Advarsel: slutboss' : 'Advarsel: boss', tx, ty);
    }

    ty += 24;
    ctx.font = 'bold 12px ' + FONT;
    ctx.fillStyle = statusColor;
    ctx.fillText(status, tx, ty, w - (state === 'locked' ? 34 : 92));
    if (state !== 'locked') drawStars(ctx, x + w - 42, ty, stars, 7, 17);
  }

  function draw(dt) {
    if (!ctx) return;
    time += Math.min(0.1, Math.max(0, Number(dt) || 0));
    if (nodes.length !== levels().length || !background) rebuild();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.drawImage(background, 0, 0);

    var i;
    for (i = 0; i < twinkles.length; i++) {
      var s = twinkles[i];
      ctx.fillStyle = rgba('#ffffff', 0.15 + 0.75 * (0.5 + 0.5 * Math.sin(time * s.speed + s.phase)));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!nodes.length) {
      ctx.font = 'bold 18px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      label(ctx, 'Ingen baner fundet', W / 2, H / 2, '#ffffff');
      return;
    }

    drawRoute();
    drawSectors();
    for (i = 0; i < nodes.length; i++) {
      if (i !== hover) drawNode(nodes[i]);
    }
    if (hover >= 0 && nodes[hover]) drawNode(nodes[hover]);
    drawHeader();
    if (hover >= 0 && nodes[hover]) drawTooltip(nodes[hover]);
  }

  // ------------------------------------------------------------------- API

  TD.MapScreen = {
    init: function (canvasEl, options) {
      if (canvas) {
        canvas.removeEventListener('mousemove', onMove);
        canvas.removeEventListener('mouseleave', onLeave);
        canvas.removeEventListener('click', onClick);
      }
      canvas = canvasEl;
      ctx = canvas.getContext('2d');
      onSelect = options && typeof options.onSelect === 'function' ? options.onSelect : null;
      canvas.addEventListener('mousemove', onMove);
      canvas.addEventListener('mouseleave', onLeave);
      canvas.addEventListener('click', onClick);
      rebuild();
    },

    setProgress: function (p) {
      p = p || {};
      progress = {
        unlocked: Math.max(1, Math.floor(Number(p.unlocked) || 1)),
        stars: Array.isArray(p.stars) ? p.stars.slice() : []
      };
      hover = -1;
      if (canvas) {
        canvas.style.cursor = 'default';
        rebuild();
      }
    },

    draw: draw
  };
})();
