// NEON FORSVAR – lyd: al lyd og musik laves med Web Audio-syntese (ingen lydfiler).
(function () {
  'use strict';

  var TD = window.TD = window.TD || {};

  var ctx = null;
  var failed = false;
  var nodes = null;          // master, sfxBus, musicBus, duck, sfxRev, musicRev, hum
  var noiseBuf = null;
  var shaperCurve = null;
  var voiceEnds = [];        // stoptidspunkter for kørende lydkilder (til loft over samtidige lyde)
  var lastPlayed = {};       // navn -> tidspunkt for sidste afspilning
  var volumes = { master: 0.8, sfx: 0.8, music: 0.5, muted: false };
  var volumesSet = false;
  var wantedMusic = null;
  var player = null;         // den aktive musikafspiller
  var timer = null;

  var MAX_VOICES = 90;
  var MUSIC_FADE = 1.6;
  var SILENT = 0.0001;

  // Mindste afstand (sekunder) mellem to afspilninger af samme lyd.
  var MIN_GAP = {
    kanon: 0.05, laser: 0.09, raket: 0.08, fryser: 0.1, tesla: 0.06, plasma: 0.12,
    hit: 0.05, explosion: 0.06, enemyDeath: 0.045, bossDeath: 0.5, enemyLeak: 0.18,
    bossSpawn: 1.0, waveStart: 0.3, waveEnd: 0.3, build: 0.05, upgrade: 0.08, sell: 0.08,
    win: 1.0, lose: 1.0, uiClick: 0.03, uiError: 0.12
  };
  // Lyde der springes over, når der allerede spiller rigtig mange.
  var LOW_PRIORITY = {
    kanon: 1, laser: 1, raket: 1, fryser: 1, tesla: 1, hit: 1, explosion: 1, enemyDeath: 1
  };
  var ALIAS = {
    click: 'uiClick', error: 'uiError', death: 'enemyDeath', leak: 'enemyLeak',
    bossWarning: 'bossSpawn', bossExplosion: 'bossDeath'
  };

  // ---------------------------------------------------------------- hjælpere

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function rnd(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  function mtof(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  function mkGain(value) {
    var g = ctx.createGain();
    g.gain.value = value;
    return g;
  }

  function mkFilter(type, freq, q) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q !== undefined) f.Q.value = q;
    return f;
  }

  // Stemmetælling ud fra stoptidspunkter (afhænger ikke af, at 'ended' altid bliver leveret).
  function countVoices(now) {
    var n = 0;
    for (var i = 0; i < voiceEnds.length; i++) {
      if (voiceEnds[i] > now) voiceEnds[n++] = voiceEnds[i];
    }
    voiceEnds.length = n;
    return n;
  }

  function mkOsc(type, freq, t, stop, detune) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    o.start(t);
    o.stop(stop);
    voiceEnds.push(stop);
    return o;
  }

  function mkNoise(t, stop) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.start(t, Math.random() * 1.5);
    s.stop(stop);
    voiceEnds.push(stop);
    return s;
  }

  // Hurtigt anslag, eksponentielt udklang.
  function ad(param, t, peak, attack, decay) {
    param.setValueAtTime(SILENT, t);
    param.linearRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(SILENT, t + attack + decay);
  }

  function sweep(param, t, from, to, dur) {
    param.setValueAtTime(Math.max(from, 1), t);
    param.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
  }

  function makeImpulse(seconds, decay) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function makeNoise(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function makeCurve(k) {
    var n = 1024;
    var curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = i * 2 / (n - 1) - 1;
      curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
    }
    return curve;
  }

  function mkShaper() {
    var s = ctx.createWaveShaper();
    s.curve = shaperCurve;
    return s;
  }

  // Udgang for én lydeffekt: lydstyrke, stereoplacering og evt. rumklang.
  function sfxOut(pan, vol, rev) {
    var g = mkGain(vol);
    var last = g;
    if (pan && ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      last = p;
    }
    last.connect(nodes.sfxBus);
    if (rev) {
      var send = mkGain(rev);
      last.connect(send);
      send.connect(nodes.sfxRev);
    }
    return g;
  }

  function panOf(e) {
    if (!e || typeof e.x !== 'number') return 0;
    var w = (TD.C && TD.C.FIELD_W) || 1040;
    return clamp((e.x / w - 0.5) * 1.4, -0.8, 0.8);
  }

  // ---------------------------------------------------------------- opsætning

  function applyVolumes() {
    if (!ctx) return;
    var t = ctx.currentTime;
    nodes.master.gain.setTargetAtTime(volumes.muted ? 0 : volumes.master, t, 0.03);
    nodes.sfxBus.gain.setTargetAtTime(volumes.sfx, t, 0.03);
    nodes.musicBus.gain.setTargetAtTime(volumes.music * 0.7, t, 0.03);
  }

  function buildGraph() {
    noiseBuf = makeNoise(2);
    shaperCurve = makeCurve(12);

    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    var outGain = mkGain(0.9);
    comp.connect(outGain);
    outGain.connect(ctx.destination);

    var master = mkGain(0);
    master.connect(comp);

    var sfxBus = mkGain(volumes.sfx);
    sfxBus.connect(master);

    var duck = mkGain(1);
    duck.connect(master);
    var musicBus = mkGain(volumes.music * 0.7);
    musicBus.connect(duck);

    var sfxRev = ctx.createConvolver();
    sfxRev.buffer = makeImpulse(1.3, 2.6);
    sfxRev.connect(sfxBus);

    var musicRev = ctx.createConvolver();
    musicRev.buffer = makeImpulse(2.8, 2.2);
    var musicRevOut = mkGain(0.55);
    musicRev.connect(musicRevOut);
    musicRevOut.connect(musicBus);

    // Laserens vedvarende summen: kører hele tiden, men er kun hørbar mens strålen er tændt.
    var humGain = mkGain(0);
    var humFilter = mkFilter('bandpass', 950, 1.1);
    var trem = mkGain(0.7);
    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 37;
    var lfoDepth = mkGain(0.3);
    lfo.connect(lfoDepth);
    lfoDepth.connect(trem.gain);
    lfo.start();
    var humDefs = [['sawtooth', 196, 0.5], ['sawtooth', 197.6, 0.5], ['square', 392.8, 0.22], ['sine', 98, 0.5]];
    for (var i = 0; i < humDefs.length; i++) {
      var o = ctx.createOscillator();
      o.type = humDefs[i][0];
      o.frequency.value = humDefs[i][1];
      var og = mkGain(humDefs[i][2]);
      o.connect(og);
      og.connect(humFilter);
      o.start();
    }
    humFilter.connect(trem);
    trem.connect(humGain);
    humGain.connect(sfxBus);

    nodes = {
      master: master, sfxBus: sfxBus, musicBus: musicBus, duck: duck,
      sfxRev: sfxRev, musicRev: musicRev, hum: humGain
    };
    applyVolumes();
  }

  function init() {
    if (failed) return false;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        failed = true;
        return false;
      }
      try {
        ctx = new AC();
        if (!volumesSet && TD.Save && TD.Save.data && TD.Save.data.settings) {
          copyVolumes(TD.Save.data.settings);
        }
        buildGraph();
      } catch (err) {
        console.error('Lyden kunne ikke startes:', err);
        ctx = null;
        nodes = null;
        failed = true;
        return false;
      }
      timer = window.setInterval(tick, 80);
      if (wantedMusic) startPlayer(wantedMusic);
    }
    if (ctx.state === 'suspended' && ctx.resume) {
      var p = ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
    return true;
  }

  function copyVolumes(v) {
    if (!v) return;
    if (typeof v.master === 'number') volumes.master = clamp(v.master, 0, 1);
    if (typeof v.sfx === 'number') volumes.sfx = clamp(v.sfx, 0, 1);
    if (typeof v.music === 'number') volumes.music = clamp(v.music, 0, 1);
    if (v.muted !== undefined) volumes.muted = !!v.muted;
  }

  function setVolumes(v) {
    copyVolumes(v);
    volumesSet = true;
    applyVolumes();
  }

  // Dæmp musikken kortvarigt, så vigtige lyde (fanfare, advarsel) står tydeligt.
  function duckMusic(level, hold) {
    var g = nodes.duck.gain;
    var t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(level, t, 0.05);
    g.setTargetAtTime(1, t + hold, 0.5);
  }

  // ---------------------------------------------------------------- lydeffekter

  function laserHold(t, hold) {
    var g = nodes.hum.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.18, t, 0.02);
    g.setTargetAtTime(0, t + hold, 0.07);
  }

  // Fælles brag til raketter, plasma og bosser.
  function boom(t, pan, size, vol, rev) {
    var out = sfxOut(pan, vol, rev);
    var len = 0.55 * size;

    var n = mkNoise(t, t + len + 0.3);
    var nf = mkFilter('lowpass', 4000, 0.6);
    sweep(nf.frequency, t, 5200 / size, 110, len);
    var ng = mkGain(0);
    ad(ng.gain, t, 0.9, 0.004, len + 0.15);
    n.connect(nf);
    nf.connect(ng);
    ng.connect(out);

    var sub = mkOsc('sine', 120, t, t + len + 0.3);
    sweep(sub.frequency, t, 125 / Math.sqrt(size), 28, 0.3 * size);
    var sg = mkGain(0);
    ad(sg.gain, t, 1.0, 0.004, len + 0.1);
    sub.connect(sg);
    sg.connect(out);

    var grit = mkOsc('triangle', 80, t, t + len);
    sweep(grit.frequency, t, 95 / Math.sqrt(size), 24, 0.25 * size);
    var gg = mkGain(0);
    ad(gg.gain, t, 0.5, 0.003, len * 0.7);
    var sh = mkShaper();
    grit.connect(sh);
    sh.connect(gg);
    gg.connect(out);
  }

  var SFX = {
    // Kanon: dybt, tørt smæld.
    kanon: function (t, e) {
      var out = sfxOut(panOf(e), 0.75);
      var r = rnd(0.9, 1.1);
      var o = mkOsc('sine', 190, t, t + 0.36);
      sweep(o.frequency, t, 200 * r, 42, 0.15);
      var g = mkGain(0);
      ad(g.gain, t, 1.0, 0.002, 0.27);
      o.connect(g);
      g.connect(out);

      var n = mkNoise(t, t + 0.16);
      var nf = mkFilter('lowpass', 2600, 0.8);
      sweep(nf.frequency, t, 3200, 350, 0.09);
      var ng = mkGain(0);
      ad(ng.gain, t, 0.75, 0.001, 0.1);
      n.connect(nf);
      nf.connect(ng);
      ng.connect(out);

      var c = mkOsc('square', 900, t, t + 0.08);
      sweep(c.frequency, t, 950 * r, 180, 0.035);
      var cg = mkGain(0);
      ad(cg.gain, t, 0.22, 0.001, 0.04);
      c.connect(cg);
      cg.connect(out);
    },

    // Laser: lyst "zap" når strålen tændes, derefter vedvarende summen (holdes i live af træffere).
    laser: function (t, e) {
      var out = sfxOut(panOf(e), 0.72, 0.15);
      var r = rnd(0.94, 1.06);
      var o = mkOsc('sawtooth', 2400, t, t + 0.24);
      sweep(o.frequency, t, 2600 * r, 620 * r, 0.13);
      var f = mkFilter('bandpass', 1800, 3.5);
      sweep(f.frequency, t, 3000, 900, 0.14);
      var g = mkGain(0);
      ad(g.gain, t, 0.55, 0.003, 0.17);
      o.connect(f);
      f.connect(g);
      g.connect(out);

      var s = mkOsc('sine', 3400, t, t + 0.2);
      sweep(s.frequency, t, 3600 * r, 1250 * r, 0.11);
      var sg = mkGain(0);
      ad(sg.gain, t, 0.25, 0.002, 0.12);
      s.connect(sg);
      sg.connect(out);

      laserHold(t, 0.45);
    },

    // Raket: sus ved affyring (braget kommer ved 'explosion').
    raket: function (t, e) {
      var out = sfxOut(panOf(e), 0.82, 0.1);
      var n = mkNoise(t, t + 0.6);
      var f = mkFilter('bandpass', 500, 1.4);
      sweep(f.frequency, t, 420, 3400, 0.38);
      var g = mkGain(0);
      ad(g.gain, t, 0.55, 0.04, 0.42);
      n.connect(f);
      f.connect(g);
      g.connect(out);

      var o = mkOsc('sawtooth', 120, t, t + 0.4);
      sweep(o.frequency, t, 130, 62, 0.3);
      var of = mkFilter('lowpass', 520, 1);
      var og = mkGain(0);
      ad(og.gain, t, 0.4, 0.01, 0.3);
      o.connect(of);
      of.connect(og);
      og.connect(out);
    },

    explosion: function (t, e) {
      var size = clamp(((e && e.radius) || 60) / 60, 0.7, 1.6);
      boom(t, panOf(e), size, 0.7, 0.3);
    },

    // Fryser: iskold, klirrende puls.
    fryser: function (t, e) {
      var out = sfxOut(panOf(e), 0.66, 0.55);
      var r = rnd(0.96, 1.04);
      var parts = [1760, 2637, 3520 * 1.012, 5274];
      for (var i = 0; i < parts.length; i++) {
        var o = mkOsc('sine', parts[i] * r, t, t + 0.55);
        var g = mkGain(0);
        ad(g.gain, t + i * 0.012, 0.16 / (1 + i * 0.4), 0.003, 0.4 - i * 0.05);
        o.connect(g);
        g.connect(out);
      }
      var n = mkNoise(t, t + 0.45);
      var f = mkFilter('bandpass', 6000, 7);
      sweep(f.frequency, t, 7000, 900, 0.32);
      var ng = mkGain(0);
      ad(ng.gain, t, 0.5, 0.01, 0.34);
      n.connect(f);
      f.connect(ng);
      ng.connect(out);

      var w = mkOsc('sine', 240, t, t + 0.3);
      sweep(w.frequency, t, 260, 105, 0.2);
      var wg = mkGain(0);
      ad(wg.gain, t, 0.35, 0.004, 0.22);
      w.connect(wg);
      wg.connect(out);
    },

    // Tesla: knitrende lyn.
    tesla: function (t, e) {
      var out = sfxOut(panOf(e), 0.5, 0.12);
      var steps = 18;
      var dt = 0.013;
      var end = t + steps * dt;

      var o = mkOsc('square', 800, t, end + 0.03);
      var f = mkFilter('highpass', 700, 0.7);
      var g = mkGain(0);
      var n = mkNoise(t, end + 0.03);
      var nf = mkFilter('highpass', 3200, 0.7);
      var ng = mkGain(0);
      for (var i = 0; i < steps; i++) {
        var fade = 1 - i / steps;
        var gap = Math.random() < 0.25;
        o.frequency.setValueAtTime(rnd(220, 2800), t + i * dt);
        g.gain.setValueAtTime(gap ? 0.02 : rnd(0.12, 0.32) * fade, t + i * dt);
        ng.gain.setValueAtTime(gap ? 0.03 : rnd(0.2, 0.6) * fade, t + i * dt);
      }
      g.gain.linearRampToValueAtTime(0, end + 0.02);
      ng.gain.linearRampToValueAtTime(0, end + 0.02);
      o.connect(f);
      f.connect(g);
      g.connect(out);
      n.connect(nf);
      nf.connect(ng);
      ng.connect(out);

      var b = mkOsc('sawtooth', 100, t, t + 0.2);
      var bf = mkFilter('lowpass', 700, 1);
      var bg = mkGain(0);
      ad(bg.gain, t, 0.35, 0.002, 0.15);
      b.connect(bf);
      bf.connect(bg);
      bg.connect(out);
    },

    // Plasma: kort, tung opladning efterfulgt af et stort brag.
    plasma: function (t, e) {
      var pan = panOf(e);
      var charge = 0.13;
      var out = sfxOut(pan, 0.7, 0.4);

      var c = mkOsc('sawtooth', 60, t, t + charge + 0.03);
      sweep(c.frequency, t, 55, 760, charge);
      var cf = mkFilter('lowpass', 300, 5);
      sweep(cf.frequency, t, 300, 5000, charge);
      var cg = mkGain(0);
      cg.gain.setValueAtTime(SILENT, t);
      cg.gain.exponentialRampToValueAtTime(0.5, t + charge);
      cg.gain.linearRampToValueAtTime(0, t + charge + 0.02);
      c.connect(cf);
      cf.connect(cg);
      cg.connect(out);

      var w = mkOsc('sine', 400, t, t + charge + 0.03);
      sweep(w.frequency, t, 380, 2600, charge);
      var wg = mkGain(0);
      wg.gain.setValueAtTime(SILENT, t);
      wg.gain.exponentialRampToValueAtTime(0.22, t + charge);
      wg.gain.linearRampToValueAtTime(0, t + charge + 0.02);
      w.connect(wg);
      wg.connect(out);

      var b = t + charge;
      boom(b, pan, 1.5, 0.75, 0.4);

      var s = mkOsc('sawtooth', 220, b, b + 0.55);
      sweep(s.frequency, b, 260, 38, 0.4);
      var sf = mkFilter('lowpass', 2200, 2);
      sweep(sf.frequency, b, 2600, 180, 0.45);
      var sg = mkGain(0);
      ad(sg.gain, b, 0.5, 0.003, 0.48);
      var sh = mkShaper();
      s.connect(sh);
      sh.connect(sf);
      sf.connect(sg);
      sg.connect(out);

      var z = mkOsc('sine', 3000, b, b + 0.35);
      sweep(z.frequency, b, 3400, 380, 0.26);
      var zg = mkGain(0);
      ad(zg.gain, b, 0.2, 0.002, 0.28);
      z.connect(zg);
      zg.connect(out);
    },

    // Træffer: kun kanonkugler får et lille metallisk "tik" – resten dækkes af skudlyden.
    hit: function (t, e) {
      var type = e && e.towerType;
      if (type === 'laser') {
        laserHold(t, 0.22);
        return;
      }
      if (type && type !== 'kanon') return;
      var out = sfxOut(panOf(e), 0.3);
      var n = mkNoise(t, t + 0.08);
      var f = mkFilter('bandpass', rnd(2600, 3600), 2.5);
      var g = mkGain(0);
      ad(g.gain, t, 0.5, 0.001, 0.045);
      n.connect(f);
      f.connect(g);
      g.connect(out);
      var o = mkOsc('triangle', 520, t, t + 0.09);
      sweep(o.frequency, t, rnd(480, 620), 190, 0.05);
      var og = mkGain(0);
      ad(og.gain, t, 0.35, 0.001, 0.06);
      o.connect(og);
      og.connect(out);
    },

    // Fjende ødelagt: lille digitalt "pop" – dybere jo større fjenden er.
    enemyDeath: function (t, e) {
      if (e && e.boss) {
        SFX.bossDeath(t, e);
        return;
      }
      var s = clamp(((e && e.radius) || 12) / 12, 0.6, 2);
      var out = sfxOut(panOf(e), 0.42, 0.12);
      var r = rnd(0.9, 1.12);
      var o = mkOsc('sine', 520, t, t + 0.25);
      sweep(o.frequency, t, 560 * r / s, 85, 0.12 * s);
      var g = mkGain(0);
      ad(g.gain, t, 0.6, 0.002, 0.15 * s);
      o.connect(g);
      g.connect(out);

      var n = mkNoise(t, t + 0.26 * s);
      var f = mkFilter('bandpass', 1500 * r / s, 0.9);
      var ng = mkGain(0);
      ad(ng.gain, t, 0.55, 0.002, 0.13 * s);
      n.connect(f);
      f.connect(ng);
      ng.connect(out);

      var z = mkOsc('square', 900, t, t + 0.12);
      sweep(z.frequency, t, 1300 * r / s, 320, 0.07);
      var zg = mkGain(0);
      ad(zg.gain, t, 0.12, 0.001, 0.07);
      z.connect(zg);
      zg.connect(out);
    },

    // Boss ødelagt: kæmpe brag med efterdønninger.
    bossDeath: function (t, e) {
      var pan = panOf(e);
      var mega = e && e.type === 'megaboss';
      duckMusic(0.45, mega ? 2.6 : 1.8);
      boom(t, pan, mega ? 2.6 : 2.1, 1.0, 0.6);
      var extra = mega ? 6 : 4;
      for (var i = 0; i < extra; i++) {
        boom(t + 0.14 + i * 0.17 + rnd(0, 0.05), clamp(pan + rnd(-0.5, 0.5), -1, 1), rnd(0.9, 1.5), 0.55, 0.45);
      }
      var out = sfxOut(pan, 0.5, 0.6);
      var o = mkOsc('sawtooth', 300, t, t + 1.7);
      sweep(o.frequency, t, 320, 30, 1.4);
      var f = mkFilter('lowpass', 1800, 3);
      sweep(f.frequency, t, 2400, 120, 1.4);
      var g = mkGain(0);
      ad(g.gain, t, 0.5, 0.01, 1.5);
      o.connect(f);
      f.connect(g);
      g.connect(out);
    },

    // Fjende slap igennem: kort alarm.
    enemyLeak: function (t, e) {
      var boss = e && e.boss;
      var out = sfxOut(0, boss ? 0.5 : 0.36, 0.15);
      var f = mkFilter('lowpass', 2400, 1);
      f.connect(out);
      var reps = boss ? 3 : 1;
      for (var i = 0; i < reps; i++) {
        var notes = [740, 554];
        for (var k = 0; k < 2; k++) {
          var s = t + i * 0.26 + k * 0.12;
          var o = mkOsc('square', notes[k], s, s + 0.14);
          var g = mkGain(0);
          g.gain.setValueAtTime(SILENT, s);
          g.gain.linearRampToValueAtTime(0.5, s + 0.008);
          g.gain.setValueAtTime(0.5, s + 0.09);
          g.gain.linearRampToValueAtTime(0, s + 0.12);
          o.connect(g);
          g.connect(f);
        }
      }
      var sub = mkOsc('sine', 110, t, t + 0.3);
      sweep(sub.frequency, t, 120, 60, 0.22);
      var sg = mkGain(0);
      ad(sg.gain, t, 0.5, 0.004, 0.24);
      sub.connect(sg);
      sg.connect(out);
    },

    // Boss på vej: dybt horn og sirene.
    bossSpawn: function (t) {
      duckMusic(0.5, 1.6);
      var out = sfxOut(0, 0.55, 0.5);
      var f = mkFilter('lowpass', 200, 2);
      f.frequency.setValueAtTime(180, t);
      f.frequency.linearRampToValueAtTime(1500, t + 0.9);
      f.frequency.linearRampToValueAtTime(260, t + 1.8);
      var g = mkGain(0);
      g.gain.setValueAtTime(SILENT, t);
      g.gain.linearRampToValueAtTime(0.6, t + 0.18);
      g.gain.setValueAtTime(0.6, t + 1.2);
      g.gain.linearRampToValueAtTime(0, t + 1.9);
      var freqs = [55, 55.5, 82.4, 110.3];
      for (var i = 0; i < freqs.length; i++) {
        var o = mkOsc('sawtooth', freqs[i], t, t + 1.95);
        o.connect(f);
      }
      f.connect(g);
      g.connect(out);

      for (var k = 0; k < 3; k++) {
        var s = t + 0.15 + k * 0.42;
        var b = mkOsc('square', 466, s, s + 0.34);
        b.frequency.setValueAtTime(466, s);
        b.frequency.linearRampToValueAtTime(622, s + 0.28);
        var bf = mkFilter('lowpass', 1900, 1);
        var bg = mkGain(0);
        bg.gain.setValueAtTime(SILENT, s);
        bg.gain.linearRampToValueAtTime(0.16, s + 0.03);
        bg.gain.setValueAtTime(0.16, s + 0.22);
        bg.gain.linearRampToValueAtTime(0, s + 0.32);
        b.connect(bf);
        bf.connect(bg);
        bg.connect(out);
      }
    },

    waveStart: function (t) {
      var out = sfxOut(0, 0.55, 0.4);
      var o = mkOsc('sawtooth', 220, t, t + 0.5);
      sweep(o.frequency, t, 196, 784, 0.34);
      var f = mkFilter('lowpass', 700, 4);
      sweep(f.frequency, t, 500, 3600, 0.34);
      var g = mkGain(0);
      ad(g.gain, t, 0.35, 0.06, 0.4);
      o.connect(f);
      f.connect(g);
      g.connect(out);
      chime(out, t + 0.3, 76, 0.3, 0.5);
      chime(out, t + 0.42, 83, 0.3, 0.7);
    },

    waveEnd: function (t) {
      var out = sfxOut(0, 0.55, 0.5);
      chime(out, t, 76, 0.32, 0.6);
      chime(out, t + 0.1, 80, 0.32, 0.6);
      chime(out, t + 0.2, 83, 0.32, 0.7);
      chime(out, t + 0.32, 88, 0.36, 1.1);
    },

    build: function (t, e) {
      var out = sfxOut(panOf(e), 0.5, 0.2);
      var o = mkOsc('sine', 180, t, t + 0.16);
      sweep(o.frequency, t, 210, 70, 0.08);
      var g = mkGain(0);
      ad(g.gain, t, 0.8, 0.002, 0.12);
      o.connect(g);
      g.connect(out);
      var n = mkNoise(t, t + 0.06);
      var nf = mkFilter('bandpass', 1800, 1.5);
      var ng = mkGain(0);
      ad(ng.gain, t, 0.4, 0.001, 0.04);
      n.connect(nf);
      nf.connect(ng);
      ng.connect(out);
      var u = mkOsc('triangle', 660, t + 0.05, t + 0.3);
      sweep(u.frequency, t + 0.05, 620, 1040, 0.11);
      var ug = mkGain(0);
      ad(ug.gain, t + 0.05, 0.35, 0.01, 0.2);
      u.connect(ug);
      ug.connect(out);
    },

    upgrade: function (t, e) {
      var out = sfxOut(panOf(e), 0.56, 0.45);
      var base = 72 + 2 * clamp((e && e.level) || 1, 0, 2);
      var steps = [0, 4, 7, 12];
      for (var i = 0; i < steps.length; i++) {
        chime(out, t + i * 0.06, base + steps[i], 0.3, i === 3 ? 0.9 : 0.35);
      }
      var n = mkNoise(t, t + 0.4);
      var f = mkFilter('highpass', 5000, 1);
      sweep(f.frequency, t, 3500, 9000, 0.3);
      var g = mkGain(0);
      ad(g.gain, t, 0.12, 0.08, 0.28);
      n.connect(f);
      f.connect(g);
      g.connect(out);
    },

    sell: function (t, e) {
      var out = sfxOut(panOf(e), 0.5, 0.3);
      var notes = [988, 1319];
      for (var i = 0; i < 2; i++) {
        var s = t + i * 0.075;
        var o = mkOsc('square', notes[i], s, s + 0.4);
        var f = mkFilter('lowpass', 4200, 0.7);
        var g = mkGain(0);
        ad(g.gain, s, 0.28, 0.002, i === 0 ? 0.08 : 0.3);
        o.connect(f);
        f.connect(g);
        g.connect(out);
      }
    },

    // Sejr: fanfare.
    win: function (t) {
      duckMusic(0.25, 3.2);
      var out = sfxOut(0, 0.5, 0.5);
      brass(out, t, [72], 0.11, 0.5);
      brass(out, t + 0.15, [72], 0.11, 0.5);
      brass(out, t + 0.30, [72], 0.11, 0.5);
      brass(out, t + 0.45, [60, 67, 72, 76], 0.38, 0.32);
      brass(out, t + 0.92, [56, 63, 68, 72], 0.34, 0.32);
      brass(out, t + 1.34, [58, 65, 70, 74], 0.34, 0.32);
      brass(out, t + 1.76, [48, 60, 67, 72, 76, 79], 1.3, 0.3);
      var sparkle = [84, 88, 91, 96, 91, 96, 100];
      for (var i = 0; i < sparkle.length; i++) {
        chime(out, t + 1.8 + i * 0.09, sparkle[i], 0.14, 0.7);
      }
    },

    // Nederlag: faldende, mørk frase.
    lose: function (t) {
      duckMusic(0.2, 3.0);
      var out = sfxOut(0, 0.5, 0.6);
      var chords = [[52, 59, 64, 67], [50, 57, 62, 65], [48, 55, 60, 63], [47, 54, 59, 62]];
      for (var i = 0; i < chords.length; i++) {
        var s = t + i * 0.48;
        var last = i === chords.length - 1;
        var dur = last ? 1.5 : 0.5;
        var f = mkFilter('lowpass', 1200, 1);
        f.frequency.setValueAtTime(1500 - i * 280, s);
        f.frequency.linearRampToValueAtTime(260, s + dur);
        var g = mkGain(0);
        g.gain.setValueAtTime(SILENT, s);
        g.gain.linearRampToValueAtTime(0.16, s + 0.04);
        g.gain.linearRampToValueAtTime(0, s + dur + 0.1);
        for (var k = 0; k < chords[i].length; k++) {
          var o = mkOsc('sawtooth', mtof(chords[i][k]), s, s + dur + 0.15, k % 2 ? 7 : -7);
          o.connect(f);
        }
        f.connect(g);
        g.connect(out);
      }
      var d = mkOsc('sine', 82, t, t + 3.2);
      d.frequency.setValueAtTime(82.4, t + 1.4);
      d.frequency.exponentialRampToValueAtTime(36, t + 3.1);
      var dg = mkGain(0);
      dg.gain.setValueAtTime(SILENT, t);
      dg.gain.linearRampToValueAtTime(0.5, t + 0.1);
      dg.gain.setValueAtTime(0.5, t + 1.6);
      dg.gain.linearRampToValueAtTime(0, t + 3.1);
      d.connect(dg);
      dg.connect(out);
    },

    uiClick: function (t) {
      var out = sfxOut(0, 0.3);
      var o = mkOsc('sine', 1400, t, t + 0.08);
      sweep(o.frequency, t, 1500, 900, 0.04);
      var g = mkGain(0);
      ad(g.gain, t, 0.5, 0.001, 0.05);
      o.connect(g);
      g.connect(out);
      var n = mkNoise(t, t + 0.03);
      var f = mkFilter('highpass', 4000, 0.7);
      var ng = mkGain(0);
      ad(ng.gain, t, 0.2, 0.001, 0.015);
      n.connect(f);
      f.connect(ng);
      ng.connect(out);
    },

    uiError: function (t) {
      var out = sfxOut(0, 0.34);
      var f = mkFilter('lowpass', 900, 1);
      f.connect(out);
      for (var i = 0; i < 2; i++) {
        var s = t + i * 0.12;
        var o = mkOsc('square', i ? 147 : 165, s, s + 0.11);
        var g = mkGain(0);
        g.gain.setValueAtTime(SILENT, s);
        g.gain.linearRampToValueAtTime(0.6, s + 0.006);
        g.gain.setValueAtTime(0.6, s + 0.07);
        g.gain.linearRampToValueAtTime(0, s + 0.095);
        o.connect(g);
        g.connect(f);
      }
    }
  };

  // Klokkeklang (bruges af flere effekter).
  function chime(out, t, midi, vol, decay) {
    var f = mtof(midi);
    var o = mkOsc('sine', f, t, t + decay + 0.1);
    var g = mkGain(0);
    ad(g.gain, t, vol, 0.003, decay);
    o.connect(g);
    g.connect(out);
    var h = mkOsc('triangle', f * 2.005, t, t + decay * 0.6 + 0.1);
    var hg = mkGain(0);
    ad(hg.gain, t, vol * 0.3, 0.002, decay * 0.5);
    h.connect(hg);
    hg.connect(out);
  }

  // Synth-messing til fanfaren.
  function brass(out, t, notes, dur, vol) {
    var f = mkFilter('lowpass', 800, 1.5);
    f.frequency.setValueAtTime(600, t);
    f.frequency.linearRampToValueAtTime(3200, t + Math.min(0.08, dur * 0.5));
    f.frequency.linearRampToValueAtTime(1400, t + dur);
    var g = mkGain(0);
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.setValueAtTime(vol * 0.85, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.12);
    for (var i = 0; i < notes.length; i++) {
      var a = mkOsc('sawtooth', mtof(notes[i]), t, t + dur + 0.15, -6);
      var b = mkOsc('sawtooth', mtof(notes[i]), t, t + dur + 0.15, 6);
      a.connect(f);
      b.connect(f);
    }
    f.connect(g);
    g.connect(out);
  }

  function play(name, e) {
    if (!ctx || !nodes) return;
    if (ctx.state !== 'running') {
      // En suspenderet AudioContext ville hobe lydene op og spille dem alle på én gang.
      if (ctx.state === 'suspended' && ctx.resume) {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
      return;
    }
    if (name === 'shoot') name = (e && e.towerType) || 'kanon';
    name = ALIAS[name] || name;
    var fn = SFX[name];
    if (!fn) return;
    var now = ctx.currentTime;
    var gap = MIN_GAP[name] || 0.03;
    if (lastPlayed[name] !== undefined && now - lastPlayed[name] < gap) {
      // Laserens summen skal stadig holdes i live, selv om tikket springes over.
      if (name === 'hit' && e && e.towerType === 'laser') laserHold(now, 0.22);
      return;
    }
    if (LOW_PRIORITY[name] && countVoices(now) > MAX_VOICES) return;
    if (name === 'hit' && e && e.towerType && e.towerType !== 'kanon') {
      // Ingen egen lyd og derfor heller ingen spærretid for kanonens træffere.
      fn(now, e);
      return;
    }
    lastPlayed[name] = now;
    try {
      fn(now + 0.005, e || {});
    } catch (err) {
      console.error('Fejl i lyden "' + name + '":', err);
    }
  }

  // ---------------------------------------------------------------- musik

  // Musikinstrumenter. p = afspiller (p.out = tør udgang, p.send = ekko/rumklang).

  function pad(p, t, notes, dur, vol, bright) {
    var f = mkFilter('lowpass', bright, 0.7);
    f.frequency.setValueAtTime(bright * 0.6, t);
    f.frequency.linearRampToValueAtTime(bright * 1.4, t + dur * 0.5);
    f.frequency.linearRampToValueAtTime(bright * 0.7, t + dur + 0.8);
    var attack = Math.min(0.9, dur * 0.3);
    var g = mkGain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.setValueAtTime(vol, t + dur - 0.1);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.9);
    for (var i = 0; i < notes.length; i++) {
      var fr = mtof(notes[i]);
      mkOsc('sawtooth', fr, t, t + dur + 1, -7).connect(f);
      mkOsc('sawtooth', fr, t, t + dur + 1, 7).connect(f);
    }
    f.connect(g);
    g.connect(p.out);
    g.connect(p.send);
  }

  function bass(p, t, midi, dur, vol, bright) {
    var fr = mtof(midi);
    var f = mkFilter('lowpass', bright, 4);
    sweep(f.frequency, t, bright, 130, dur);
    var g = mkGain(0);
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.setValueAtTime(vol, t + dur * 0.65);
    g.gain.linearRampToValueAtTime(0, t + dur);
    mkOsc('sawtooth', fr, t, t + dur + 0.02).connect(f);
    var s = mkOsc('sine', fr, t, t + dur + 0.02);
    var sg = mkGain(0.9);
    s.connect(sg);
    sg.connect(g);
    f.connect(g);
    g.connect(p.out);
  }

  function subBass(p, t, midi, dur, vol) {
    var o = mkOsc('sine', mtof(midi), t, t + dur + 0.6);
    var g = mkGain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.5);
    g.gain.setValueAtTime(vol, t + dur - 0.2);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.5);
    o.connect(g);
    g.connect(p.out);
  }

  function pluck(p, t, midi, dur, vol) {
    var fr = mtof(midi);
    var f = mkFilter('lowpass', 3000, 1.5);
    sweep(f.frequency, t, 3400, 600, dur * 0.8);
    var g = mkGain(0);
    ad(g.gain, t, vol, 0.004, dur);
    mkOsc('triangle', fr, t, t + dur + 0.05).connect(f);
    var s = mkOsc('square', fr, t, t + dur + 0.05, 6);
    var sg = mkGain(0.25);
    s.connect(sg);
    sg.connect(f);
    f.connect(g);
    g.connect(p.out);
    g.connect(p.send);
  }

  function bell(p, t, midi, vol) {
    var fr = mtof(midi);
    var g = mkGain(0);
    ad(g.gain, t, vol, 0.003, 1.6);
    mkOsc('sine', fr, t, t + 1.7).connect(g);
    var h = mkOsc('sine', fr * 2.76, t, t + 0.6);
    var hg = mkGain(0);
    ad(hg.gain, t, 0.22, 0.002, 0.45);
    h.connect(hg);
    hg.connect(g);
    var dry = mkGain(0.4);
    g.connect(dry);
    dry.connect(p.out);
    g.connect(p.send);
  }

  function lead(p, t, midi, dur, vol) {
    var fr = mtof(midi);
    var f = mkFilter('lowpass', 2300, 1);
    var g = mkGain(0);
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.setValueAtTime(vol * 0.8, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.14);
    var stop = t + dur + 0.2;
    var a = mkOsc('triangle', fr, t, stop);
    var b = mkOsc('sawtooth', fr, t, stop, 8);
    var bg = mkGain(0.3);
    var lfo = mkOsc('sine', 5.5, t, stop);
    var depth = mkGain(0);
    depth.gain.setValueAtTime(0, t + Math.min(0.15, dur * 0.4));
    depth.gain.linearRampToValueAtTime(fr * 0.006, t + dur);
    lfo.connect(depth);
    depth.connect(a.frequency);
    depth.connect(b.frequency);
    a.connect(f);
    b.connect(bg);
    bg.connect(f);
    f.connect(g);
    g.connect(p.out);
    g.connect(p.send);
  }

  function kick(p, t, vol) {
    var o = mkOsc('sine', 130, t, t + 0.3);
    sweep(o.frequency, t, 135, 42, 0.11);
    var g = mkGain(0);
    ad(g.gain, t, vol, 0.003, 0.24);
    o.connect(g);
    g.connect(p.out);
  }

  function snare(p, t, vol) {
    var n = mkNoise(t, t + 0.2);
    var f = mkFilter('bandpass', 1900, 0.8);
    var g = mkGain(0);
    ad(g.gain, t, vol, 0.002, 0.14);
    n.connect(f);
    f.connect(g);
    g.connect(p.out);
    g.connect(p.send);
    var o = mkOsc('triangle', 190, t, t + 0.12);
    sweep(o.frequency, t, 200, 140, 0.08);
    var og = mkGain(0);
    ad(og.gain, t, vol * 0.6, 0.002, 0.08);
    o.connect(og);
    og.connect(p.out);
  }

  function hat(p, t, vol) {
    var n = mkNoise(t, t + 0.07);
    var f = mkFilter('highpass', 8000, 0.7);
    var g = mkGain(0);
    ad(g.gain, t, vol, 0.001, 0.04);
    n.connect(f);
    f.connect(g);
    g.connect(p.out);
  }

  function riser(p, t, dur, vol) {
    var n = mkNoise(t, t + dur + 0.1);
    var f = mkFilter('bandpass', 300, 1.2);
    sweep(f.frequency, t, 300, 5000, dur);
    var g = mkGain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.06);
    n.connect(f);
    f.connect(g);
    g.connect(p.out);
    g.connect(p.send);
  }

  // Melodier: bar -> [[trin, tone, længde i trin], ...]
  var BATTLE_LEAD = [
    [[0, 74, 6], [8, 77, 4], [12, 76, 4]],
    [[0, 72, 8], [10, 69, 6]],
    [[0, 74, 6], [8, 77, 4], [12, 79, 4]],
    [[0, 77, 10], [12, 74, 4]],
    [[0, 72, 6], [8, 76, 4], [12, 77, 4]],
    [[0, 79, 8], [10, 76, 6]],
    [[0, 76, 6], [8, 74, 4], [12, 72, 4]],
    [[0, 74, 12]]
  ];
  var BOSS_LEAD = [
    [[0, 76, 4], [4, 79, 4], [8, 78, 4], [12, 76, 4]],
    [[0, 71, 12]],
    [[0, 76, 4], [4, 79, 4], [8, 84, 8]],
    [[0, 81, 6], [8, 78, 8]],
    [[0, 76, 4], [4, 79, 4], [8, 78, 4], [12, 76, 4]],
    [[0, 83, 12]],
    [[0, 84, 6], [8, 81, 4], [12, 77, 4]],
    [[0, 78, 8], [8, 74, 8]]
  ];
  var BATTLE_BASS = [0, null, null, 0, null, null, 12, null, 0, null, 0, null, null, 12, null, 7];
  var BATTLE_ARP = [0, 1, 2, 3, 2, 1, 3, 2];
  var BOSS_ARP = [0, 1, 2, 1, 0, 2, 1, 2, 0, 1, 2, 1, 2, 1, 0, 2];
  var MENU_ARP = { 0: 0, 3: 1, 6: 2, 8: 3, 11: 2, 14: 1 };
  var MENU_SPARKLE = [81, 84, 86, 88, 91, 93];

  function playLead(p, melody, bar, s, t, sd, vol) {
    var notes = melody[bar];
    for (var i = 0; i < notes.length; i++) {
      if (notes[i][0] === s) lead(p, t, notes[i][1], notes[i][2] * sd * 0.92, vol);
    }
  }

  // Hvert nummer: 8 takter à 16 trin, der gentages uden ophold. `loop` tæller gennemspilninger
  // og bruges til at variere arrangementet, så musikken ikke bliver ensformig.
  var TRACKS = {
    // Rolig, svævende ambient til menu og galaksekort.
    menu: {
      bpm: 72,
      chords: [
        { b: 33, n: [57, 60, 64, 71] }, { b: 33, n: [57, 60, 64, 71] },
        { b: 29, n: [53, 57, 60, 64] }, { b: 29, n: [53, 57, 60, 64] },
        { b: 36, n: [52, 55, 59, 62] }, { b: 36, n: [52, 55, 59, 62] },
        { b: 31, n: [55, 57, 59, 62] }, { b: 31, n: [55, 57, 59, 62] }
      ],
      step: function (p, c, bar, s, t, sd, loop) {
        if (s === 0 && bar % 2 === 0) {
          pad(p, t, c.n, sd * 32, 0.034, 950);
          subBass(p, t, c.b + 12, sd * 32, 0.2);
        }
        var idx = MENU_ARP[s];
        if (idx !== undefined) {
          var up = (bar % 2 === 1 && s >= 8) || (loop % 2 === 1 && s === 6);
          pluck(p, t, c.n[idx] + (up ? 24 : 12), 0.9, 0.085);
        }
        if (s % 4 === 2 && Math.random() < 0.16) {
          bell(p, t, MENU_SPARKLE[Math.floor(Math.random() * MENU_SPARKLE.length)], 0.05);
        }
      }
    },

    // Fremdrift uden stress: blød synthwave til almindelige bølger.
    battle: {
      bpm: 108,
      chords: [
        { b: 38, n: [53, 57, 60, 64] }, { b: 38, n: [53, 57, 60, 64] },
        { b: 34, n: [53, 57, 58, 62] }, { b: 34, n: [53, 57, 58, 62] },
        { b: 41, n: [53, 57, 60, 67] }, { b: 41, n: [53, 57, 60, 67] },
        { b: 36, n: [52, 55, 60, 62] }, { b: 36, n: [52, 55, 60, 62] }
      ],
      step: function (p, c, bar, s, t, sd, loop) {
        var part = loop % 4;
        var breakdown = part === 2 && bar < 4;
        var intro = loop === 0 && bar < 2;

        if (s === 0 && bar % 2 === 0) pad(p, t, c.n, sd * 32, 0.026, 1100);

        var off = BATTLE_BASS[s];
        if (off !== null) bass(p, t, c.b + off, sd * 1.7, 0.2, breakdown ? 500 : 900);

        if (!intro && !breakdown) {
          if (s === 0 || s === 8 || (s === 11 && bar % 2 === 1)) kick(p, t, 0.42);
          if (s === 4 || s === 12) snare(p, t, 0.11);
        }
        if (!intro && s % 2 === 0) hat(p, t, s % 4 === 2 ? 0.05 : 0.025);

        if (s % 2 === 0) {
          var k = BATTLE_ARP[(s / 2) % 8];
          var oct = (part === 2 || (part === 1 && s >= 8)) ? 24 : 12;
          pluck(p, t, c.n[k] + oct, sd * 2.4, 0.06);
        }

        if (part === 1 || part === 3) playLead(p, BATTLE_LEAD, bar, s, t, sd, 0.075);
        if (bar === 7 && s === 8 && (part === 1 || part === 2)) riser(p, t, sd * 8, 0.05);
      }
    },

    // Mørkere og hurtigere til bosser.
    boss: {
      bpm: 132,
      chords: [
        { b: 40, n: [52, 55, 59, 62] }, { b: 40, n: [52, 55, 59, 62] },
        { b: 36, n: [52, 55, 60, 64] }, { b: 38, n: [50, 54, 57, 62] },
        { b: 40, n: [52, 55, 59, 64] }, { b: 40, n: [52, 55, 59, 64] },
        { b: 41, n: [53, 57, 60, 64] }, { b: 38, n: [50, 54, 57, 60] }
      ],
      step: function (p, c, bar, s, t, sd, loop) {
        var intro = loop === 0 && bar < 2;

        if (s === 0) pad(p, t, c.n, sd * 16, 0.024, 1300);

        if (s % 2 === 0) bass(p, t, c.b + (s % 8 === 6 ? 12 : 0), sd * 1.6, 0.2, 1300);
        else if (s === 15) bass(p, t, c.b + 7, sd * 0.9, 0.16, 1300);

        if (!intro) {
          if (s % 4 === 0) kick(p, t, 0.46);
          if (s === 4 || s === 12) snare(p, t, 0.14);
          if (bar === 7 && s === 14) snare(p, t, 0.1);
        }
        hat(p, t, s % 4 === 2 ? 0.055 : 0.02);

        var k = BOSS_ARP[s];
        pluck(p, t, c.n[k] + (s % 8 >= 4 ? 24 : 12), sd * 1.6, 0.04);

        if (loop % 2 === 1) playLead(p, BOSS_LEAD, bar, s, t, sd, 0.07);
        if (bar === 7 && s === 0) riser(p, t, sd * 16, 0.06);
      }
    }
  };

  function startPlayer(name) {
    var def = TRACKS[name];
    if (!def || !ctx) return;
    var t = ctx.currentTime;
    var sd = 60 / def.bpm / 4;

    var out = mkGain(0);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(1, t + MUSIC_FADE);
    out.connect(nodes.musicBus);

    // Ekko i takt med nummeret (punkteret ottendedel) plus fælles rumklang.
    var send = mkGain(0);
    send.gain.setValueAtTime(0, t);
    send.gain.linearRampToValueAtTime(1, t + MUSIC_FADE);
    var delay = ctx.createDelay(1.5);
    delay.delayTime.value = sd * 3;
    var fb = mkGain(0.34);
    var damp = mkFilter('lowpass', 2600, 0.7);
    var wet = mkGain(0.4);
    var revSend = mkGain(0.6);
    send.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wet);
    wet.connect(nodes.musicBus);
    send.connect(revSend);
    revSend.connect(nodes.musicRev);

    player = {
      name: name, def: def, sd: sd, out: out, send: send,
      nodes: [out, send, fb, wet, revSend],
      nextTime: t + 0.12, step: 0, bar: 0, loop: 0
    };
  }

  function stopPlayer() {
    if (!player) return;
    var old = player;
    player = null;
    var t = ctx.currentTime;
    var params = [old.out.gain, old.send.gain];
    for (var i = 0; i < params.length; i++) {
      params[i].cancelScheduledValues(t);
      params[i].setValueAtTime(params[i].value, t);
      params[i].linearRampToValueAtTime(0, t + MUSIC_FADE);
    }
    window.setTimeout(function () {
      for (var k = 0; k < old.nodes.length; k++) {
        try {
          old.nodes[k].disconnect();
        } catch (err) {
          // Allerede frakoblet.
        }
      }
    }, (MUSIC_FADE + 3.5) * 1000);
  }

  function setMusic(name) {
    if (name !== null && !TRACKS[name]) name = null;
    if (name === wantedMusic) return;
    wantedMusic = name;
    if (!ctx || !nodes) return;
    stopPlayer();
    if (name) startPlayer(name);
  }

  // Planlægger musikken et lille stykke frem i tiden, så den spiller jævnt uanset billedhastighed.
  function tick() {
    if (!ctx || !player || ctx.state !== 'running') return;
    var p = player;
    var now = ctx.currentTime;
    // Skjulte faner får sjældnere timer-kald – planlæg længere frem dér.
    var ahead = (typeof document !== 'undefined' && document.hidden) ? 1.6 : 0.3;
    if (voiceEnds.length > 400) countVoices(now);
    if (p.nextTime < now) p.nextTime = now + 0.05;
    while (p.nextTime < now + ahead) {
      try {
        p.def.step(p, p.def.chords[p.bar], p.bar, p.step, p.nextTime, p.sd, p.loop);
      } catch (err) {
        console.error('Fejl i musikken:', err);
      }
      p.nextTime += p.sd;
      p.step++;
      if (p.step >= 16) {
        p.step = 0;
        p.bar++;
        if (p.bar >= p.def.chords.length) {
          p.bar = 0;
          p.loop++;
        }
      }
    }
  }

  // ---------------------------------------------------------------- hændelser

  function listen(name) {
    TD.events.on(name, function (e) {
      play(name, e);
    });
  }

  if (TD.events) {
    var names = ['shoot', 'hit', 'explosion', 'enemyDeath', 'enemyLeak', 'bossSpawn', 'waveStart',
      'waveEnd', 'build', 'upgrade', 'sell', 'win', 'lose', 'uiClick', 'uiError'];
    for (var i = 0; i < names.length; i++) listen(names[i]);
  }

  TD.Audio = {
    init: init,
    setMusic: setMusic,
    setVolumes: setVolumes,
    play: play
  };
})();
