// NEON FORSVAR – tegning af spilfeltet: baggrund, rute, tårne, fjender, stråler og partikler.
// Læser kun fra spillet – ændrer aldrig spillets tilstand.
(function () {
  'use strict';

  var TD = window.TD = window.TD || {};

  var TAU = Math.PI * 2;
  var W = 1040, H = 720, CELL = 40;

  // Sprites tegnes i dobbelt opløsning, så de står skarpt, når canvas skaleres op.
  var SPR = 2;
  var TS = 84, TH = 42;            // tårn-sprite: logisk størrelse og halv størrelse
  var MAX_PARTICLES = 650;
  var MAX_RINGS = 60;
  var MAX_TEXTS = 24;
  var FONT = '"Segoe UI", "Trebuchet MS", Arial, sans-serif';

  var DEFAULT_THEME = { bg1: '#050818', bg2: '#0a1030', grid: '#112233', path: '#00ffff', accent: '#ff00ff' };
  var TOWER_COLORS = {
    kanon: '#ffb020', laser: '#ff3860', raket: '#ff7a1a',
    fryser: '#5fd8ff', tesla: '#b070ff', plasma: '#40ffb0'
  };
  // Afstand fra tårnets centrum til mundingen, pr. trin.
  var MUZZLE = {
    kanon: [20, 21, 23], laser: [19, 21, 23], raket: [13, 14, 15],
    fryser: [0, 0, 0], tesla: [0, 0, 0], plasma: [26, 28, 30]
  };

  var canvas = null, ctx = null;
  var viewScale = 1;
  var subscribed = false;
  var currentGame = null;
  var theme = DEFAULT_THEME;
  var bgLayer = null, bgWidth = 0;
  var path = { pts: [], lens: [], total: 0 };
  var twinkles = [];
  var meteors = [], meteorWait = 2, meteorClock = 0;

  var time = 0;
  var lastGameTime = -1, gameAdvanced = false;
  var hitBudget = 0;
  var trailAcc = 0, emitTrail = false;

  var particles = [], pool = [];
  var rings = [], texts = [], delayed = [];
  var seenBeams = typeof WeakSet === 'function' ? new WeakSet() : null;

  var shakeT = 0, shakeDur = 0, shakeMag = 0, shakeX = 0, shakeY = 0;
  var leakFlash = 0, bossWarn = 0, whiteFlash = 0;

  var glowCache = {}, towerCache = {}, enemyCache = {}, vignetteCache = {};

  // ---------------------------------------------------------------- farver

  var colorCache = {};
  function rgb(color) {
    var c = colorCache[color];
    if (c) return c;
    var s = String(color || '#ffffff').trim(), m;
    if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s))) {
      c = [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16)];
    } else if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s))) {
      c = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    } else if ((m = /^rgba?\(([^)]+)\)/i.exec(s))) {
      var parts = m[1].split(',');
      c = [parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0, parseFloat(parts[2]) || 0];
    } else {
      c = [255, 255, 255];
    }
    colorCache[color] = c;
    return c;
  }

  function rgba(color, a) {
    var c = rgb(color);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  function mix(a, b, t) {
    var ca = rgb(a), cb = rgb(b);
    return 'rgb(' + Math.round(ca[0] + (cb[0] - ca[0]) * t) + ',' +
      Math.round(ca[1] + (cb[1] - ca[1]) * t) + ',' +
      Math.round(ca[2] + (cb[2] - ca[2]) * t) + ')';
  }

  // ---------------------------------------------------------------- småting

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // Lille tilfældighedsgenerator med frø (stabile stjerner og lyn, der ikke flimrer hver frame).
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  function towerDef(type) {
    return (TD.DATA && TD.DATA.towers && TD.DATA.towers[type]) || null;
  }

  function towerColor(type) {
    var def = towerDef(type);
    return (def && def.color) || TOWER_COLORS[type] || '#ffffff';
  }

  function glowOn(g, color, blur) { g.shadowColor = color; g.shadowBlur = blur * SPR; }
  function glowOff(g) { g.shadowBlur = 0; g.shadowColor = 'rgba(0,0,0,0)'; }

  function circle(g, x, y, r) {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
  }

  function poly(g, n, r, rot) {
    g.beginPath();
    for (var i = 0; i < n; i++) {
      var a = rot + i * TAU / n;
      if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
  }

  function rrect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  // ---------------------------------------------------------------- transformationer

  function baseT() {
    ctx.setTransform(viewScale, 0, 0, viewScale, shakeX * viewScale, shakeY * viewScale);
  }

  function localT(x, y, ang) {
    var c = Math.cos(ang) * viewScale, s = Math.sin(ang) * viewScale;
    ctx.setTransform(c, s, -s, c, (x + shakeX) * viewScale, (y + shakeY) * viewScale);
  }

  // ---------------------------------------------------------------- glød-sprites

  function glowSprite(color) {
    var s = glowCache[color];
    if (s) return s;
    s = makeCanvas(64, 64);
    var g = s.getContext('2d');
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba(mix(color, '#ffffff', 0.75), 1));
    grad.addColorStop(0.22, rgba(color, 0.75));
    grad.addColorStop(0.55, rgba(color, 0.2));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowCache[color] = s;
    return s;
  }

  function drawGlow(x, y, r, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
  }

  function vignetteSprite(color) {
    var s = vignetteCache[color];
    if (s) return s;
    s = makeCanvas(208, 144);
    var g = s.getContext('2d');
    g.translate(104, 72);
    g.scale(1, 144 / 208);
    var grad = g.createRadialGradient(0, 0, 50, 0, 0, 128);
    grad.addColorStop(0, rgba(color, 0));
    grad.addColorStop(0.7, rgba(color, 0.35));
    grad.addColorStop(1, rgba(color, 0.95));
    g.fillStyle = grad;
    g.fillRect(-104, -104, 208, 208);
    vignetteCache[color] = s;
    return s;
  }

  // ---------------------------------------------------------------- tårn-sprites

  function paintTowerBase(g, type, level, color) {
    var light = mix(color, '#ffffff', 0.55);
    var i, a;
    g.lineJoin = 'round';
    g.lineCap = 'round';

    function shape(grow) {
      switch (type) {
        case 'kanon': poly(g, 8, 18 + grow, Math.PI / 8); break;
        case 'laser': poly(g, 4, 20 + grow, 0); break;
        case 'raket': rrect(g, -16 - grow, -16 - grow, 32 + grow * 2, 32 + grow * 2, 6); break;
        case 'fryser': poly(g, 6, 18.5 + grow, 0); break;
        case 'plasma': poly(g, 8, 19 + grow, 0); break;
        default: circle(g, 0, 0, 17 + grow);
      }
    }

    var grad = g.createLinearGradient(0, -18, 0, 18);
    grad.addColorStop(0, mix(color, '#0a0f1e', 0.8));
    grad.addColorStop(1, '#060912');
    shape(0);
    g.fillStyle = grad;
    glowOn(g, color, 7 + level * 2.5);
    g.fill();
    g.lineWidth = 1.4 + level * 0.35;
    g.strokeStyle = color;
    g.stroke();
    glowOff(g);

    g.globalAlpha = 0.35;
    shape(-4.5);
    g.lineWidth = 1;
    g.strokeStyle = light;
    g.stroke();
    g.globalAlpha = 1;

    if (type === 'tesla') {
      g.fillStyle = color;
      glowOn(g, color, 5);
      for (i = 0; i < 4; i++) {
        a = Math.PI / 4 + i * Math.PI / 2;
        circle(g, Math.cos(a) * 14.5, Math.sin(a) * 14.5, 2);
        g.fill();
      }
      glowOff(g);
    } else if (type === 'plasma') {
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      g.globalAlpha = 0.8;
      g.beginPath();
      for (i = 0; i < 8; i++) {
        a = Math.PI / 8 + i * Math.PI / 4;
        g.moveTo(Math.cos(a) * 12.5, Math.sin(a) * 12.5);
        g.lineTo(Math.cos(a) * 16, Math.sin(a) * 16);
      }
      g.stroke();
      g.globalAlpha = 1;
    } else if (type === 'raket') {
      g.fillStyle = light;
      for (i = 0; i < 4; i++) {
        circle(g, (i % 2 ? 1 : -1) * 12.5, (i < 2 ? 1 : -1) * 12.5, 1.1);
        g.fill();
      }
    }

    if (level >= 2) {
      shape(0);
      g.lineWidth = 0.8;
      g.strokeStyle = '#ffffff';
      g.globalAlpha = 0.85;
      glowOn(g, light, 6);
      g.stroke();
      glowOff(g);
      g.globalAlpha = 1;
    }

    // Trin-mærker nederst på pladen.
    var py = type === 'laser' ? 12.5 : 14;
    for (i = 0; i <= level; i++) {
      var px = (i - level / 2) * 5.5;
      g.fillStyle = '#04060c';
      g.fillRect(px - 2.4, py - 1.8, 4.8, 3.6);
      g.fillStyle = '#ffffff';
      glowOn(g, color, 4);
      g.fillRect(px - 1.6, py - 1, 3.2, 2);
      glowOff(g);
    }
  }

  function paintTowerTurret(g, type, level, color) {
    var light = mix(color, '#ffffff', 0.6);
    var dark = mix(color, '#070a14', 0.78);
    var tip = (MUZZLE[type] || MUZZLE.kanon)[level];
    var i, a, y;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = color;
    g.fillStyle = dark;
    g.lineWidth = 1.4;

    switch (type) {
      case 'kanon':
        g.fillStyle = '#10182c';
        glowOn(g, color, 5);
        if (level === 0) {
          rrect(g, 3, -2.8, tip - 3, 5.6, 1.2); g.fill(); g.stroke();
        } else {
          var bw = level === 1 ? 4 : 4.8;
          rrect(g, 3, -3.4 - bw / 2, tip - 3, bw, 1.2); g.fill(); g.stroke();
          rrect(g, 3, 3.4 - bw / 2, tip - 3, bw, 1.2); g.fill(); g.stroke();
          if (level === 2) {
            g.fillStyle = light;
            g.fillRect(tip - 4, -7, 3, 5.2);
            g.fillRect(tip - 4, 1.8, 3, 5.2);
          }
        }
        g.fillStyle = dark;
        rrect(g, -12, -4.5, 6, 9, 1.5); g.fill(); g.stroke();
        circle(g, 0, 0, 8.5 + level * 0.6); g.fill(); g.stroke();
        glowOff(g);
        g.fillStyle = light;
        circle(g, 0, 0, 3 + level * 0.5); g.fill();
        g.globalAlpha = 0.5;
        g.strokeStyle = light;
        g.lineWidth = 0.8;
        circle(g, 0, 0, 6); g.stroke();
        g.globalAlpha = 1;
        break;

      case 'laser':
        glowOn(g, color, 5);
        g.fillStyle = dark;
        g.beginPath();
        g.moveTo(-6, -4); g.lineTo(-12, -8.5); g.lineTo(-9, 0); g.lineTo(-12, 8.5); g.lineTo(-6, 4);
        g.closePath(); g.fill(); g.stroke();
        rrect(g, -8, -4.8, 16, 9.6, 4.5); g.fill(); g.stroke();
        g.fillStyle = '#10182c';
        rrect(g, 7, -1.7, tip - 9, 3.4, 1); g.fill(); g.stroke();
        if (level >= 1) {
          g.fillStyle = light;
          g.fillRect(11, -4, 1.8, 8);
        }
        if (level >= 2) {
          g.fillRect(15.5, -3.4, 1.6, 6.8);
          g.strokeStyle = light;
          g.lineWidth = 1.2;
          g.beginPath();
          g.moveTo(5, -5.5); g.lineTo(tip - 2, -3.2);
          g.moveTo(5, 5.5); g.lineTo(tip - 2, 3.2);
          g.stroke();
        }
        glowOff(g);
        g.fillStyle = '#ffffff';
        glowOn(g, color, 8);
        circle(g, tip - 1, 0, 2.2 + level * 0.5); g.fill();
        circle(g, -1, 0, 2); g.fill();
        glowOff(g);
        break;

      case 'raket':
        var tubes = 2 + level;
        var half = tubes * 2.5 + 2;
        glowOn(g, color, 5);
        g.fillStyle = dark;
        rrect(g, -11, -half, 22, half * 2, 3); g.fill(); g.stroke();
        glowOff(g);
        for (i = 0; i < tubes; i++) {
          y = (i - (tubes - 1) / 2) * 5;
          g.fillStyle = '#04060c';
          g.fillRect(-7, y - 1.6, 17, 3.2);
          g.fillStyle = '#cfd6e6';
          g.fillRect(-2, y - 1.2, 9, 2.4);
          g.fillStyle = light;
          glowOn(g, color, 4);
          g.beginPath();
          g.moveTo(tip, y); g.lineTo(7, y - 1.9); g.lineTo(7, y + 1.9);
          g.closePath(); g.fill();
          glowOff(g);
        }
        g.fillStyle = color;
        g.fillRect(-10, -half + 1.5, 2, half * 2 - 3);
        break;

      case 'fryser':
        var arm = 11 + level * 2;
        g.strokeStyle = light;
        g.lineWidth = 2;
        glowOn(g, color, 6);
        g.beginPath();
        for (i = 0; i < 6; i++) {
          a = i * Math.PI / 3;
          var ca = Math.cos(a), sa = Math.sin(a);
          g.moveTo(0, 0);
          g.lineTo(ca * arm, sa * arm);
          var steps = level >= 2 ? 2 : level >= 1 ? 1 : 0;
          for (var s = 0; s < steps; s++) {
            var f = arm * (0.5 + s * 0.28), bl = 3.6 - s * 0.8;
            var bx = ca * f, by = sa * f;
            g.moveTo(bx, by);
            g.lineTo(bx + Math.cos(a + 0.9) * bl, by + Math.sin(a + 0.9) * bl);
            g.moveTo(bx, by);
            g.lineTo(bx + Math.cos(a - 0.9) * bl, by + Math.sin(a - 0.9) * bl);
          }
        }
        g.stroke();
        if (level >= 2) {
          g.lineWidth = 1;
          g.globalAlpha = 0.7;
          g.setLineDash([3, 3.5]);
          circle(g, 0, 0, 16.5); g.stroke();
          g.setLineDash([]);
          g.globalAlpha = 1;
        }
        g.fillStyle = '#ffffff';
        poly(g, 6, 4 + level, Math.PI / 6); g.fill();
        glowOff(g);
        g.strokeStyle = color;
        g.lineWidth = 1;
        poly(g, 6, 6.5 + level, Math.PI / 6); g.stroke();
        break;

      case 'tesla':
        var prongs = level === 0 ? 3 : level === 1 ? 4 : 6;
        glowOn(g, color, 5);
        g.lineWidth = 1.6;
        g.beginPath();
        for (i = 0; i < prongs; i++) {
          a = i * TAU / prongs;
          g.moveTo(Math.cos(a) * 6, Math.sin(a) * 6);
          g.lineTo(Math.cos(a) * 12.5, Math.sin(a) * 12.5);
        }
        g.stroke();
        g.fillStyle = light;
        for (i = 0; i < prongs; i++) {
          a = i * TAU / prongs;
          circle(g, Math.cos(a) * 13, Math.sin(a) * 13, 2.1); g.fill();
        }
        g.lineWidth = 1.3;
        for (i = 0; i <= level; i++) {
          g.globalAlpha = 1 - i * 0.25;
          circle(g, 0, 0, 7.5 + i * 3); g.stroke();
        }
        g.globalAlpha = 1;
        var orb = g.createRadialGradient(0, 0, 0, 0, 0, 5.5 + level * 0.5);
        orb.addColorStop(0, '#ffffff');
        orb.addColorStop(0.5, light);
        orb.addColorStop(1, color);
        g.fillStyle = orb;
        glowOn(g, color, 9);
        circle(g, 0, 0, 5 + level * 0.5); g.fill();
        glowOff(g);
        break;

      case 'plasma':
        glowOn(g, color, 6);
        g.fillStyle = '#10182c';
        rrect(g, 0, -6.6, tip, 3.2, 1); g.fill(); g.stroke();
        rrect(g, 0, 3.4, tip, 3.2, 1); g.fill(); g.stroke();
        g.strokeStyle = light;
        g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(3, 0); g.lineTo(tip - 3, 0); g.stroke();
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.fillStyle = dark;
        rrect(g, -13, -9.5, 18, 19, 3.5); g.fill(); g.stroke();
        glowOff(g);
        g.fillStyle = color;
        g.fillRect(-11, -5, 2, 10);
        g.fillStyle = light;
        glowOn(g, color, 5);
        var nodes = level === 0 ? 0 : level === 1 ? 1 : 2;
        for (i = 0; i < nodes; i++) {
          circle(g, -7 + i * 7, -9.5, 2.4); g.fill();
          circle(g, -7 + i * 7, 9.5, 2.4); g.fill();
        }
        if (level >= 2) {
          g.fillRect(tip - 3, -8, 2.2, 6);
          g.fillRect(tip - 3, 2, 2.2, 6);
          g.fillRect(tip * 0.55, -7.6, 1.8, 5.2);
          g.fillRect(tip * 0.55, 2.4, 1.8, 5.2);
        }
        g.fillStyle = '#ffffff';
        circle(g, -3, 0, 3 + level * 0.6); g.fill();
        glowOff(g);
        break;

      default:
        glowOn(g, color, 6);
        circle(g, 0, 0, 9); g.fill(); g.stroke();
        glowOff(g);
    }
  }

  function towerSprite(type, level, color) {
    level = Math.max(0, Math.min(2, level | 0));
    color = color || towerColor(type);
    var key = type + '|' + level + '|' + color;
    var s = towerCache[key];
    if (s) return s;
    var base = makeCanvas(TS * SPR, TS * SPR);
    var g = base.getContext('2d');
    g.setTransform(SPR, 0, 0, SPR, TH * SPR, TH * SPR);
    paintTowerBase(g, type, level, color);
    var turret = makeCanvas(TS * SPR, TS * SPR);
    g = turret.getContext('2d');
    g.setTransform(SPR, 0, 0, SPR, TH * SPR, TH * SPR);
    paintTowerTurret(g, type, level, color);
    s = { base: base, turret: turret };
    towerCache[key] = s;
    return s;
  }

  // ---------------------------------------------------------------- fjende-sprites

  function paintEnemy(g, shape, r, color, mega) {
    var dark = mix(color, '#05070f', 0.72);
    var light = mix(color, '#ffffff', 0.6);
    var i, a;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.fillStyle = dark;
    g.strokeStyle = color;
    g.lineWidth = Math.max(1.4, r * 0.13);

    switch (shape) {
      case 'sprinter':
        glowOn(g, color, 8);
        g.beginPath();
        g.moveTo(r * 1.1, 0); g.lineTo(-r * 0.85, r * 0.75); g.lineTo(-r * 0.35, 0); g.lineTo(-r * 0.85, -r * 0.75);
        g.closePath(); g.fill(); g.stroke();
        glowOff(g);
        g.strokeStyle = light;
        g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(r * 0.7, 0); g.lineTo(-r * 0.05, 0); g.stroke();
        break;

      case 'tank':
        glowOn(g, color, 6);
        g.fillStyle = '#070a12';
        rrect(g, -r * 0.95, -r * 0.98, r * 1.9, r * 0.5, 2); g.fill(); g.stroke();
        rrect(g, -r * 0.95, r * 0.48, r * 1.9, r * 0.5, 2); g.fill(); g.stroke();
        g.fillStyle = dark;
        g.lineWidth = Math.max(2, r * 0.16);
        rrect(g, -r * 0.8, -r * 0.62, r * 1.6, r * 1.24, 3); g.fill(); g.stroke();
        glowOff(g);
        g.strokeStyle = color;
        g.lineWidth = 1;
        g.globalAlpha = 0.7;
        g.beginPath();
        for (i = -2; i <= 2; i++) {
          g.moveTo(i * r * 0.36, -r * 0.93); g.lineTo(i * r * 0.36, -r * 0.55);
          g.moveTo(i * r * 0.36, r * 0.55); g.lineTo(i * r * 0.36, r * 0.93);
        }
        g.stroke();
        g.globalAlpha = 1;
        poly(g, 6, r * 0.42, 0);
        g.fillStyle = mix(color, '#05070f', 0.4);
        g.fill();
        g.strokeStyle = light;
        g.stroke();
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(r * 0.8, -r * 0.36); g.lineTo(r * 0.8, r * 0.36); g.stroke();
        break;

      case 'swarm':
        glowOn(g, color, 6);
        g.beginPath();
        g.moveTo(r * 1.05, 0); g.lineTo(0, r * 0.75); g.lineTo(-r, 0); g.lineTo(0, -r * 0.75);
        g.closePath(); g.fill(); g.stroke();
        g.fillStyle = light;
        circle(g, r * 0.15, 0, Math.max(1.2, r * 0.24)); g.fill();
        glowOff(g);
        break;

      case 'shield':
        glowOn(g, color, 7);
        poly(g, 5, r * 0.92, 0); g.fill(); g.stroke();
        glowOff(g);
        g.strokeStyle = light;
        g.lineWidth = 1.2;
        poly(g, 5, r * 0.5, 0); g.stroke();
        g.fillStyle = '#ffffff';
        glowOn(g, color, 5);
        circle(g, 0, 0, r * 0.16); g.fill();
        glowOff(g);
        break;

      case 'healer':
        glowOn(g, color, 7);
        g.fillStyle = '#070a12';
        circle(g, -r * 0.35, -r * 0.8, r * 0.28); g.fill(); g.stroke();
        circle(g, -r * 0.35, r * 0.8, r * 0.28); g.fill(); g.stroke();
        g.fillStyle = dark;
        circle(g, 0, 0, r * 0.82); g.fill(); g.stroke();
        g.fillStyle = light;
        g.fillRect(-r * 0.5, -r * 0.16, r, r * 0.32);
        g.fillRect(-r * 0.16, -r * 0.5, r * 0.32, r);
        glowOff(g);
        break;

      case 'boss':
        var spikes = mega ? 12 : 8;
        glowOn(g, color, 12);
        g.lineWidth = Math.max(2, r * 0.09);
        g.beginPath();
        for (i = 0; i < spikes * 2; i++) {
          a = i * Math.PI / spikes;
          var rr = i % 2 === 0 ? r : r * 0.7;
          if (i === 0) g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
          else g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        g.closePath(); g.fill(); g.stroke();
        glowOff(g);
        poly(g, 8, r * 0.56, Math.PI / 8);
        g.fillStyle = mix(color, '#05070f', 0.5);
        g.fill();
        g.strokeStyle = light;
        g.lineWidth = 1.5;
        g.stroke();
        if (mega) {
          g.strokeStyle = color;
          g.lineWidth = 2;
          poly(g, 6, r * 0.42, 0); g.stroke();
          poly(g, 6, r * 0.42, Math.PI / 6); g.stroke();
        }
        g.strokeStyle = light;
        g.lineWidth = Math.max(1.5, r * 0.07);
        g.beginPath();
        g.moveTo(r * 0.4, -r * 0.24); g.lineTo(r * 0.8, -r * 0.1);
        g.moveTo(r * 0.4, r * 0.24); g.lineTo(r * 0.8, r * 0.1);
        g.stroke();
        var core = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.28);
        core.addColorStop(0, '#ffffff');
        core.addColorStop(0.6, light);
        core.addColorStop(1, color);
        g.fillStyle = core;
        glowOn(g, color, 10);
        circle(g, 0, 0, r * 0.26); g.fill();
        glowOff(g);
        break;

      default: // drone
        glowOn(g, color, 6);
        g.lineWidth = Math.max(1.2, r * 0.1);
        for (i = 0; i < 3; i++) {
          a = Math.PI / 3 + i * TAU / 3;
          g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8); g.stroke();
          g.fillStyle = '#070a12';
          circle(g, Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8, r * 0.28); g.fill(); g.stroke();
        }
        g.fillStyle = dark;
        g.lineWidth = Math.max(1.4, r * 0.13);
        circle(g, 0, 0, r * 0.6); g.fill(); g.stroke();
        g.fillStyle = light;
        circle(g, r * 0.24, 0, r * 0.2); g.fill();
        glowOff(g);
    }
  }

  function silhouette(img, color) {
    var c = makeCanvas(img.width, img.height);
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  function enemySprite(def, typeId) {
    def = def || {};
    var shape = def.shape || typeId || 'drone';
    var r = def.radius || 12;
    var color = def.color || '#33ccff';
    var id = def.id || typeId || shape;
    var key = id + '|' + shape + '|' + r + '|' + color;
    var s = enemyCache[key];
    if (s) return s;
    var half = Math.ceil(r * 1.15 + (shape === 'boss' ? 16 : 9));
    var img = makeCanvas(half * 2 * SPR, half * 2 * SPR);
    var g = img.getContext('2d');
    g.setTransform(SPR, 0, 0, SPR, half * SPR, half * SPR);
    paintEnemy(g, shape, r, color, id === 'megaboss');
    s = {
      img: img,
      flash: silhouette(img, '#ffffff'),
      frost: silhouette(img, '#aee9ff'),
      half: half,
      size: half * 2,
      r: r
    };
    enemyCache[key] = s;
    return s;
  }

  // ---------------------------------------------------------------- partikler og effekter

  function spawnScale() {
    var n = particles.length;
    return n < 220 ? 1 : n < 420 ? 0.6 : n < MAX_PARTICLES ? 0.3 : 0;
  }

  function cnt(n) {
    var s = spawnScale();
    return s === 0 ? 0 : Math.max(1, Math.round(n * s));
  }

  // kind 0 = blød glød, kind 1 = gnist (streg i fartretningen)
  function addP(kind, x, y, vx, vy, life, size, color, drag, grow) {
    if (particles.length >= MAX_PARTICLES) return;
    var p = pool.pop() || {};
    p.kind = kind;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.max = life;
    p.size = size;
    p.color = color;
    p.drag = drag || 0;
    p.grow = grow || 0;
    p.spr = kind === 0 ? glowSprite(color) : null;
    particles.push(p);
  }

  function sparks(x, y, color, n, v0, v1, life, dir, spread) {
    for (var i = 0; i < n; i++) {
      var a = dir === undefined ? Math.random() * TAU : dir + (Math.random() - 0.5) * spread;
      var v = v0 + Math.random() * (v1 - v0);
      addP(1, x, y, Math.cos(a) * v, Math.sin(a) * v, life * (0.6 + Math.random() * 0.7),
        1.1 + Math.random() * 0.9, color, 3, 0);
    }
  }

  function puffs(x, y, color, n, v, life, size, grow) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU, sp = Math.random() * v;
      addP(0, x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * (0.6 + Math.random() * 0.7),
        size * (0.7 + Math.random() * 0.6), color, 2.5, grow || 0);
    }
  }

  function flash(x, y, r, color, life) {
    addP(0, x, y, 0, 0, life || 0.15, r, color, 0, 0.4);
  }

  function addRing(x, y, r0, r1, life, color, width) {
    if (rings.length >= MAX_RINGS) rings.shift();
    rings.push({ x: x, y: y, r0: r0, r1: r1, life: life, max: life, color: color, width: width || 2 });
  }

  // Beløb tæt på hinanden lægges sammen, så en sværm ikke giver en hel stribe af "+2".
  function addText(x, y, value, color) {
    for (var i = texts.length - 1; i >= 0; i--) {
      var t = texts[i];
      if (t.color === color && t.life > t.max * 0.45 && Math.abs(t.x - x) < 70 && Math.abs(t.y - y) < 50) {
        t.value += value;
        t.text = '+' + t.value;
        t.life = Math.max(t.life, t.max * 0.8);
        return;
      }
    }
    if (texts.length >= MAX_TEXTS) return;
    texts.push({ x: x, y: y, value: value, text: '+' + value, life: 0.9, max: 0.9, color: color });
  }

  function later(t, fn) {
    if (delayed.length < 60) delayed.push({ t: t, fn: fn });
  }

  function shake(mag, dur) {
    if (mag >= shakeMag * (shakeDur > 0 ? shakeT / shakeDur : 0)) {
      shakeMag = mag; shakeDur = dur; shakeT = dur;
    }
  }

  function explode(x, y, radius, color) {
    var hot = mix(color, '#ffffff', 0.5);
    addRing(x, y, radius * 0.2, radius, 0.35, color, 3);
    // Hold det store glimt dæmpet: mange samtidige eksplosioner må ikke brænde ud til hvidt.
    if (spawnScale() === 1) flash(x, y, radius * 0.8, color, 0.16);
    sparks(x, y, hot, cnt(12), 80, 260, 0.4);
    var ps = Math.min(16, radius * 0.22);
    puffs(x, y, color, cnt(6), radius * 1.8, 0.4, ps, 0.6);
    puffs(x, y, '#ff5a1a', cnt(3), radius * 1.2, 0.5, ps * 0.8, 0.9);
  }

  function updateEffects(dt) {
    var i, p;
    for (i = delayed.length - 1; i >= 0; i--) {
      delayed[i].t -= dt;
      if (delayed[i].t <= 0) {
        var fn = delayed[i].fn;
        delayed.splice(i, 1);
        fn();
      }
    }
    for (i = particles.length - 1; i >= 0; i--) {
      p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
        pool.push(p);
        continue;
      }
      var k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k; p.vy *= k;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (i = rings.length - 1; i >= 0; i--) {
      rings[i].life -= dt;
      if (rings[i].life <= 0) rings.splice(i, 1);
    }
    for (i = texts.length - 1; i >= 0; i--) {
      texts[i].life -= dt;
      if (texts[i].life <= 0) texts.splice(i, 1);
    }
    if (shakeT > 0) {
      shakeT -= dt;
      var m = shakeT > 0 ? shakeMag * (shakeT / shakeDur) : 0;
      shakeX = (Math.random() * 2 - 1) * m;
      shakeY = (Math.random() * 2 - 1) * m;
      if (shakeT <= 0) { shakeMag = 0; shakeX = 0; shakeY = 0; }
    }
    if (leakFlash > 0) leakFlash -= dt;
    if (bossWarn > 0) bossWarn -= dt;
    if (whiteFlash > 0) whiteFlash -= dt;
    trailAcc += dt;
    emitTrail = false;
    if (trailAcc >= 0.028) { trailAcc = 0; emitTrail = true; }
  }

  // ---------------------------------------------------------------- hændelser

  function onShoot(e) {
    var type = e.towerType, color = towerColor(type);
    var a = e.angle || 0, ca = Math.cos(a), sa = Math.sin(a);
    var tip = (MUZZLE[type] || MUZZLE.kanon)[1];
    var mx = e.x + ca * tip, my = e.y + sa * tip;
    switch (type) {
      case 'kanon':
        flash(mx, my, 11, color, 0.09);
        sparks(mx, my, mix(color, '#ffffff', 0.4), cnt(3), 90, 220, 0.16, a, 0.7);
        break;
      case 'laser':
        flash(mx, my, 12, color, 0.2);
        break;
      case 'raket':
        flash(mx, my, 12, '#ffd9a0', 0.12);
        for (var i = cnt(4); i > 0; i--) {
          var b = a + Math.PI + (Math.random() - 0.5) * 0.9, v = 40 + Math.random() * 70;
          addP(0, e.x - ca * 8, e.y - sa * 8, Math.cos(b) * v, Math.sin(b) * v, 0.4, 5, '#8aa0c8', 2, 1.2);
        }
        break;
      case 'fryser':
        flash(e.x, e.y, 22, color, 0.25);
        sparks(e.x, e.y, '#dff6ff', cnt(10), 120, 260, 0.45);
        break;
      case 'tesla':
        flash(e.x, e.y, 16, color, 0.14);
        sparks(e.x, e.y, mix(color, '#ffffff', 0.5), cnt(4), 60, 180, 0.2);
        break;
      case 'plasma':
        flash(mx, my, 30, color, 0.25);
        addRing(mx, my, 4, 26, 0.3, color, 3);
        sparks(mx, my, '#ffffff', cnt(9), 80, 280, 0.35, a, 1.6);
        shake(2.2, 0.14);
        break;
      default:
        flash(mx, my, 10, color, 0.1);
    }
  }

  function onHit(e) {
    if (hitBudget <= 0) return;
    hitBudget--;
    var type = e.towerType;
    var color = e.color || towerColor(type);
    if (type === 'laser') {
      if (Math.random() < 0.35) sparks(e.x, e.y, color, 1, 50, 150, 0.22);
      return;
    }
    if (type === 'fryser') {
      if (Math.random() < 0.5) addP(0, e.x, e.y, 0, -20, 0.3, 6, '#cfefff', 0, 0.5);
      return;
    }
    var big = type === 'plasma';
    sparks(e.x, e.y, mix(color, '#ffffff', 0.35), cnt(big ? 6 : 3), 60, big ? 260 : 170, 0.25);
    flash(e.x, e.y, big ? 18 : 9, color, 0.12);
  }

  function onExplosion(e) {
    explode(e.x, e.y, e.radius || 40, e.color || towerColor('raket'));
  }

  function onEnemyDeath(e) {
    var r = e.radius || 12, color = e.color || '#33ccff';
    var hot = mix(color, '#ffffff', 0.5);
    if (e.reward > 0) addText(e.x, e.y - r - 4, e.reward, '#ffe066');
    if (e.boss) {
      var x = e.x, y = e.y;
      shake(e.type === 'megaboss' ? 16 : 11, e.type === 'megaboss' ? 1.0 : 0.7);
      whiteFlash = 0.4;
      flash(x, y, r * 5, hot, 0.5);
      addRing(x, y, r * 0.5, r * 5, 0.7, color, 5);
      later(0.12, function () { addRing(x, y, r * 0.5, r * 7, 0.8, '#ffffff', 3); });
      later(0.25, function () { addRing(x, y, r * 0.5, r * 9, 0.9, color, 2); });
      sparks(x, y, hot, 40, 120, 520, 0.9);
      puffs(x, y, color, 22, r * 6, 0.9, r * 0.7, 1);
      for (var i = 0; i < 7; i++) {
        (function (k) {
          later(0.08 + k * 0.09, function () {
            var a = Math.random() * TAU, d = r * (0.6 + Math.random() * 1.6);
            explode(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.8 + Math.random() * 0.6), k % 2 ? color : '#ffb347');
          });
        })(i);
      }
      return;
    }
    addRing(e.x, e.y, r * 0.4, r * 2.2, 0.3, color, 2);
    if (spawnScale() === 1) flash(e.x, e.y, r * 1.7, color, 0.14);
    sparks(e.x, e.y, hot, cnt(4 + r * 0.4), 60, 220, 0.4);
    puffs(e.x, e.y, color, cnt(3 + r * 0.2), r * 5, 0.4, r * 0.55, 0.6);
  }

  function onEnemyLeak(e) {
    leakFlash = 0.55;
    shake(e.boss ? 9 : 4, 0.3);
    if (path.pts.length) {
      var end = portalPos(path.pts[path.pts.length - 1]);
      addRing(end.x, end.y, 6, 60, 0.45, '#ff3355', 4);
      sparks(end.x, end.y, '#ff6680', cnt(10), 80, 260, 0.4);
    }
  }

  function onBossSpawn() {
    bossWarn = 1.6;
    shake(3, 0.4);
  }

  function onWaveStart() {
    if (!path.pts.length) return;
    var s = portalPos(path.pts[0]);
    addRing(s.x, s.y, 8, 90, 0.7, theme.path, 3);
    later(0.15, function () { addRing(s.x, s.y, 8, 70, 0.6, '#ffffff', 2); });
  }

  function onBuild(e) {
    var color = towerColor(e.towerType);
    addRing(e.x, e.y, 34, 10, 0.3, color, 3);
    later(0.12, function () { addRing(e.x, e.y, 6, 38, 0.4, '#ffffff', 2); });
    flash(e.x, e.y, 30, color, 0.3);
    sparks(e.x, e.y, mix(color, '#ffffff', 0.4), cnt(12), 60, 200, 0.4);
  }

  function onUpgrade(e) {
    var color = towerColor(e.towerType);
    addRing(e.x, e.y, 8, 40, 0.45, color, 3);
    later(0.1, function () { addRing(e.x, e.y, 8, 54, 0.5, '#ffffff', 2); });
    flash(e.x, e.y, 34, '#ffffff', 0.25);
    for (var i = cnt(14); i > 0; i--) {
      addP(1, e.x + (Math.random() - 0.5) * 30, e.y + (Math.random() - 0.3) * 24,
        (Math.random() - 0.5) * 20, -90 - Math.random() * 130, 0.5 + Math.random() * 0.3,
        1.4, i % 2 ? '#ffffff' : color, 1.2, 0);
    }
  }

  function onSell(e) {
    addRing(e.x, e.y, 34, 4, 0.35, '#ffe066', 2);
    sparks(e.x, e.y, '#ffe066', cnt(12), 50, 190, 0.45);
    flash(e.x, e.y, 22, '#ffe066', 0.2);
    if (e.value > 0) addText(e.x, e.y - 16, e.value, '#ffe067');
  }

  function onWin() {
    var colors = ['#ffe066', theme.path, theme.accent, '#40ffb0', '#ff5a8a'];
    for (var i = 0; i < 10; i++) {
      (function (k) {
        later(0.15 + k * 0.22, function () {
          var x = 120 + Math.random() * (W - 240), y = 100 + Math.random() * (H - 260);
          var c = colors[k % colors.length];
          addRing(x, y, 6, 70, 0.6, c, 2);
          flash(x, y, 50, c, 0.3);
          sparks(x, y, c, cnt(26), 90, 300, 0.9);
        });
      })(i);
    }
  }

  function onLose() {
    leakFlash = 1.2;
    shake(10, 0.8);
  }

  // ---------------------------------------------------------------- rute og baggrund

  function portalPos(p) {
    return {
      x: Math.max(4, Math.min(W - 4, p.x)),
      y: Math.max(4, Math.min(H - 4, p.y))
    };
  }

  function buildPath(game) {
    var pts = [], i;
    if (game.pathPoints && game.pathPoints.length) {
      for (i = 0; i < game.pathPoints.length; i++) pts.push({ x: game.pathPoints[i].x, y: game.pathPoints[i].y });
    } else if (game.level && game.level.path) {
      for (i = 0; i < game.level.path.length; i++) {
        var c = game.level.path[i];
        pts.push({ x: c[0] * CELL + CELL / 2, y: c[1] * CELL + CELL / 2 });
      }
    }
    var lens = [], total = 0;
    for (i = 0; i + 1 < pts.length; i++) {
      var dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
      var l = Math.sqrt(dx * dx + dy * dy);
      lens.push(l);
      total += l;
    }
    path = { pts: pts, lens: lens, total: total };
  }

  function tracePath(g) {
    var pts = path.pts;
    g.beginPath();
    if (!pts.length) return;
    g.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  }

  // ---------------------------------------------------------------- rummet

  // Blød lysplet; sx/sy strækker den, så den kan blive en stribe eller ellipse.
  function softBlob(g, x, y, r, color, a, sx, sy, rot) {
    g.save();
    g.translate(x, y);
    g.rotate(rot || 0);
    g.scale(sx || 1, sy || 1);
    var gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
    gr.addColorStop(0, rgba(color, a));
    gr.addColorStop(0.45, rgba(color, a * 0.45));
    gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr;
    g.fillRect(-r, -r, r * 2, r * 2);
    g.restore();
  }

  // Normalfordelt tal omkring 0 (til stjerner, der klumper sig i Mælkevejen).
  function gauss(rand) {
    return (rand() + rand() + rand() + rand() - 2) / 2;
  }

  function drawSpace(g, rand) {
    var i, j, x, y;
    var third = mix(theme.accent, theme.path, 0.5);
    var deep = mix(theme.bg1, '#000000', 0.55);

    // Dybt, næsten sort rum med et strejf af banens farve
    var base = g.createLinearGradient(0, 0, W, H);
    base.addColorStop(0, deep);
    base.addColorStop(0.5, mix(theme.bg2, '#000000', 0.25));
    base.addColorStop(1, deep);
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);

    g.globalCompositeOperation = 'lighter';

    // Mælkevejen: et skråt bånd af lys og tætte, små stjerner
    var bandAng = (rand() - 0.5) * 1.4;
    var bandY = H * (0.3 + rand() * 0.4);
    var bandCol = mix(theme.path, '#ffffff', 0.35);
    softBlob(g, W / 2, bandY, W * 0.7, bandCol, 0.09, 1, 0.16, bandAng);
    softBlob(g, W / 2, bandY, W * 0.45, mix(theme.accent, '#ffffff', 0.4), 0.06, 1, 0.1, bandAng);
    var ca = Math.cos(bandAng), sa = Math.sin(bandAng);
    for (i = 0; i < 700; i++) {
      var along = (rand() - 0.5) * W * 1.4, across = gauss(rand) * 70;
      x = W / 2 + along * ca - across * sa;
      y = bandY + along * sa + across * ca;
      if (x < 0 || x > W || y < 0 || y > H) continue;
      g.fillStyle = rand() < 0.2 ? bandCol : '#ffffff';
      g.globalAlpha = 0.12 + rand() * 0.35;
      g.fillRect(x, y, 0.8, 0.8);
    }
    g.globalAlpha = 1;

    // Tåger: skyer af gas i banens farver, bygget af mange overlappende pletter
    var cols = [theme.path, theme.accent, third];
    for (i = 0; i < 3; i++) {
      var cx = rand() * W, cy = rand() * H;
      var dir = rand() * TAU;
      var col = cols[i % 3], col2 = cols[(i + 1) % 3];
      var n = 16 + (rand() * 10 | 0);
      for (j = 0; j < n; j++) {
        dir += (rand() - 0.5) * 1.1;
        cx += Math.cos(dir) * 34;
        cy += Math.sin(dir) * 34;
        var r = 50 + rand() * 150;
        softBlob(g, cx, cy, r, rand() < 0.7 ? col : col2, 0.05 + rand() * 0.07,
          1 + rand() * 0.8, 0.6 + rand() * 0.5, rand() * TAU);
      }
      // Lyse, varme kerner i skyen
      softBlob(g, cx, cy, 40 + rand() * 40, mix(col, '#ffffff', 0.5), 0.12);
    }

    // Mørke støvbælter giver tågerne struktur
    g.globalCompositeOperation = 'source-over';
    for (i = 0; i < 7; i++) {
      softBlob(g, rand() * W, rand() * H, 60 + rand() * 120, '#000000', 0.3 + rand() * 0.2,
        1.8 + rand(), 0.35 + rand() * 0.3, rand() * TAU);
    }
    g.globalCompositeOperation = 'lighter';

    // En fjern spiralgalakse
    var gx = W * (0.15 + rand() * 0.7), gy = H * (0.15 + rand() * 0.7), gRot = rand() * TAU;
    softBlob(g, gx, gy, 46, mix(third, '#ffffff', 0.4), 0.22, 1, 0.38, gRot);
    softBlob(g, gx, gy, 10, '#fff4dc', 0.7, 1, 0.6, gRot);
    for (i = 0; i < 160; i++) {
      var arm = i % 2 ? Math.PI : 0, t = rand();
      var ang = arm + t * 4.2, rad = 4 + t * 40;
      var lx = Math.cos(ang) * rad + gauss(rand) * 3, ly = (Math.sin(ang) * rad + gauss(rand) * 3) * 0.38;
      g.fillStyle = rand() < 0.5 ? '#ffffff' : mix(third, '#ffffff', 0.5);
      g.globalAlpha = 0.2 + rand() * 0.4;
      g.fillRect(gx + lx * Math.cos(gRot) - ly * Math.sin(gRot), gy + lx * Math.sin(gRot) + ly * Math.cos(gRot), 0.9, 0.9);
    }
    g.globalAlpha = 1;

    // Stjerner i forskellige farver og størrelser
    var starCols = ['#ffffff', '#ffffff', '#cfe3ff', '#fff1c9', '#ffd1e8', theme.path];
    for (i = 0; i < 420; i++) {
      x = rand() * W; y = rand() * H;
      var sz = rand() < 0.08 ? 1.8 : rand() < 0.35 ? 1.2 : 0.7;
      g.fillStyle = starCols[rand() * starCols.length | 0];
      g.globalAlpha = 0.25 + rand() * 0.65;
      g.fillRect(x, y, sz, sz);
    }
    g.globalAlpha = 1;

    // Nogle få klare stjerner med glorie og lysstråler
    for (i = 0; i < 7; i++) {
      x = rand() * W; y = rand() * H;
      var sc = starCols[rand() * 5 | 0], len = 7 + rand() * 12;
      softBlob(g, x, y, 10 + rand() * 8, sc, 0.45);
      g.fillStyle = sc;
      g.globalAlpha = 0.55;
      g.fillRect(x - len, y - 0.4, len * 2, 0.8);
      g.fillRect(x - 0.4, y - len, 0.8, len * 2);
      g.globalAlpha = 1;
      g.fillRect(x - 1, y - 1, 2, 2);
    }

    g.globalCompositeOperation = 'source-over';
    drawPlanet(g, rand);
  }

  // En planet halvt ude over kanten, med atmosfære og måske ringe og en måne.
  function drawPlanet(g, rand) {
    var corner = rand() * 4 | 0;
    var r = 80 + rand() * 70;
    var px = corner % 2 ? W - r * (0.35 + rand() * 0.3) : r * (0.35 + rand() * 0.3);
    var py = corner < 2 ? r * (0.3 + rand() * 0.3) : H - r * (0.3 + rand() * 0.3);
    var body = rand() < 0.5 ? theme.accent : mix(theme.accent, theme.path, 0.5);
    // Lyset kommer fra midten af banen
    var lx = W / 2 - px, ly = H / 2 - py, ll = Math.sqrt(lx * lx + ly * ly) || 1;
    lx /= ll; ly /= ll;
    var hasRing = rand() < 0.55, ringRot = (rand() - 0.5) * 0.9, ringCol = mix(body, '#ffffff', 0.45);

    function ring(front) {
      g.save();
      g.translate(px, py);
      g.rotate(ringRot);
      g.scale(1, 0.22);
      g.beginPath();
      if (front) g.arc(0, 0, r * 1.75, 0, Math.PI);
      else g.arc(0, 0, r * 1.75, Math.PI, TAU);
      g.restore();
      g.lineWidth = r * 0.07;
      g.strokeStyle = rgba(ringCol, 0.35);
      g.stroke();
      g.lineWidth = r * 0.02;
      g.strokeStyle = rgba(ringCol, 0.55);
      g.stroke();
    }

    // Glorie af atmosfære
    softBlob(g, px, py, r * 1.45, body, 0.22);
    if (hasRing) ring(false);

    g.save();
    circle(g, px, py, r);
    g.clip();
    var shade = g.createRadialGradient(px + lx * r * 0.45, py + ly * r * 0.45, r * 0.1, px, py, r * 1.05);
    shade.addColorStop(0, mix(body, '#ffffff', 0.25));
    shade.addColorStop(0.45, mix(body, '#000000', 0.45));
    shade.addColorStop(1, mix(body, '#000000', 0.88));
    g.fillStyle = shade;
    g.fillRect(px - r, py - r, r * 2, r * 2);
    // Skystriber
    g.globalCompositeOperation = 'overlay';
    for (var i = 0; i < 9; i++) {
      var by = py - r + rand() * r * 2;
      g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.22)';
      g.save();
      g.translate(px, by);
      g.rotate(ringRot);
      g.fillRect(-r * 1.3, -2 - rand() * 7, r * 2.6, 4 + rand() * 12);
      g.restore();
    }
    g.globalCompositeOperation = 'source-over';
    // Natsiden
    var night = g.createLinearGradient(px + lx * r, py + ly * r, px - lx * r, py - ly * r);
    night.addColorStop(0.35, 'rgba(0,0,0,0)');
    night.addColorStop(1, 'rgba(0,0,0,0.75)');
    g.fillStyle = night;
    g.fillRect(px - r, py - r, r * 2, r * 2);
    g.restore();

    // Lys kant af atmosfære på dagsiden
    g.save();
    circle(g, px, py, r - 1);
    g.lineWidth = 3;
    g.strokeStyle = rgba(mix(body, '#ffffff', 0.5), 0.6);
    g.shadowColor = body;
    g.shadowBlur = 14 * viewScale;
    var a0 = Math.atan2(ly, lx);
    g.beginPath();
    g.arc(px, py, r - 1, a0 - 1.2, a0 + 1.2);
    g.stroke();
    g.restore();

    if (hasRing) ring(true);

    // Lille måne
    if (rand() < 0.7) {
      var ma = Math.atan2(ly, lx) + (rand() - 0.5) * 1.6, md = r * (1.9 + rand() * 0.6), mr = 9 + rand() * 9;
      var mx = px + Math.cos(ma) * md, my = py + Math.sin(ma) * md;
      softBlob(g, mx, my, mr * 2.2, '#cfd8ff', 0.12);
      var mg = g.createRadialGradient(mx + lx * mr * 0.5, my + ly * mr * 0.5, 1, mx, my, mr);
      mg.addColorStop(0, '#e8ecff');
      mg.addColorStop(0.6, '#6b7290');
      mg.addColorStop(1, '#14172a');
      g.fillStyle = mg;
      circle(g, mx, my, mr);
      g.fill();
    }
  }

  function buildBackground() {
    if (!canvas) return;
    bgWidth = canvas.width;
    bgLayer = makeCanvas(W * viewScale, H * viewScale);
    var g = bgLayer.getContext('2d');
    g.setTransform(viewScale, 0, 0, viewScale, 0, 0);
    var levelId = (currentGame && currentGame.level && currentGame.level.id) || 1;
    var rand = rng(levelId * 7919 + 13);
    var i, x, y;

    drawSpace(g, rand);

    // Gitter (svagere, så rummet bag det kan ses)
    g.strokeStyle = theme.grid;
    g.lineWidth = 1;
    g.globalAlpha = 0.32;
    g.beginPath();
    for (i = 0; i <= W; i += CELL) { g.moveTo(i + 0.5, 0); g.lineTo(i + 0.5, H); }
    for (i = 0; i <= H; i += CELL) { g.moveTo(0, i + 0.5); g.lineTo(W, i + 0.5); }
    g.stroke();
    g.globalAlpha = 0.3;
    g.fillStyle = mix(theme.grid, '#ffffff', 0.35);
    for (x = CELL; x < W; x += CELL) {
      for (y = CELL; y < H; y += CELL) g.fillRect(x - 0.5, y - 0.5, 2, 2);
    }
    g.globalAlpha = 1;

    // Rute: neonkanter om en mørk bane
    if (path.pts.length > 1) {
      g.lineJoin = 'round';
      g.lineCap = 'butt';
      tracePath(g);
      g.shadowColor = theme.path;
      g.shadowBlur = 26 * viewScale;
      g.strokeStyle = rgba(theme.path, 0.22);
      g.lineWidth = 36;
      g.stroke();
      g.shadowBlur = 10 * viewScale;
      g.strokeStyle = rgba(theme.path, 0.95);
      g.lineWidth = 33;
      g.stroke();
      g.shadowBlur = 0;
      g.shadowColor = 'rgba(0,0,0,0)';
      g.strokeStyle = mix(theme.bg1, '#000000', 0.45);
      g.lineWidth = 29;
      g.stroke();
      g.strokeStyle = rgba(theme.path, 0.07);
      g.lineWidth = 29;
      g.stroke();
      g.strokeStyle = rgba(theme.path, 0.22);
      g.lineWidth = 1;
      g.setLineDash([2, 10]);
      g.stroke();
      g.setLineDash([]);
    }

    // Mørkere kanter
    var vig = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.72);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.5)');
    g.fillStyle = vig;
    g.fillRect(0, 0, W, H);

    twinkles = [];
    for (i = 0; i < 34; i++) {
      twinkles.push({ x: rand() * W, y: rand() * H, sp: 0.8 + rand() * 2.4, ph: rand() * TAU, big: rand() < 0.3 });
    }
  }

  function drawPortal(p, color, dir) {
    var pos = portalPos(p);
    drawGlow(pos.x, pos.y, 34 + Math.sin(time * 3) * 4, color, 0.55);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (var i = 0; i < 3; i++) {
      var a0 = time * (1.1 + i * 0.6) * (i % 2 ? -1 : 1) * dir;
      ctx.globalAlpha = 0.85 - i * 0.22;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 9 + i * 6, a0, a0 + Math.PI * 1.25);
      ctx.stroke();
    }
    drawGlow(pos.x, pos.y, 9, '#ffffff', 0.7);
  }

  // Stjerneskud, der af og til farer hen over himlen bag ruten.
  function drawMeteors() {
    var dt = Math.min(0.05, Math.max(0, time - meteorClock));
    meteorClock = time;
    meteorWait -= dt;
    if (meteorWait <= 0) {
      meteorWait = 3 + Math.random() * 6;
      var ang = 0.35 + Math.random() * 0.5, sp = 520 + Math.random() * 380;
      var fromLeft = Math.random() < 0.5;
      meteors.push({
        x: fromLeft ? Math.random() * W * 0.6 : W * 0.4 + Math.random() * W * 0.6,
        y: Math.random() * H * 0.4,
        vx: (fromLeft ? 1 : -1) * Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        life: 0, max: 0.7 + Math.random() * 0.6,
        color: Math.random() < 0.5 ? '#ffffff' : mix(theme.path, '#ffffff', 0.5)
      });
    }
    ctx.lineCap = 'round';
    for (var i = meteors.length - 1; i >= 0; i--) {
      var m = meteors[i];
      m.life += dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      if (m.life >= m.max) { meteors.splice(i, 1); continue; }
      var fade = Math.sin(Math.PI * m.life / m.max);
      var tx = m.x - m.vx * 0.16, ty = m.y - m.vy * 0.16;
      var tail = ctx.createLinearGradient(m.x, m.y, tx, ty);
      tail.addColorStop(0, rgba(m.color, 0.9 * fade));
      tail.addColorStop(1, rgba(m.color, 0));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = tail;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.fillStyle = m.color;
      ctx.globalAlpha = fade;
      ctx.fillRect(m.x - 1, m.y - 1, 2, 2);
    }
    ctx.fillStyle = '#ffffff';
  }

  function drawAmbient() {
    var i;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ffffff';
    for (i = 0; i < twinkles.length; i++) {
      var s = twinkles[i];
      var a = 0.5 + 0.5 * Math.sin(time * s.sp + s.ph);
      ctx.globalAlpha = a * a * 0.9;
      if (s.big) {
        ctx.fillRect(s.x - 2.5, s.y, 6, 1);
        ctx.fillRect(s.x, s.y - 2.5, 1, 6);
      } else {
        ctx.fillRect(s.x, s.y, 1.5, 1.5);
      }
    }
    drawMeteors();

    // Retningspile, der løber langs ruten.
    if (path.total > 0) {
      var spacing = 64, off = (time * 42) % spacing;
      var seg = 0, segStart = 0;
      ctx.beginPath();
      for (var d = off; d < path.total; d += spacing) {
        while (seg < path.lens.length - 1 && d > segStart + path.lens[seg]) {
          segStart += path.lens[seg];
          seg++;
        }
        var p0 = path.pts[seg], p1 = path.pts[seg + 1], len = path.lens[seg] || 1;
        var ux = (p1.x - p0.x) / len, uy = (p1.y - p0.y) / len;
        var x = p0.x + ux * (d - segStart), y = p0.y + uy * (d - segStart);
        if (x < -10 || x > W + 10 || y < -10 || y > H + 10) continue;
        ctx.moveTo(x - ux * 4 - uy * 6, y - uy * 4 + ux * 6);
        ctx.lineTo(x + ux * 4, y + uy * 4);
        ctx.lineTo(x - ux * 4 + uy * 6, y - uy * 4 - ux * 6);
      }
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'round';
      ctx.strokeStyle = theme.path;
      ctx.globalAlpha = 0.16;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      drawPortal(path.pts[0], theme.path, 1);
      drawPortal(path.pts[path.pts.length - 1], theme.accent, -1);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- rækkevidde og bygning

  function drawRange(x, y, r, color, strong) {
    if (!(r > 0)) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = strong ? 0.08 : 0.04;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = strong ? 0.75 : 0.35;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -time * 22;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawBrackets(x, y, color) {
    var h = 19 + Math.sin(time * 5) * 1.5, c = 6;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (var i = 0; i < 4; i++) {
      var sx = i % 2 ? 1 : -1, sy = i < 2 ? -1 : 1;
      ctx.moveTo(x + sx * h, y + sy * (h - c));
      ctx.lineTo(x + sx * h, y + sy * h);
      ctx.lineTo(x + sx * (h - c), y + sy * h);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawSelection(game, ui) {
    var sel = ui.selected;
    if (sel && sel.stats) {
      drawRange(sel.x, sel.y, sel.stats.range, (sel.def && sel.def.color) || towerColor(sel.type), true);
    }
    if (ui.hover && !ui.buildType && game.towerAt) {
      var t = game.towerAt(ui.hover.cx, ui.hover.cy);
      if (t && t !== sel && t.stats) {
        drawRange(t.x, t.y, t.stats.range, (t.def && t.def.color) || towerColor(t.type), false);
      }
    }
  }

  function drawBuildPreview(game, ui) {
    var hv = ui.hover;
    if (!hv) return;
    var x = hv.cx * CELL, y = hv.cy * CELL;
    if (hv.cx < 0 || hv.cy < 0 || x >= W || y >= H) return;
    if (!ui.buildType) {
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3);
      ctx.globalAlpha = 1;
      return;
    }
    var def = towerDef(ui.buildType);
    var ok = !!(game.canBuild && game.canBuild(hv.cx, hv.cy));
    var afford = !def || game.money === undefined || game.money >= def.cost;
    var color = !ok ? '#ff3355' : afford ? '#33ff99' : '#ffcc33';
    var cx = x + CELL / 2, cy = y + CELL / 2;
    var range = def && def.levels && def.levels[0] ? def.levels[0].range : 0;

    drawRange(cx, cy, range, ok ? (afford ? '#ffffff' : color) : color, ok);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.2 + 0.06 * Math.sin(time * 6);
    ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 2, y + 2, CELL - 4, CELL - 4);
    if (ok) {
      var spr = towerSprite(ui.buildType, 0, def && def.color);
      ctx.globalAlpha = afford ? 0.75 : 0.4;
      ctx.drawImage(spr.base, cx - TH, cy - TH, TS, TS);
      localT(cx, cy, -Math.PI / 2);
      ctx.drawImage(spr.turret, -TH, -TH, TS, TS);
      baseT();
    } else {
      ctx.beginPath();
      ctx.moveTo(x + 11, y + 11); ctx.lineTo(x + CELL - 11, y + CELL - 11);
      ctx.moveTo(x + CELL - 11, y + 11); ctx.lineTo(x + 11, y + CELL - 11);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- tårne

  function turretAngle(t, i) {
    if (t.type === 'fryser') return time * 0.5 + i * 1.3;
    if (t.type === 'tesla') return -time * 0.9 + i * 0.7;
    return t.angle || 0;
  }

  function drawTowers(game, ui) {
    var towers = game.towers || [];
    var i, t, spr, a, since, color;

    for (i = 0; i < towers.length; i++) {
      t = towers[i];
      spr = towerSprite(t.type, t.level, t.def && t.def.color);
      baseT();
      ctx.drawImage(spr.base, t.x - TH, t.y - TH, TS, TS);
      a = turretAngle(t, i);
      since = t.sinceShot === undefined ? 9 : t.sinceShot;
      var kick = t.type === 'kanon' ? 3 : t.type === 'raket' ? 2 : t.type === 'plasma' ? 5 : 0;
      var rec = kick && since < 0.18 ? kick * (1 - since / 0.18) : 0;
      localT(t.x - Math.cos(a) * rec, t.y - Math.sin(a) * rec, a);
      ctx.drawImage(spr.turret, -TH, -TH, TS, TS);
    }
    baseT();

    if (ui.selected) {
      drawBrackets(ui.selected.x, ui.selected.y, '#ffffff');
    }

    // Levende glød oven på tårnene
    ctx.globalCompositeOperation = 'lighter';
    var tick = Math.floor(time * 22);
    for (i = 0; i < towers.length; i++) {
      t = towers[i];
      color = (t.def && t.def.color) || towerColor(t.type);
      since = t.sinceShot === undefined ? 9 : t.sinceShot;
      var lvl = Math.max(0, Math.min(2, t.level | 0));
      var tip = (MUZZLE[t.type] || MUZZLE.kanon)[lvl];
      a = t.angle || 0;
      var mx = t.x + Math.cos(a) * tip, my = t.y + Math.sin(a) * tip;
      switch (t.type) {
        case 'kanon':
        case 'raket':
          if (since < 0.08) drawGlow(mx, my, 13 + lvl * 2, color, 1 - since / 0.08);
          break;
        case 'laser':
          drawGlow(mx, my, t.target ? 9 + Math.sin(time * 40 + i) * 2 : 5, color, t.target ? 0.95 : 0.5);
          break;
        case 'fryser':
          drawGlow(t.x, t.y, 13 + Math.sin(time * 2.5 + i) * 2 + (since < 0.3 ? (0.3 - since) * 40 : 0), color, 0.55);
          break;
        case 'tesla':
          drawGlow(t.x, t.y, 12 + Math.sin(time * 9 + i * 2) * 2 + (since < 0.15 ? 8 : 0), color, 0.75);
          var rand = rng(tick * 31 + i * 977 + 5);
          ctx.strokeStyle = mix(color, '#ffffff', 0.6);
          ctx.lineWidth = 1;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          for (var k = 0; k < 2; k++) {
            var ra = rand() * TAU, rl = 9 + rand() * 6 + lvl * 2;
            var kx = t.x + Math.cos(ra + 0.4) * rl * 0.55, ky = t.y + Math.sin(ra + 0.4) * rl * 0.55;
            ctx.moveTo(t.x + Math.cos(ra) * 3, t.y + Math.sin(ra) * 3);
            ctx.lineTo(kx, ky);
            ctx.lineTo(t.x + Math.cos(ra) * rl, t.y + Math.sin(ra) * rl);
          }
          ctx.stroke();
          break;
        case 'plasma':
          var rate = (t.stats && t.stats.fireRate) || 0.5;
          var charge = t.cooldown === undefined ? 1 : clamp01(1 - t.cooldown * rate);
          var hx = t.x + Math.cos(a) * tip * 0.55, hy = t.y + Math.sin(a) * tip * 0.55;
          drawGlow(hx, hy, 5 + charge * 9 + Math.sin(time * 30) * charge, color, 0.3 + charge * 0.6);
          if (since < 0.16) drawGlow(mx, my, 30, color, 1 - since / 0.16);
          break;
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- fjender

  function drawEnemies(game) {
    var enemies = game.enemies || [];
    var i, e, spr, def, r;

    for (i = 0; i < enemies.length; i++) {
      e = enemies[i];
      if (e.alive === false) continue;
      spr = enemySprite(e.def, e.type);
      localT(e.x, e.y, e.angle || 0);
      ctx.drawImage(spr.img, -spr.half, -spr.half, spr.size, spr.size);
      if (e.slowFactor < 1) {
        ctx.globalAlpha = 0.18 + 0.3 * clamp01(1 - e.slowFactor);
        ctx.drawImage(spr.frost, -spr.half, -spr.half, spr.size, spr.size);
        ctx.globalAlpha = 1;
      }
      if (e.hitFlash !== undefined && e.hitFlash < 0.09) {
        ctx.globalAlpha = 0.4 * (1 - e.hitFlash / 0.09);
        ctx.drawImage(spr.flash, -spr.half, -spr.half, spr.size, spr.size);
        ctx.globalAlpha = 1;
      }
    }
    baseT();

    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < enemies.length; i++) {
      e = enemies[i];
      if (e.alive === false) continue;
      def = e.def || {};
      r = e.radius || def.radius || 12;
      var color = def.color || '#33ccff';
      var a = e.angle || 0;

      switch (def.shape) {
        case 'sprinter':
          drawGlow(e.x - Math.cos(a) * r * 0.8, e.y - Math.sin(a) * r * 0.8, r * (0.8 + Math.random() * 0.3), color, 0.85);
          break;
        case 'healer':
          if (def.heal && def.heal.radius) {
            var hp = (time * 0.7 + (e.id || i) * 0.37) % 1;
            ctx.globalAlpha = (1 - hp) * 0.4;
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(e.x, e.y, r + (def.heal.radius - r) * hp, 0, TAU);
            ctx.stroke();
          }
          break;
        case 'boss':
          drawGlow(e.x, e.y, r * (0.75 + 0.12 * Math.sin(time * 5)), color, 0.6);
          ctx.globalAlpha = 0.7;
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.setLineDash([r * 0.5, r * 0.3]);
          ctx.lineDashOffset = time * 30;
          ctx.beginPath();
          ctx.arc(e.x, e.y, r * 1.22, 0, TAU);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
          break;
      }

      if (e.shield > 0) {
        var sr = e.maxShield > 0 ? clamp01(e.shield / e.maxShield) : 1;
        var rot = time * 2 + i;
        ctx.strokeStyle = '#7fd4ff';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.25 + sr * 0.4;
        ctx.beginPath();
        ctx.arc(e.x, e.y, r + 4.5, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = '#e6f8ff';
        ctx.lineWidth = 2.2;
        ctx.globalAlpha = 0.4 + sr * 0.55;
        ctx.beginPath();
        ctx.arc(e.x, e.y, r + 4.5, rot, rot + 1.1 + sr);
        ctx.stroke();
      }

      if (e.slowFactor < 1) {
        ctx.strokeStyle = '#bff0ff';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.arc(e.x, e.y, r + 2, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        if (gameAdvanced && emitTrail && Math.random() < 0.25 && particles.length < 420) {
          addP(0, e.x + (Math.random() - 0.5) * r * 1.6, e.y + (Math.random() - 0.5) * r * 1.6,
            0, 12, 0.5, 3, '#cfefff', 0, 0);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawBars(game) {
    var enemies = game.enemies || [];
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.alive === false || !(e.maxHp > 0)) continue;
      var def = e.def || {};
      var ratio = clamp01(e.hp / e.maxHp);
      var hasShield = e.maxShield > 0 && e.shield > 0;
      if (ratio >= 1 && !def.boss && !hasShield) continue;
      var r = e.radius || def.radius || 12;
      var w = def.boss ? Math.max(44, r * 2.4) : Math.max(18, r * 2);
      var h = def.boss ? 5 : 3;
      var x = e.x - w / 2, y = e.y - r - (def.boss ? 16 : 9);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
      ctx.fillStyle = ratio > 0.6 ? '#3dff8a' : ratio > 0.3 ? '#ffd23d' : '#ff4060';
      ctx.fillRect(x, y, w * ratio, h);
      if (hasShield) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(x - 1, y - 4, w + 2, 3);
        ctx.fillStyle = '#7fd4ff';
        ctx.fillRect(x, y - 3.5, w * clamp01(e.shield / e.maxShield), 2);
      }
    }
  }

  // ---------------------------------------------------------------- projektiler

  function drawProjectiles(game) {
    var list = game.projectiles || [];
    var i, p, a, color;

    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p.kind !== 'rocket') continue;
      localT(p.x, p.y, p.angle || 0);
      ctx.fillStyle = '#d6dcea';
      ctx.fillRect(-6, -2.2, 10, 4.4);
      ctx.fillStyle = p.color || towerColor('raket');
      ctx.beginPath();
      ctx.moveTo(8, 0); ctx.lineTo(4, -2.2); ctx.lineTo(4, 2.2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-6, -2.2); ctx.lineTo(-8, -4.6); ctx.lineTo(-3, -2.2);
      ctx.moveTo(-6, 2.2); ctx.lineTo(-8, 4.6); ctx.lineTo(-3, 2.2);
      ctx.fill();
    }
    baseT();

    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (i = 0; i < list.length; i++) {
      p = list[i];
      a = p.angle || 0;
      color = p.color || towerColor(p.towerType);
      var ca = Math.cos(a), sa = Math.sin(a);
      if (p.kind === 'rocket') {
        var tx = p.x - ca * 8, ty = p.y - sa * 8;
        drawGlow(tx, ty, 8 + Math.random() * 3, '#ffb347', 0.95);
        if (gameAdvanced && emitTrail && particles.length < 480) {
          addP(0, tx, ty, -ca * 30 + (Math.random() - 0.5) * 24, -sa * 30 + (Math.random() - 0.5) * 24,
            0.38, 5, Math.random() < 0.5 ? '#ff8a2a' : '#8aa0c8', 1.5, 1.1);
        }
      } else {
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - ca * 12, p.y - sa * 12);
        ctx.stroke();
        drawGlow(p.x, p.y, 7, color, 1);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- stråler og lyn

  function boltPath(x1, y1, x2, y2, rand, amp) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;
    var n = Math.max(2, Math.min(14, Math.round(len / 13)));
    ctx.moveTo(x1, y1);
    for (var i = 1; i < n; i++) {
      var f = i / n, off = (rand() - 0.5) * 2 * amp;
      ctx.lineTo(x1 + dx * f + nx * off, y1 + dy * f + ny * off);
    }
    ctx.lineTo(x2, y2);
    // En lille sidegren giver lynet liv.
    if (len > 30) {
      var bf = 0.25 + rand() * 0.5, ba = Math.atan2(dy, dx) + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.5);
      var bl = 10 + rand() * 16;
      var bx = x1 + dx * bf, by = y1 + dy * bf;
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + Math.cos(ba) * bl * 0.5 + (rand() - 0.5) * 5, by + Math.sin(ba) * bl * 0.5 + (rand() - 0.5) * 5);
      ctx.lineTo(bx + Math.cos(ba) * bl, by + Math.sin(ba) * bl);
    }
  }

  function tripleStroke(color, width, alpha) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.22 * alpha;
    ctx.lineWidth = width * 2.6;
    ctx.stroke();
    ctx.globalAlpha = 0.7 * alpha;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(0.8, width * 0.38);
    ctx.stroke();
  }

  function railWidth(game, b) {
    var towers = game.towers || [], p = b.points[0];
    for (var i = 0; i < towers.length; i++) {
      var t = towers[i];
      if (t.type === b.towerType && Math.abs(t.x - p.x) < 1 && Math.abs(t.y - p.y) < 1) {
        return (t.stats && t.stats.width) || 12;
      }
    }
    return 12;
  }

  function drawBeams(game) {
    var beams = game.beams || [];
    if (!beams.length) return;
    var tick = Math.floor(time * 28);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (var i = 0; i < beams.length; i++) {
      var b = beams[i], pts = b.points;
      if (!pts || !pts.length) continue;
      var color = b.color || towerColor(b.towerType);
      var t = b.maxLife > 0 ? clamp01(b.life / b.maxLife) : 1;
      var fresh = false;
      if (seenBeams && !seenBeams.has(b)) { seenBeams.add(b); fresh = true; }
      var p0 = pts[0], p1 = pts[1], dx, dy, len, ux, uy, sx, sy, j;

      if (b.kind === 'frost') {
        var R = b.radius || 80, p = 1 - t;
        var rr = R * (0.15 + 0.85 * (1 - (1 - p) * (1 - p)));
        drawGlow(p0.x, p0.y, rr * 1.15, color, 0.3 * t);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.85 * t;
        ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.arc(p0.x, p0.y, rr, 0, TAU); ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = t;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.globalAlpha = 0.45 * t;
        ctx.beginPath(); ctx.arc(p0.x, p0.y, rr * 0.72, 0, TAU); ctx.stroke();
        // Iskrystaller på ringen
        ctx.globalAlpha = 0.9 * t;
        ctx.beginPath();
        for (j = 0; j < 12; j++) {
          var fa = j * TAU / 12 + i;
          ctx.moveTo(p0.x + Math.cos(fa) * (rr - 5), p0.y + Math.sin(fa) * (rr - 5));
          ctx.lineTo(p0.x + Math.cos(fa) * (rr + 5), p0.y + Math.sin(fa) * (rr + 5));
        }
        ctx.stroke();
        continue;
      }

      if (!p1) continue;
      dx = p1.x - p0.x; dy = p1.y - p0.y;
      len = Math.sqrt(dx * dx + dy * dy) || 1;
      ux = dx / len; uy = dy / len;

      if (b.kind === 'laser') {
        var so = len > 26 ? 21 : 0;
        sx = p0.x + ux * so; sy = p0.y + uy * so;
        var flick = 1 + 0.18 * Math.sin(time * 55 + i * 3);
        var la = 0.45 + 0.55 * t;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(p1.x, p1.y);
        tripleStroke(color, 3.4 * flick, la);
        drawGlow(p1.x, p1.y, 11 + Math.random() * 4, color, la);
        drawGlow(p1.x, p1.y, 5, '#ffffff', la);
        if (gameAdvanced && emitTrail && particles.length < 420) {
          sparks(p1.x, p1.y, color, 1, 50, 160, 0.25);
        }
      } else if (b.kind === 'rail') {
        // Motoren oplyser strålens fulde bredde; den lysende kerne tegnes smallere.
        var w = (b.width > 0 ? b.width : railWidth(game, b)) * 0.5;
        var so2 = len > 34 ? 28 : 0;
        sx = p0.x + ux * so2; sy = p0.y + uy * so2;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(p1.x, p1.y);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.25 * t;
        ctx.lineWidth = w * 2.2;
        ctx.stroke();
        ctx.globalAlpha = 0.75 * t;
        ctx.lineWidth = w * (0.35 + 0.65 * t);
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = t;
        ctx.lineWidth = Math.max(1, w * 0.4 * t);
        ctx.stroke();
        // Ringe, der udvider sig langs strålen, mens den dør ud
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.7 * t;
        ctx.beginPath();
        var rw = w * (0.8 + (1 - t) * 1.6);
        for (var d = 30; d < len - so2; d += 46) {
          var qx = sx + ux * d, qy = sy + uy * d;
          ctx.moveTo(qx - uy * rw, qy + ux * rw);
          ctx.lineTo(qx + uy * rw, qy - ux * rw);
        }
        ctx.stroke();
        drawGlow(sx, sy, 22 * t + 6, color, t);
        if (fresh) {
          var n = Math.min(cnt(14), Math.floor(len / 30));
          for (j = 0; j < n; j++) {
            var f = Math.random() * (len - so2), side = Math.random() < 0.5 ? -1 : 1, v = 30 + Math.random() * 90;
            addP(1, sx + ux * f, sy + uy * f, -uy * side * v, ux * side * v, 0.4 + Math.random() * 0.3,
              1.3, mix(color, '#ffffff', 0.5), 2.5, 0);
          }
        }
      } else { // tesla
        var rand = rng(tick * 131 + i * 7717 + 3);
        ctx.beginPath();
        for (j = 0; j + 1 < pts.length; j++) {
          boltPath(pts[j].x, pts[j].y, pts[j + 1].x, pts[j + 1].y, rand, 7);
        }
        tripleStroke(color, 2.6, 0.35 + 0.65 * t);
        // Et tyndt ekstra lyn giver dybde
        ctx.beginPath();
        for (j = 0; j + 1 < pts.length; j++) {
          boltPath(pts[j].x, pts[j].y, pts[j + 1].x, pts[j + 1].y, rand, 11);
        }
        ctx.strokeStyle = mix(color, '#ffffff', 0.5);
        ctx.globalAlpha = 0.45 * t;
        ctx.lineWidth = 1;
        ctx.stroke();
        for (j = 1; j < pts.length; j++) {
          drawGlow(pts[j].x, pts[j].y, 10, color, 0.25 + 0.45 * t);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- partikler, ringe, tekst

  function drawParticles() {
    var i, p, a, s;
    ctx.globalCompositeOperation = 'lighter';

    for (i = 0; i < rings.length; i++) {
      var r = rings[i];
      a = r.life / r.max;
      var e = 1 - a;
      var rad = r.r0 + (r.r1 - r.r0) * (1 - (1 - e) * (1 - e));
      ctx.globalAlpha = a;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (0.4 + a * 0.6);
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.5, rad), 0, TAU);
      ctx.stroke();
    }

    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      if (p.kind !== 0) continue;
      a = p.life / p.max;
      s = p.size * (1 + p.grow * (1 - a));
      ctx.globalAlpha = a;
      ctx.drawImage(p.spr, p.x - s, p.y - s, s * 2, s * 2);
    }

    var last = null;
    ctx.lineCap = 'round';
    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      if (p.kind !== 1) continue;
      a = p.life / p.max;
      if (p.color !== last) { ctx.strokeStyle = p.color; last = p.color; }
      ctx.globalAlpha = a;
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawTexts() {
    if (!texts.length) return;
    ctx.font = 'bold 14px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i], a = t.life / t.max;
      var y = t.y - (1 - a) * 30;
      ctx.globalAlpha = Math.min(1, a * 2.2);
      ctx.strokeText(t.text, t.x, y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, y);
    }
    ctx.globalAlpha = 1;
  }

  function drawScreenFx() {
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
    if (bossWarn > 0) {
      var bw = clamp01(bossWarn / 1.6);
      ctx.globalAlpha = bw * (0.45 + 0.4 * Math.sin(time * 14));
      ctx.drawImage(vignetteSprite(theme.accent), 0, 0, W, H);
    }
    if (leakFlash > 0) {
      ctx.globalAlpha = clamp01(leakFlash / 0.55) * 0.85;
      ctx.drawImage(vignetteSprite('#ff2244'), 0, 0, W, H);
    }
    if (whiteFlash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp01(whiteFlash / 0.4) * 0.45;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- offentligt

  var NO_UI = { hover: null, buildType: null, selected: null };

  function clearEffects() {
    while (particles.length) pool.push(particles.pop());
    rings.length = 0;
    texts.length = 0;
    delayed.length = 0;
    shakeT = 0; shakeMag = 0; shakeX = 0; shakeY = 0;
    leakFlash = 0; bossWarn = 0; whiteFlash = 0;
  }

  TD.Renderer = {
    init: function (cnv) {
      canvas = cnv;
      ctx = canvas.getContext('2d');
      if (TD.C) {
        W = TD.C.FIELD_W || W;
        H = TD.C.FIELD_H || H;
        CELL = TD.C.CELL || CELL;
      }
      viewScale = canvas.width / W;
      bgLayer = null;
      if (!subscribed && TD.events) {
        subscribed = true;
        TD.events.on('shoot', onShoot);
        TD.events.on('hit', onHit);
        TD.events.on('explosion', onExplosion);
        TD.events.on('enemyDeath', onEnemyDeath);
        TD.events.on('enemyLeak', onEnemyLeak);
        TD.events.on('bossSpawn', onBossSpawn);
        TD.events.on('waveStart', onWaveStart);
        TD.events.on('build', onBuild);
        TD.events.on('upgrade', onUpgrade);
        TD.events.on('sell', onSell);
        TD.events.on('win', onWin);
        TD.events.on('lose', onLose);
      }
    },

    reset: function (game) {
      currentGame = game || null;
      clearEffects();
      var t = (game && game.level && game.level.theme) || {};
      theme = {
        bg1: t.bg1 || DEFAULT_THEME.bg1,
        bg2: t.bg2 || DEFAULT_THEME.bg2,
        grid: t.grid || DEFAULT_THEME.grid,
        path: t.path || DEFAULT_THEME.path,
        accent: t.accent || DEFAULT_THEME.accent
      };
      path = { pts: [], lens: [], total: 0 };
      if (game) buildPath(game);
      lastGameTime = game ? game.time : -1;
      if (canvas) {
        viewScale = canvas.width / W;
        buildBackground();
      }
    },

    draw: function (game, ui, dt) {
      if (!ctx || !game) return;
      ui = ui || NO_UI;
      dt = Math.min(0.05, Math.max(0, dt || 0));
      time += dt;

      if (game !== currentGame) TD.Renderer.reset(game);
      if (!bgLayer || bgWidth !== canvas.width) {
        viewScale = canvas.width / W;
        buildBackground();
      }

      gameAdvanced = game.time !== lastGameTime;
      lastGameTime = game.time;
      hitBudget = 14;
      updateEffects(dt);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowBlur = 0;
      if (shakeX || shakeY) {
        ctx.fillStyle = theme.bg1;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bgLayer, shakeX * viewScale, shakeY * viewScale);

      baseT();
      drawAmbient();
      drawSelection(game, ui);
      drawTowers(game, ui);
      drawEnemies(game);
      drawProjectiles(game);
      drawBeams(game);
      drawParticles();
      drawBars(game);
      drawBuildPreview(game, ui);
      drawTexts();
      drawScreenFx();

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },

    // Tårnikon til butikken; peger opad. `size` er ikonets kantlængde i pixels.
    drawTowerIcon: function (c, typeId, x, y, size, level) {
      if (!c || !(towerDef(typeId) || TOWER_COLORS[typeId])) return;
      var spr = towerSprite(typeId, level || 0, towerColor(typeId));
      var d = (size || CELL) * TS / 42;
      c.drawImage(spr.base, x - d / 2, y - d / 2, d, d);
      c.save();
      c.translate(x, y);
      c.rotate(-Math.PI / 2);
      c.drawImage(spr.turret, -d / 2, -d / 2, d, d);
      c.restore();
    },

    // Fjendeikon til bølgevisning; skaleres så alle typer fylder nogenlunde ens.
    drawEnemyIcon: function (c, typeId, x, y, size) {
      if (!c) return;
      var def = (TD.DATA && TD.DATA.enemies && TD.DATA.enemies[typeId]) ||
        { id: typeId, shape: typeId === 'megaboss' ? 'boss' : typeId, radius: 12 };
      var spr = enemySprite(def, typeId);
      var d = spr.size * ((size || 24) * 0.42 / spr.r);
      c.drawImage(spr.img, x - d / 2, y - d / 2, d, d);
    }
  };
})();
