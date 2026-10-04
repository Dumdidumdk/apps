// NEON FORSVAR – spilmotor (TD.Game): ren spillogik uden tegning, lyd eller DOM.
// Alt, der skal ses eller høres, meldes via TD.events.
(function () {
  'use strict';

  var TD = window.TD = window.TD || {};

  // Justerbare regler, som byggeplanen ikke lægger helt fast.
  var SHIELD_REGEN_DELAY = 3;      // sekunder uden skade, før skjoldet lader op
  var SHIELD_REGEN_RATE = 0.35;    // andel af fuldt skjold pr. sekund
  var SCALE_SHIELD_WITH_HP = true; // skjold følger banens/bølgens hp-skalering
  var SCALE_HEAL_WITH_HP = true;   // healerens perSecond følger samme skalering
  var MIN_SLOW_FACTOR = 0.1;       // en fjende kan aldrig stå helt stille
  var TURN_SPEED = 14;             // radianer pr. sekund
  var SPLASH_EDGE = 0.5;           // andel af raketskaden yderst i eksplosionen
  var ROCKET_RETARGET = 220;       // raket finder nyt mål inden for denne afstand
  var PROJECTILE_MAX_LIFE = 8;
  var MAX_HITS_PER_SHOT = 8;       // loft over 'hit'-hændelser fra ét skud
  var LASER_BEAM_LIFE = 0.1;
  var LASER_HIT_INTERVAL = 0.12;
  var BEAM_LIFE = { tesla: 0.18, rail: 0.3, frost: 0.45 };

  function num(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  function emit(name, payload) {
    if (TD.events) TD.events.emit(name, payload);
  }

  function angleDiff(a, b) {
    var d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Afstand i anden fra punkt (px, py) til linjestykket (ax, ay)-(bx, by).
  function segDistSq(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var lenSq = dx * dx + dy * dy;
    var t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var qx = ax + dx * t - px, qy = ay + dy * t - py;
    return qx * qx + qy * qy;
  }

  function Game(levelDef) {
    var C = TD.C;
    var level = levelDef || {};
    var i;

    this.level = level;
    this.money = num(level.startMoney, 300);
    this.lives = Math.max(1, num(level.lives, 20));
    this.maxLives = this.lives;
    this.waves = Array.isArray(level.waves) ? level.waves : [];
    this.waveIndex = 0;
    this.waveCount = this.waves.length;
    this.state = 'build';
    this.time = 0;
    this.kills = 0;

    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.beams = [];
    this.toSpawn = 0; // fjender i den igangværende bølge, der endnu ikke er sendt ud

    this._nextId = 1;
    this._queue = [];
    this._queuePos = 0;
    this._waveTime = 0;

    // Rute i pixels med løbende længde pr. waypoint.
    var path = Array.isArray(level.path) ? level.path : [];
    this.pathPoints = [];
    for (i = 0; i < path.length; i++) {
      this.pathPoints.push(TD.cellCenter(path[i][0], path[i][1]));
    }
    this._cum = [0];
    this._segAngle = [];
    for (i = 1; i < this.pathPoints.length; i++) {
      var a = this.pathPoints[i - 1], b = this.pathPoints[i];
      var dx = b.x - a.x, dy = b.y - a.y;
      this._cum.push(this._cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
      this._segAngle.push(Math.atan2(dy, dx));
    }
    this.pathLength = this._cum[this._cum.length - 1];

    // Celler, som ruten dækker (kun dem inden for gitteret).
    this._pathCells = new Array(C.COLS * C.ROWS);
    this._towerGrid = new Array(C.COLS * C.ROWS);
    for (i = 0; i < this._pathCells.length; i++) {
      this._pathCells[i] = false;
      this._towerGrid[i] = null;
    }
    for (i = 0; i < path.length; i++) {
      var x0 = Math.round(path[i][0]), y0 = Math.round(path[i][1]);
      var x1 = x0, y1 = y0;
      if (i + 1 < path.length) {
        x1 = Math.round(path[i + 1][0]);
        y1 = Math.round(path[i + 1][1]);
      }
      var steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (var s = 0; s <= steps; s++) {
        var t = steps > 0 ? s / steps : 0;
        var cx = Math.round(x0 + (x1 - x0) * t);
        var cy = Math.round(y0 + (y1 - y0) * t);
        if (cx >= 0 && cy >= 0 && cx < C.COLS && cy < C.ROWS) {
          this._pathCells[cy * C.COLS + cx] = true;
        }
      }
    }
  }

  var P = Game.prototype;

  // ---------------------------------------------------------------- gitter

  P._inGrid = function (cx, cy) {
    return cx === Math.floor(cx) && cy === Math.floor(cy) &&
      cx >= 0 && cy >= 0 && cx < TD.C.COLS && cy < TD.C.ROWS;
  };

  P.isPathCell = function (cx, cy) {
    if (!this._inGrid(cx, cy)) return false;
    return this._pathCells[cy * TD.C.COLS + cx];
  };

  P.towerAt = function (cx, cy) {
    if (!this._inGrid(cx, cy)) return null;
    return this._towerGrid[cy * TD.C.COLS + cx] || null;
  };

  P.canBuild = function (cx, cy) {
    return this._inGrid(cx, cy) && !this.isPathCell(cx, cy) && !this.towerAt(cx, cy);
  };

  // ------------------------------------------------- køb, opgrader og sælg

  P._playing = function () {
    return this.state === 'build' || this.state === 'wave';
  };

  P.build = function (typeId, cx, cy) {
    if (!this._playing() || !this.canBuild(cx, cy)) return null;
    var def = TD.DATA && TD.DATA.towers ? TD.DATA.towers[typeId] : null;
    if (!def || !def.levels || !def.levels.length) return null;
    var cost = num(def.cost, num(def.levels[0].cost, 0));
    if (this.money < cost) return null;

    var pos = TD.cellCenter(cx, cy);
    var tower = {
      id: this._nextId++,
      type: typeId,
      def: def,
      level: 0,
      stats: def.levels[0],
      cx: cx,
      cy: cy,
      x: pos.x,
      y: pos.y,
      angle: -Math.PI / 2,
      cooldown: 0,
      target: null,
      sinceShot: 99,
      spent: cost,
      kills: 0,
      beam: null,     // laserens aktive stråle
      hitTimer: 0
    };
    this.money -= cost;
    this.towers.push(tower);
    this._towerGrid[cy * TD.C.COLS + cx] = tower;
    emit('build', { towerType: typeId, x: pos.x, y: pos.y });
    return tower;
  };

  P.upgradeCost = function (tower) {
    if (!tower || !tower.def || !tower.def.levels) return null;
    var next = tower.def.levels[tower.level + 1];
    if (!next) return null;
    return num(next.cost, 0);
  };

  P.upgrade = function (tower) {
    if (!this._playing() || this.towers.indexOf(tower) < 0) return false;
    var cost = this.upgradeCost(tower);
    if (cost === null || this.money < cost) return false;
    this.money -= cost;
    tower.level += 1;
    tower.stats = tower.def.levels[tower.level];
    tower.spent += cost;
    emit('upgrade', { towerType: tower.type, x: tower.x, y: tower.y, level: tower.level });
    return true;
  };

  P.sellValue = function (tower) {
    if (!tower) return 0;
    return Math.round(num(tower.spent, 0) * num(TD.C.SELL_RATE, 0.7));
  };

  P.sell = function (tower) {
    if (!this._playing()) return false;
    var i = this.towers.indexOf(tower);
    if (i < 0) return false;
    var value = this.sellValue(tower);
    this.towers.splice(i, 1);
    this._towerGrid[tower.cy * TD.C.COLS + tower.cx] = null;
    if (tower.beam) {
      tower.beam.life = 0;
      tower.beam = null;
    }
    tower.target = null;
    this.money += value;
    emit('sell', { towerType: tower.type, x: tower.x, y: tower.y, value: value });
    return true;
  };

  // ---------------------------------------------------------------- bølger

  P.wavePreview = function (index) {
    var wave = this.waves[index];
    var out = [];
    if (!wave || !Array.isArray(wave.groups)) return out;
    var byType = {};
    for (var i = 0; i < wave.groups.length; i++) {
      var g = wave.groups[i];
      var count = Math.max(0, Math.floor(num(g.count, 0)));
      if (!g.type || count <= 0) continue;
      if (!byType[g.type]) {
        byType[g.type] = { type: g.type, count: 0 };
        out.push(byType[g.type]);
      }
      byType[g.type].count += count;
    }
    return out;
  };

  P.startNextWave = function () {
    if (this.state !== 'build' || this.waveIndex >= this.waveCount) return false;
    var wave = this.waves[this.waveIndex] || {};
    var groups = Array.isArray(wave.groups) ? wave.groups : [];
    var queue = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!TD.DATA || !TD.DATA.enemies || !TD.DATA.enemies[g.type]) {
        console.warn('Ukendt fjendetype i bølge ' + (this.waveIndex + 1) + ': ' + g.type);
        continue;
      }
      var count = Math.max(0, Math.floor(num(g.count, 0)));
      var interval = Math.max(0, num(g.interval, 0.5));
      var delay = Math.max(0, num(g.delay, 0));
      for (var k = 0; k < count; k++) {
        queue.push({ t: delay + k * interval, type: g.type, seq: queue.length });
      }
    }
    this._addSurprise(queue);
    queue.sort(function (a, b) { return (a.t - b.t) || (a.seq - b.seq); });

    this._queue = queue;
    this._queuePos = 0;
    this._waveTime = 0;
    this.toSpawn = queue.length;
    this.state = 'wave';
    emit('waveStart', { index: this.waveIndex, count: this.waveCount, enemies: queue.length });
    return true;
  };

  // Blander en gang imellem en overraskelsesboss ind i bølgen (se TD.DATA.surprise).
  // Bossen kommer et sted midt i bølgen, så den ikke bare fører an.
  P._addSurprise = function (queue) {
    var S = TD.DATA && TD.DATA.surprise;
    var rand = this.random || Math.random;
    var levelNo = num(this.level.id, 1);
    if (!S || !queue.length || this.surprises === false) return;
    if (levelNo < S.fromLevel || this.waveIndex + 1 < S.fromWave || this.waveIndex >= this.waveCount - 1) return;
    for (var i = 0; i < queue.length; i++) {
      if (TD.DATA.enemies[queue[i].type].boss) return;
    }
    if (rand() >= S.chance) return;
    var pool = [];
    for (i = 0; i < S.types.length; i++) {
      if (levelNo >= S.types[i][1] && TD.DATA.enemies[S.types[i][0]]) pool.push(S.types[i][0]);
    }
    if (!pool.length) return;
    var last = 0;
    for (i = 0; i < queue.length; i++) last = Math.max(last, queue[i].t);
    queue.push({
      t: last * (0.3 + rand() * 0.4),
      type: pool[Math.floor(rand() * pool.length)],
      seq: queue.length,
      surprise: true
    });
  };

  P._spawn = function (type, headStart, surprise) {
    var def = TD.DATA.enemies[type];
    var level = this.level;
    var hpMult = num(level.hpScale, 1) * (1 + num(level.waveGrowth, 0) * this.waveIndex);
    var hp = Math.max(1, num(def.hp, 1) * hpMult);
    var shield = Math.max(0, num(def.shield, 0)) * (SCALE_SHIELD_WITH_HP ? hpMult : 1);
    var heal = null;
    if (def.heal && num(def.heal.perSecond, 0) > 0 && num(def.heal.radius, 0) > 0) {
      heal = {
        radius: def.heal.radius,
        perSecond: def.heal.perSecond * (SCALE_HEAL_WITH_HP ? hpMult : 1)
      };
    }
    var enemy = {
      id: this._nextId++,
      type: type,
      def: def,
      x: 0,
      y: 0,
      angle: 0,
      hp: hp,
      maxHp: hp,
      shield: shield,
      maxShield: shield,
      slowFactor: 1,
      slowTime: 0,
      dist: 0,
      radius: num(def.radius, 12),
      alive: true,
      hitFlash: 99,
      // Forudberegnede værdier
      speed: Math.max(1, num(def.speed, 50) * num(level.speedScale, 1)),
      reward: Math.round(num(def.reward, 0) * num(level.rewardScale, 1)),
      armor: Math.min(0.95, Math.max(0, num(def.armor, 0))),
      slowResist: Math.min(1, Math.max(0, num(def.slowResist, 0))),
      livesCost: Math.max(0, num(def.livesCost, 1)),
      boss: !!def.boss,
      heal: heal,
      sinceDamage: 99,
      healing: 0,
      seg: 0
    };
    enemy.dist = Math.max(0, headStart * enemy.speed);
    this._place(enemy);
    this.enemies.push(enemy);
    if (enemy.boss) emit('bossSpawn', { type: type, name: def.name, surprise: !!surprise });
    return enemy;
  };

  // Sætter x, y og angle ud fra enemy.dist.
  P._place = function (enemy) {
    var pts = this.pathPoints, cum = this._cum;
    if (pts.length === 0) return;
    if (pts.length === 1) {
      enemy.x = pts[0].x;
      enemy.y = pts[0].y;
      return;
    }
    var last = pts.length - 2;
    var seg = enemy.seg;
    while (seg < last && enemy.dist > cum[seg + 1]) seg++;
    enemy.seg = seg;
    var a = pts[seg], b = pts[seg + 1];
    var len = cum[seg + 1] - cum[seg];
    var t = len > 0 ? (enemy.dist - cum[seg]) / len : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    enemy.x = a.x + (b.x - a.x) * t;
    enemy.y = a.y + (b.y - a.y) * t;
    enemy.angle = this._segAngle[seg];
  };

  // ------------------------------------------------------- skade og effekter

  // Giver skade til en fjende. Returnerer true, hvis fjenden døde.
  P._damage = function (enemy, amount, damageType, tower) {
    if (!enemy.alive || !(amount > 0)) return false;
    if (damageType === 'kinetic') amount *= (1 - enemy.armor);
    enemy.hitFlash = 0;
    enemy.sinceDamage = 0;

    if (enemy.shield > 0) {
      var mult = damageType === 'energy' ? 2 : 1;
      var onShield = amount * mult;
      if (onShield <= enemy.shield) {
        enemy.shield -= onShield;
        return false;
      }
      amount = (onShield - enemy.shield) / mult;
      enemy.shield = 0;
    }

    enemy.hp -= amount;
    if (enemy.hp > 0) return false;

    enemy.hp = 0;
    enemy.alive = false;
    this.kills += 1;
    this.money += enemy.reward;
    if (tower) tower.kills += 1;
    emit('enemyDeath', {
      type: enemy.type,
      shape: enemy.def.shape,
      x: enemy.x,
      y: enemy.y,
      radius: enemy.radius,
      color: enemy.def.color,
      boss: enemy.boss,
      reward: enemy.reward
    });
    return true;
  };

  P._applySlow = function (enemy, slow, duration) {
    if (!enemy.alive || !(slow > 0) || !(duration > 0)) return;
    var factor = 1 - slow * (1 - enemy.slowResist);
    if (factor >= 1) return;
    if (factor < MIN_SLOW_FACTOR) factor = MIN_SLOW_FACTOR;
    // Den stærkeste gælder; en lige så stærk forlænger blot varigheden.
    if (factor < enemy.slowFactor - 1e-6) {
      enemy.slowFactor = factor;
      enemy.slowTime = duration;
    } else if (factor <= enemy.slowFactor + 1e-6) {
      enemy.slowTime = Math.max(enemy.slowTime, duration);
    }
  };

  // --------------------------------------------------------------- opdatering

  P.update = function (dt) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    this.time += dt;

    this._updateBeams(dt);
    if (this.state === 'won' || this.state === 'lost') {
      this._updateTowerTimers(dt);
      return;
    }

    if (this.state === 'wave') this._updateSpawns(dt);
    this._updateEnemies(dt);
    if (this.state === 'lost') {
      this._sweep();
      return;
    }
    this._updateHealers(dt);
    this._updateTowers(dt);
    this._updateProjectiles(dt);
    this._sweep();

    if (this.state === 'wave' && this._queuePos >= this._queue.length && this.enemies.length === 0) {
      this._endWave();
    }
  };

  P._updateBeams = function (dt) {
    var beams = this.beams, n = 0;
    for (var i = 0; i < beams.length; i++) {
      var b = beams[i];
      b.life -= dt;
      if (b.life > 0) beams[n++] = b;
    }
    beams.length = n;
  };

  P._updateTowerTimers = function (dt) {
    for (var i = 0; i < this.towers.length; i++) {
      var tower = this.towers[i];
      tower.sinceShot += dt;
      tower.target = null;
    }
  };

  P._updateSpawns = function (dt) {
    this._waveTime += dt;
    var queue = this._queue;
    while (this._queuePos < queue.length && queue[this._queuePos].t <= this._waveTime) {
      var item = queue[this._queuePos++];
      this._spawn(item.type, this._waveTime - item.t, item.surprise);
    }
    this.toSpawn = queue.length - this._queuePos;
  };

  P._updateEnemies = function (dt) {
    var enemies = this.enemies;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!e.alive) continue;

      e.hitFlash += dt;
      e.sinceDamage += dt;

      if (e.slowTime > 0) {
        e.slowTime -= dt;
        if (e.slowTime <= 0) {
          e.slowTime = 0;
          e.slowFactor = 1;
        }
      }

      if (e.maxShield > 0 && e.shield < e.maxShield && e.sinceDamage >= SHIELD_REGEN_DELAY) {
        e.shield = Math.min(e.maxShield, e.shield + e.maxShield * SHIELD_REGEN_RATE * dt);
      }

      e.dist += e.speed * e.slowFactor * dt;
      if (e.dist >= this.pathLength) {
        e.dist = this.pathLength;
        this._place(e);
        e.alive = false;
        this.lives -= e.livesCost;
        emit('enemyLeak', { type: e.type, boss: e.boss, livesCost: e.livesCost });
        if (this.lives <= 0) {
          this.lives = 0;
          this.state = 'lost';
          this.projectiles.length = 0;
          emit('lose', {});
          return;
        }
        continue;
      }
      this._place(e);
    }
  };

  // Healere helbreder andre fjender i nærheden. Flere healere lægges ikke sammen – den stærkeste gælder.
  P._updateHealers = function (dt) {
    var enemies = this.enemies;
    var i, j, any = false;
    for (i = 0; i < enemies.length; i++) {
      enemies[i].healing = 0;
      if (enemies[i].alive && enemies[i].heal) any = true;
    }
    if (!any) return;

    for (i = 0; i < enemies.length; i++) {
      var h = enemies[i];
      if (!h.alive || !h.heal) continue;
      for (j = 0; j < enemies.length; j++) {
        var e = enemies[j];
        if (e === h || !e.alive || e.hp >= e.maxHp) continue;
        var dx = e.x - h.x, dy = e.y - h.y;
        var reach = h.heal.radius + e.radius;
        if (dx * dx + dy * dy <= reach * reach && h.heal.perSecond > e.healing) {
          e.healing = h.heal.perSecond;
        }
      }
    }
    for (i = 0; i < enemies.length; i++) {
      var t = enemies[i];
      if (t.healing > 0 && t.alive) t.hp = Math.min(t.maxHp, t.hp + t.healing * dt);
    }
  };

  // ------------------------------------------------------------------- tårne

  // Den fjende inden for rækkevidde, der er nået længst.
  P._findTarget = function (tower) {
    var range = num(tower.stats.range, 0);
    var rangeSq = range * range;
    var best = null;
    var enemies = this.enemies;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!e.alive) continue;
      var dx = e.x - tower.x, dy = e.y - tower.y;
      if (dx * dx + dy * dy > rangeSq) continue;
      if (!best || e.dist > best.dist) best = e;
    }
    return best;
  };

  P._updateTowers = function (dt) {
    for (var i = 0; i < this.towers.length; i++) {
      var tower = this.towers[i];
      var stats = tower.stats;
      tower.sinceShot += dt;
      if (tower.cooldown > 0) tower.cooldown -= dt;

      var target = this._findTarget(tower);
      tower.target = target;
      if (!target) {
        if (tower.cooldown < 0) tower.cooldown = 0;
        continue;
      }

      var aim = Math.atan2(target.y - tower.y, target.x - tower.x);
      var diff = angleDiff(tower.angle, aim);
      var maxTurn = TURN_SPEED * dt;
      tower.angle += Math.abs(diff) <= maxTurn ? diff : (diff > 0 ? maxTurn : -maxTurn);

      var kind = tower.def.kind;
      if (kind === 'beam') {
        tower.angle = aim;
        this._fireLaser(tower, target, dt);
        continue;
      }

      if (tower.cooldown > 0) continue;
      var rate = num(stats.fireRate, 1);
      tower.cooldown = Math.max(tower.cooldown, -dt) + (rate > 0 ? 1 / rate : 1);
      tower.sinceShot = 0;
      tower.angle = aim;
      emit('shoot', { towerType: tower.type, x: tower.x, y: tower.y, angle: aim });

      if (kind === 'bullet' || kind === 'rocket') this._fireProjectile(tower, target, kind);
      else if (kind === 'slow') this._fireFrost(tower);
      else if (kind === 'chain') this._fireTesla(tower, target);
      else if (kind === 'rail') this._fireRail(tower, aim);
    }
  };

  P._fireLaser = function (tower, target, dt) {
    var beam = tower.beam;
    if (!beam || beam.life <= 0) {
      beam = tower.beam = {
        kind: 'laser',
        towerType: tower.type,
        points: [{ x: tower.x, y: tower.y }, { x: target.x, y: target.y }],
        radius: 0,
        life: LASER_BEAM_LIFE,
        maxLife: LASER_BEAM_LIFE,
        color: tower.def.color
      };
      this.beams.push(beam);
      tower.hitTimer = 0;
      emit('shoot', { towerType: tower.type, x: tower.x, y: tower.y, angle: tower.angle });
    }
    beam.points[1].x = target.x;
    beam.points[1].y = target.y;
    beam.life = beam.maxLife;
    tower.sinceShot = 0;

    tower.hitTimer -= dt;
    if (tower.hitTimer <= 0) {
      tower.hitTimer = LASER_HIT_INTERVAL;
      emit('hit', { towerType: tower.type, x: target.x, y: target.y, color: tower.def.color });
    }
    this._damage(target, num(tower.stats.dps, 0) * dt, tower.def.damageType, tower);
  };

  P._fireProjectile = function (tower, target, kind) {
    var stats = tower.stats;
    this.projectiles.push({
      kind: kind,
      towerType: tower.type,
      x: tower.x,
      y: tower.y,
      angle: tower.angle,
      color: tower.def.color,
      // Internt
      tower: tower,
      target: target,
      tx: target.x,
      ty: target.y,
      speed: Math.max(20, num(stats.projectileSpeed, 300)),
      damage: num(stats.damage, 0),
      damageType: tower.def.damageType,
      splash: kind === 'rocket' ? Math.max(0, num(stats.splash, 0)) : 0,
      life: PROJECTILE_MAX_LIFE,
      done: false
    });
  };

  P._fireFrost = function (tower) {
    var stats = tower.stats;
    var range = num(stats.range, 0);
    var enemies = this.enemies;
    var hits = 0;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!e.alive) continue;
      var dx = e.x - tower.x, dy = e.y - tower.y;
      var reach = range + e.radius;
      if (dx * dx + dy * dy > reach * reach) continue;
      this._applySlow(e, num(stats.slow, 0), num(stats.duration, 0));
      if (hits++ < MAX_HITS_PER_SHOT) {
        emit('hit', { towerType: tower.type, x: e.x, y: e.y, color: tower.def.color });
      }
      this._damage(e, num(stats.damage, 0), tower.def.damageType, tower);
    }
    this.beams.push({
      kind: 'frost',
      towerType: tower.type,
      points: [{ x: tower.x, y: tower.y }],
      radius: range,
      life: BEAM_LIFE.frost,
      maxLife: BEAM_LIFE.frost,
      color: tower.def.color
    });
  };

  P._fireTesla = function (tower, target) {
    var stats = tower.stats;
    var enemies = this.enemies;
    var chainRange = num(stats.chainRange, 0);
    var falloff = num(stats.falloff, 1);
    var jumps = Math.max(0, Math.floor(num(stats.chains, 0)));
    var damage = num(stats.damage, 0);
    var points = [{ x: tower.x, y: tower.y }];
    var struck = [];
    var current = target;

    while (current) {
      struck.push(current);
      points.push({ x: current.x, y: current.y });
      emit('hit', { towerType: tower.type, x: current.x, y: current.y, color: tower.def.color });
      var fromX = current.x, fromY = current.y;
      this._damage(current, damage, tower.def.damageType, tower);
      if (struck.length > jumps) break;

      damage *= falloff;
      var next = null, bestSq = chainRange * chainRange;
      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (!e.alive || struck.indexOf(e) >= 0) continue;
        var dx = e.x - fromX, dy = e.y - fromY;
        var dSq = dx * dx + dy * dy;
        if (dSq <= bestSq) {
          bestSq = dSq;
          next = e;
        }
      }
      current = next;
    }

    this.beams.push({
      kind: 'tesla',
      towerType: tower.type,
      points: points,
      radius: 0,
      life: BEAM_LIFE.tesla,
      maxLife: BEAM_LIFE.tesla,
      color: tower.def.color
    });
  };

  P._fireRail = function (tower, aim) {
    var stats = tower.stats;
    var range = num(stats.range, 0);
    var width = Math.max(2, num(stats.width, 16));
    var ex = tower.x + Math.cos(aim) * range;
    var ey = tower.y + Math.sin(aim) * range;
    var enemies = this.enemies;
    var hits = 0;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!e.alive) continue;
      var reach = width / 2 + e.radius;
      if (segDistSq(e.x, e.y, tower.x, tower.y, ex, ey) > reach * reach) continue;
      if (hits++ < MAX_HITS_PER_SHOT) {
        emit('hit', { towerType: tower.type, x: e.x, y: e.y, color: tower.def.color });
      }
      this._damage(e, num(stats.damage, 0), tower.def.damageType, tower);
    }
    this.beams.push({
      kind: 'rail',
      towerType: tower.type,
      points: [{ x: tower.x, y: tower.y }, { x: ex, y: ey }],
      radius: 0,
      width: width,
      life: BEAM_LIFE.rail,
      maxLife: BEAM_LIFE.rail,
      color: tower.def.color
    });
  };

  // ------------------------------------------------------------- projektiler

  P._nearestEnemy = function (x, y, maxDist) {
    var best = null, bestSq = maxDist * maxDist;
    var enemies = this.enemies;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!e.alive) continue;
      var dx = e.x - x, dy = e.y - y;
      var reach = dx * dx + dy * dy;
      if (reach <= bestSq) {
        bestSq = reach;
        best = e;
      }
    }
    return best;
  };

  P._updateProjectiles = function (dt) {
    var list = this.projectiles;
    var i, n = 0;
    for (i = 0; i < list.length; i++) {
      var p = list[i];
      p.life -= dt;

      if (p.target && !p.target.alive) {
        // Målet er væk: raketter søger et nyt, kugler flyver videre til det sidste kendte punkt.
        p.target = p.kind === 'rocket' ? this._nearestEnemy(p.x, p.y, ROCKET_RETARGET) : null;
      }
      if (p.target) {
        p.tx = p.target.x;
        p.ty = p.target.y;
      }

      var dx = p.tx - p.x, dy = p.ty - p.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var step = p.speed * dt;
      var reach = step + (p.target ? p.target.radius * 0.6 : 0);
      if (d > 0.001) p.angle = Math.atan2(dy, dx);

      if (d <= reach || p.life <= 0) {
        if (d <= reach) {
          p.x = p.tx;
          p.y = p.ty;
        }
        this._impact(p);
        p.done = true;
      } else {
        p.x += dx / d * step;
        p.y += dy / d * step;
      }
    }
    for (i = 0; i < list.length; i++) {
      if (!list[i].done) list[n++] = list[i];
    }
    list.length = n;
  };

  P._impact = function (p) {
    if (p.kind === 'rocket') {
      emit('explosion', { x: p.x, y: p.y, radius: p.splash, color: p.color });
      emit('hit', { towerType: p.towerType, x: p.x, y: p.y, color: p.color });
      var enemies = this.enemies;
      var primary = p.target;
      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (!e.alive) continue;
        if (e === primary) {
          this._damage(e, p.damage, p.damageType, p.tower);
          continue;
        }
        var dx = e.x - p.x, dy = e.y - p.y;
        var d = Math.sqrt(dx * dx + dy * dy) - e.radius;
        if (d > p.splash) continue;
        // Fuld skade i midten, aftagende mod kanten.
        var share = p.splash > 0 ? 1 - (1 - SPLASH_EDGE) * Math.max(0, d) / p.splash : 1;
        this._damage(e, p.damage * share, p.damageType, p.tower);
      }
      return;
    }

    var victim = p.target;
    if (!victim) {
      // Kuglen nåede det sted, hvor målet døde – ram en fjende, hvis der står en dér.
      var near = this._nearestEnemy(p.x, p.y, 30);
      if (near) {
        var nx = near.x - p.x, ny = near.y - p.y;
        var touch = near.radius + 6;
        if (nx * nx + ny * ny <= touch * touch) victim = near;
      }
    }
    if (victim && victim.alive) {
      emit('hit', { towerType: p.towerType, x: victim.x, y: victim.y, color: p.color });
      this._damage(victim, p.damage, p.damageType, p.tower);
    }
  };

  // ------------------------------------------------------- oprydning og slut

  P._sweep = function () {
    var enemies = this.enemies, n = 0, i;
    for (i = 0; i < enemies.length; i++) {
      if (enemies[i].alive) enemies[n++] = enemies[i];
    }
    enemies.length = n;
    for (i = 0; i < this.towers.length; i++) {
      var tower = this.towers[i];
      if (tower.target && !tower.target.alive) tower.target = null;
    }
  };

  P._endWave = function () {
    var wave = this.waves[this.waveIndex] || {};
    var bonus = Math.max(0, num(wave.bonus, 0));
    this.money += bonus;
    this._queue = [];
    this._queuePos = 0;
    this.toSpawn = 0;
    emit('waveEnd', { index: this.waveIndex, bonus: bonus });

    if (this.waveIndex >= this.waveCount - 1) {
      // waveIndex bliver stående på sidste bølge, så "bølge x af y" stadig giver mening.
      this.state = 'won';
      this.projectiles.length = 0;
      emit('win', { lives: this.lives, maxLives: this.maxLives });
    } else {
      this.waveIndex += 1;
      this.state = 'build';
    }
  };

  TD.Game = Game;
})();
