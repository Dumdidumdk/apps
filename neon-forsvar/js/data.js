// NEON FORSVAR – spildata (TD.DATA): tårne, fjender og de 20 baner.
(function () {
  'use strict';

  var TD = window.TD = window.TD || {};

  // ------------------------------------------------------------------ tårne
  //
  // Tommelfingerregel for balancen: ca. 0,30 skade pr. sekund pr. krone mod ét mål.
  // Tårne, der rammer flere fjender ad gangen (raket, tesla, plasma), ligger lavere mod
  // ét mål og tjener forskellen hjem i tætte bølger. Opgraderinger er en smule bedre køb
  // end et nyt tårn af samme slags, så det kan betale sig at bygge i dybden.

  var towers = {
    kanon: {
      id: 'kanon',
      name: 'Kanon',
      desc: 'Billig og pålidelig. Skyder hurtige projektiler mod ét mål – svag mod panser.',
      kind: 'bullet',
      damageType: 'kinetic',
      color: '#ffb020',
      cost: 100,
      levels: [
        { damage: 20, range: 130, fireRate: 1.5, projectileSpeed: 520 },
        { cost: 90, damage: 36, range: 145, fireRate: 1.7, projectileSpeed: 580 },
        { cost: 180, damage: 66, range: 160, fireRate: 2.0, projectileSpeed: 640 }
      ]
    },
    laser: {
      id: 'laser',
      name: 'Laser',
      desc: 'Konstant energistråle på ét mål. Går lige gennem panser og smelter skjolde.',
      kind: 'beam',
      damageType: 'energy',
      color: '#ff3d6e',
      cost: 150,
      levels: [
        { dps: 30, range: 150 },
        { cost: 140, dps: 62, range: 165 },
        { cost: 260, dps: 125, range: 180 }
      ]
    },
    raket: {
      id: 'raket',
      name: 'Raketkaster',
      desc: 'Målsøgende raketter med områdeskade. Lang rækkevidde – bedst mod tætte flokke.',
      kind: 'rocket',
      damageType: 'kinetic',
      color: '#ff7a1a',
      cost: 220,
      levels: [
        { damage: 48, range: 190, fireRate: 0.55, projectileSpeed: 280, splash: 60 },
        { cost: 200, damage: 88, range: 205, fireRate: 0.65, projectileSpeed: 310, splash: 70 },
        { cost: 380, damage: 160, range: 225, fireRate: 0.75, projectileSpeed: 340, splash: 85 }
      ]
    },
    fryser: {
      id: 'fryser',
      name: 'Frysetårn',
      desc: 'Iskold puls, der sinker alle fjender i nærheden. Gør kun lidt skade selv.',
      kind: 'slow',
      damageType: 'energy',
      color: '#5ad8ff',
      cost: 160,
      levels: [
        { damage: 4, range: 100, fireRate: 0.8, slow: 0.3, duration: 1.5 },
        { cost: 150, damage: 8, range: 115, fireRate: 0.9, slow: 0.4, duration: 1.8 },
        { cost: 280, damage: 14, range: 130, fireRate: 1.0, slow: 0.5, duration: 2.2 }
      ]
    },
    tesla: {
      id: 'tesla',
      name: 'Tesla-lyn',
      desc: 'Lyn, der hopper fra fjende til fjende. Energiskade – stærk mod skjolde og sværme.',
      kind: 'chain',
      damageType: 'energy',
      color: '#b46bff',
      cost: 280,
      // chains = antal ekstra hop efter det første mål
      levels: [
        { damage: 34, range: 140, fireRate: 1.1, chains: 3, chainRange: 90, falloff: 0.7 },
        { cost: 260, damage: 58, range: 150, fireRate: 1.2, chains: 4, chainRange: 100, falloff: 0.75 },
        { cost: 480, damage: 98, range: 165, fireRate: 1.4, chains: 5, chainRange: 110, falloff: 0.8 }
      ]
    },
    plasma: {
      id: 'plasma',
      name: 'Plasmakanon',
      desc: 'Dyr superkanon. Langsom, men strålen brænder gennem alle fjender på linjen.',
      kind: 'rail',
      damageType: 'energy',
      color: '#3dffb4',
      cost: 600,
      levels: [
        { damage: 320, range: 260, fireRate: 0.35, width: 26 },
        { cost: 550, damage: 600, range: 290, fireRate: 0.4, width: 30 },
        { cost: 950, damage: 1100, range: 320, fireRate: 0.45, width: 36 }
      ]
    }
  };

  var towerOrder = ['kanon', 'laser', 'raket', 'fryser', 'tesla', 'plasma'];

  // ---------------------------------------------------------------- fjender
  //
  // Belønningen ligger på ca. 0,09–0,17 kr. pr. livspoint. Skjold og helbredelse skaleres
  // af spilmotoren sammen med livet, så fjenderne beholder deres særpræg i de svære baner.

  var enemies = {
    drone: {
      id: 'drone', name: 'Drone', shape: 'drone',
      hp: 60, speed: 60, reward: 8, radius: 12, color: '#33ccff',
      armor: 0, shield: 0, slowResist: 0, livesCost: 1, boss: false, heal: null
    },
    sprinter: {
      id: 'sprinter', name: 'Sprinter', shape: 'sprinter',
      hp: 35, speed: 120, reward: 6, radius: 9, color: '#ffe14d',
      armor: 0, shield: 0, slowResist: 0, livesCost: 1, boss: false, heal: null
    },
    tank: {
      id: 'tank', name: 'Panserkrydser', shape: 'tank',
      hp: 260, speed: 36, reward: 26, radius: 16, color: '#ff7a3c',
      armor: 0.6, shield: 0, slowResist: 0.2, livesCost: 2, boss: false, heal: null
    },
    swarm: {
      id: 'swarm', name: 'Sværmer', shape: 'swarm',
      hp: 16, speed: 85, reward: 2, radius: 7, color: '#9dff5a',
      armor: 0, shield: 0, slowResist: 0, livesCost: 1, boss: false, heal: null
    },
    shield: {
      id: 'shield', name: 'Skjoldbærer', shape: 'shield',
      hp: 90, speed: 55, reward: 14, radius: 13, color: '#7c8cff',
      armor: 0, shield: 100, slowResist: 0, livesCost: 1, boss: false, heal: null
    },
    healer: {
      id: 'healer', name: 'Reparatør', shape: 'healer',
      hp: 110, speed: 50, reward: 16, radius: 12, color: '#4dffb0',
      armor: 0, shield: 0, slowResist: 0.2, livesCost: 1, boss: false,
      heal: { radius: 90, perSecond: 12 }
    },
    boss: {
      id: 'boss', name: 'Moderskib', shape: 'boss',
      hp: 2200, speed: 28, reward: 250, radius: 26, color: '#ff3d6e',
      armor: 0.3, shield: 0, slowResist: 0.6, livesCost: 10, boss: true, heal: null
    },
    megaboss: {
      id: 'megaboss', name: 'Kernens Vogter', shape: 'boss',
      hp: 6000, speed: 22, reward: 800, radius: 34, color: '#ff2bd6',
      armor: 0.4, shield: 1200, slowResist: 0.8, livesCost: 25, boss: true, heal: null
    },
    // Overraskelsesbosser: står ikke i bølgeplanen, men dukker op en gang imellem (se SURPRISE).
    pirat: {
      id: 'pirat', name: 'Rumpirat', shape: 'boss',
      hp: 300, speed: 58, reward: 70, radius: 19, color: '#ffb020',
      armor: 0.15, shield: 0, slowResist: 0.4, livesCost: 2, boss: true, heal: null
    },
    kolos: {
      id: 'kolos', name: 'Jernkolos', shape: 'boss',
      hp: 520, speed: 30, reward: 100, radius: 22, color: '#d8e4ff',
      armor: 0.45, shield: 0, slowResist: 0.5, livesCost: 3, boss: true, heal: null
    }
  };

  var enemyOrder = ['drone', 'sprinter', 'swarm', 'tank', 'shield', 'healer', 'pirat', 'kolos', 'boss', 'megaboss'];

  // Overraskelsesbosser. Fra bane fromLevel og bølge fromWave (1-baseret) er der chance for, at
  // én af dem blander sig i bølgen. Aldrig i sidste bølge og aldrig i bølger, der allerede har en boss.
  // types: [fjendetype, første bane hvor den kan dukke op]
  var SURPRISE = {
    chance: 0.2,
    fromLevel: 2,
    fromWave: 3,
    types: [['pirat', 2], ['kolos', 6]]
  };

  // ----------------------------------------------------------------- bølger
  //
  // Hver bølge har et "budget" i rå livspoint: base * (1 + ramp * bølgenummer).
  // En opskrift fordeler budgettet på fjendetyper. BUDGET_COST er prisen pr. fjende;
  // hurtige, pansrede og helbredende fjender koster mere end deres rå liv, fordi de er
  // sværere at stoppe. Bosser tælles ikke med i budgettet – de kommer oveni.

  var BUDGET_COST = { drone: 60, sprinter: 45, tank: 360, swarm: 18, shield: 160, healer: 170 };
  var INTERVAL = { drone: 0.85, sprinter: 0.5, tank: 1.9, swarm: 0.28, shield: 1.2, healer: 2.6, boss: 9, megaboss: 1 };
  var SQUEEZE = 0.45; // fjenderne kommer så meget tættere i banens sidste bølge end i den første
  var MAX_GROUP = 60; // loft pr. gruppe, så skærmen ikke drukner; resten bliver til droner

  // [type, andel af budget, delay]  –  eller  [type, -antal, delay] for et fast antal
  var RECIPES = {
    D: [['drone', 1, 0]],
    S: [['sprinter', 1, 0]],
    W: [['swarm', 1, 0]],
    T: [['tank', 1, 0]],
    H: [['shield', 1, 0]],
    DS: [['drone', 0.6, 0], ['sprinter', 0.4, 5]],
    DT: [['drone', 0.5, 0], ['tank', 0.5, 3]],
    DH: [['drone', 0.4, 0], ['shield', 0.6, 3]],
    WS: [['swarm', 0.6, 0], ['sprinter', 0.4, 4]],
    TH: [['tank', 0.5, 0], ['shield', 0.5, 2]],
    E: [['tank', 0.55, 0], ['healer', 0.2, 2], ['drone', 0.25, 1]],
    HE: [['shield', 0.6, 0], ['healer', 0.25, 1.5], ['sprinter', 0.15, 8]],
    X1: [['drone', 0.35, 0], ['tank', 0.3, 3], ['sprinter', 0.2, 6], ['swarm', 0.15, 10]],
    X2: [['drone', 0.2, 0], ['shield', 0.25, 2], ['tank', 0.25, 4], ['sprinter', 0.15, 7], ['swarm', 0.15, 11]],
    X3: [['tank', 0.3, 0], ['shield', 0.3, 1], ['healer', 0.12, 3], ['sprinter', 0.15, 6], ['swarm', 0.13, 10]],
    B: [['drone', 0.45, 0], ['sprinter', 0.2, 4], ['boss', -1, 6]],
    B2: [['tank', 0.3, 0], ['shield', 0.3, 2], ['healer', 0.1, 4], ['boss', -2, 6]],
    B3: [['tank', 0.3, 0], ['shield', 0.3, 2], ['healer', 0.1, 4], ['swarm', 0.15, 12], ['boss', -3, 6]],
    M: [['tank', 0.25, 0], ['shield', 0.3, 3], ['healer', 0.1, 5], ['boss', -2, 2],
      ['megaboss', -1, 14], ['swarm', 0.15, 18], ['sprinter', 0.15, 24]]
  };

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function buildWaves(spec, eco) {
    var plan = spec.plan.split(' ');
    var waves = [];
    for (var w = 0; w < plan.length; w++) {
      var recipe = RECIPES[plan[w]];
      var budget = spec.base * (1 + spec.ramp * w);
      var pace = spec.tempo * (1 - SQUEEZE * w / (plan.length - 1));
      var groups = [];
      var overflow = 0;
      for (var i = 0; i < recipe.length; i++) {
        var type = recipe[i][0], share = recipe[i][1];
        var count;
        if (share < 0) {
          count = -share;
        } else {
          count = Math.max(1, Math.round(budget * share / BUDGET_COST[type]));
          if (count > MAX_GROUP) {
            overflow += (count - MAX_GROUP) * BUDGET_COST[type];
            count = MAX_GROUP;
          }
        }
        groups.push({
          type: type,
          count: count,
          interval: enemies[type].boss ? INTERVAL[type] : round2(INTERVAL[type] * pace),
          delay: recipe[i][2]
        });
      }
      if (overflow >= BUDGET_COST.drone) {
        groups.push({
          type: 'drone',
          count: Math.min(MAX_GROUP, Math.round(overflow / BUDGET_COST.drone)),
          interval: round2(INTERVAL.drone * pace),
          delay: 2
        });
      }
      waves.push({ bonus: Math.round((eco[4] + eco[5] * w) / 5) * 5, groups: groups });
    }
    return waves;
  }

  // ------------------------------------------------------------------ baner
  //
  // Sådan er sværhedsgraden bygget op:
  //  - Antallet af fjender pr. bølge vokser kun langsomt fra bane til bane (base). I stedet
  //    bliver fjenderne sejere (hpScale), og belønning, bølgebonus og startpenge vokser med
  //    (rewardScale m.m.) – indtægten følger altså fjendernes liv, men halter mere og mere
  //    bagefter, jo længere man kommer.
  //  - Inde i en bane vokser fjendernes liv kraftigt fra bølge til bølge (waveGrowth), og de
  //    kommer tættere (SQUEEZE), så de sidste bølger er de sværeste, selv om man har flere tårne.
  //  - Tallene i ECONOMY er afstemt med robotspillere mod den rigtige spilmotor (test.html).
  //
  // Pr. bane: [startMoney, hpScale, rewardScale, waveGrowth, bonus, bonusStep]
  // (bølgebonus = bonus + bonusStep * bølgenummer, afrundet til nærmeste 5)
  var ECONOMY = [
    [300, 1.00, 1.00, 0.17, 40, 5],
    [320, 1.05, 1.00, 0.25, 42, 5],
    [340, 1.10, 1.00, 0.30, 44, 5],
    [360, 1.15, 1.00, 0.32, 46, 5],
    [570, 1.25, 1.85, 0.34, 88.8, 9.25],
    [520, 1.35, 0.84, 0.32, 42, 4.2],
    [420, 1.45, 1.00, 0.31, 52, 5],
    [440, 1.55, 1.20, 0.31, 64.8, 6],
    [460, 1.65, 1.00, 0.30, 56, 5],
    [720, 1.80, 1.40, 0.29, 81.2, 7],
    [750, 1.90, 1.40, 0.29, 84, 7],
    [520, 2.00, 1.40, 0.29, 86.8, 7],
    [810, 2.10, 1.40, 0.28, 89.6, 7],
    [840, 2.25, 1.40, 0.28, 92.4, 7],
    [1020, 2.40, 2.10, 0.27, 142.8, 10.5],
    [1500, 2.50, 1.20, 0.27, 84, 6],
    [1550, 2.65, 1.10, 0.27, 79.2, 5.5],
    [960, 2.80, 1.20, 0.26, 88.8, 6],
    [1980, 3.00, 1.60, 0.26, 121.6, 8],
    [1700, 3.20, 3.30, 0.26, 257.4, 16.5]
  ];

  var SECTORS = [
    { name: 'Sektor Alfa', color: '#2ee6ff' },
    { name: 'Sektor Beta', color: '#4dffa0' },
    { name: 'Sektor Gamma', color: '#c77bff' },
    { name: 'Sektor Delta', color: '#ff6a3d' }
  ];

  // plan = én opskrift pr. bølge (se RECIPES). tempo ganges på afstanden mellem fjender.
  var LEVEL_SPECS = [
    // ---------------------------------------------------------- Sektor Alfa
    {
      name: 'Yderposten', mapPos: { x: 110, y: 600 },
      theme: { bg1: '#050818', bg2: '#0a1030', grid: '#12233f', path: '#00e5ff', accent: '#ff3df0' },
      path: [[-1, 4], [6, 4], [6, 12], [13, 12], [13, 4], [20, 4], [20, 12], [26, 12]],
      speedScale: 1.0, base: 480, ramp: 0.25, tempo: 1.0,
      plan: 'D D DS D S DS D DS'
    },
    {
      name: 'Støvbæltet', mapPos: { x: 225, y: 515 },
      theme: { bg1: '#06091a', bg2: '#0c1436', grid: '#152846', path: '#19c8ff', accent: '#ffb020' },
      path: [[-1, 14], [5, 14], [5, 3], [12, 3], [12, 10], [19, 10], [19, 3], [26, 3]],
      speedScale: 1.0, base: 505, ramp: 0.24, tempo: 0.98,
      plan: 'D DS S D DS S DS D DS'
    },
    {
      name: 'Krystalminen', mapPos: { x: 115, y: 425 },
      theme: { bg1: '#04101c', bg2: '#08203a', grid: '#11344a', path: '#35f0d0', accent: '#8a7dff' },
      path: [[4, -1], [4, 13], [11, 13], [11, 4], [18, 4], [18, 13], [26, 13]],
      speedScale: 1.02, base: 530, ramp: 0.23, tempo: 0.96,
      plan: 'D W DS W S WS D WS DS'
    },
    {
      name: 'Solvindspasset', mapPos: { x: 230, y: 330 },
      theme: { bg1: '#070a1e', bg2: '#101a40', grid: '#1a2c52', path: '#4aa8ff', accent: '#ffd23d' },
      path: [[-1, 2], [22, 2], [22, 8], [3, 8], [3, 14], [26, 14]],
      speedScale: 1.03, base: 555, ramp: 0.22, tempo: 0.94,
      plan: 'D DS T W DT S DT WS T X1'
    },
    {
      name: 'Jernmånen', mapPos: { x: 125, y: 225 },
      theme: { bg1: '#080a1c', bg2: '#141a3a', grid: '#1e2a4c', path: '#6fd0ff', accent: '#ff3d6e' },
      path: [[-1, 15], [3, 15], [3, 3], [10, 3], [10, 12], [16, 12], [16, 3], [22, 3], [22, 18]],
      speedScale: 1.04, base: 580, ramp: 0.22, tempo: 0.92,
      plan: 'DS W DT S T WS DT X1 T B'
    },
    // ---------------------------------------------------------- Sektor Beta
    {
      name: 'Tågeporten', mapPos: { x: 385, y: 150 },
      theme: { bg1: '#04140f', bg2: '#082a22', grid: '#113c30', path: '#3dffa2', accent: '#ffe14d' },
      path: [[26, 8], [21, 8], [21, 2], [14, 2], [14, 15], [7, 15], [7, 6], [2, 6], [2, 18]],
      speedScale: 1.05, base: 605, ramp: 0.21, tempo: 0.9,
      plan: 'D DS H W DH T S DH X1 TH X2'
    },
    {
      name: 'Ionstormen', mapPos: { x: 505, y: 235 },
      theme: { bg1: '#05151a', bg2: '#0a2c33', grid: '#134048', path: '#2ff5e0', accent: '#b46bff' },
      path: [[8, -1], [8, 6], [2, 6], [2, 14], [14, 14], [14, 3], [23, 3], [23, 11], [18, 11], [18, 18]],
      speedScale: 1.06, base: 630, ramp: 0.21, tempo: 0.88,
      plan: 'DS W DH T WS H DT X1 S TH X2 X2'
    },
    {
      name: 'Station Kepler', mapPos: { x: 390, y: 345 },
      theme: { bg1: '#06160c', bg2: '#0e2e1a', grid: '#184226', path: '#7dff5a', accent: '#19c8ff' },
      path: [[-1, 8], [5, 8], [5, 2], [11, 2], [11, 14], [17, 14], [17, 5], [22, 5], [22, 11], [26, 11]],
      speedScale: 1.08, base: 655, ramp: 0.2, tempo: 0.86,
      plan: 'DS DH E WS T HE X1 DH E S X2 X3'
    },
    {
      name: 'Den lange korridor', mapPos: { x: 520, y: 445 },
      theme: { bg1: '#04120f', bg2: '#0a2624', grid: '#123a36', path: '#4dffd0', accent: '#ff7a1a' },
      path: [[-1, 2], [23, 2], [23, 7], [2, 7], [2, 12], [23, 12], [23, 16], [-1, 16]],
      speedScale: 1.1, base: 680, ramp: 0.2, tempo: 0.84,
      plan: 'DS W T DH E WS X2 HE S TH X3 E X3'
    },
    {
      name: 'Dobbeltstjernen', mapPos: { x: 420, y: 565 },
      theme: { bg1: '#07170a', bg2: '#123016', grid: '#1c4420', path: '#b4ff3d', accent: '#ff3d6e' },
      path: [[13, -1], [13, 4], [3, 4], [3, 10], [22, 10], [22, 15], [8, 15], [8, 18]],
      speedScale: 1.1, base: 705, ramp: 0.2, tempo: 0.82,
      plan: 'DS DH W T E X1 B HE S TH X2 X3 E B'
    },
    // --------------------------------------------------------- Sektor Gamma
    {
      name: 'Asteroidesmedjen', mapPos: { x: 700, y: 610 },
      theme: { bg1: '#10061c', bg2: '#200c38', grid: '#30154c', path: '#c77bff', accent: '#3dffb4' },
      path: [[-1, 5], [9, 5], [9, 12], [17, 12], [17, 5], [26, 5]],
      speedScale: 1.12, base: 730, ramp: 0.19, tempo: 0.8,
      plan: 'DH S T X1 WS E H X2 HE S TH X3 X2 X3'
    },
    {
      name: 'Skyggekløften', mapPos: { x: 825, y: 520 },
      theme: { bg1: '#0e0520', bg2: '#1c0a3e', grid: '#2a1454', path: '#9a6bff', accent: '#ff3df0' },
      path: [[26, 15], [20, 15], [20, 3], [13, 3], [13, 12], [6, 12], [6, 3], [-1, 3]],
      speedScale: 1.14, base: 755, ramp: 0.19, tempo: 0.79,
      plan: 'DS T W DH X1 E S TH X2 HE WS X3 E X2 X3'
    },
    {
      name: 'Pulsarfyret', mapPos: { x: 710, y: 420 },
      theme: { bg1: '#12051a', bg2: '#260a34', grid: '#381448', path: '#ff5ad8', accent: '#5ad8ff' },
      path: [[3, -1], [3, 7], [10, 7], [10, 2], [17, 2], [17, 14], [23, 14], [23, 7], [26, 7]],
      speedScale: 1.16, base: 780, ramp: 0.19, tempo: 0.78,
      plan: 'DH WS T E X2 S HE TH X3 W X2 E X3 S HE X3'
    },
    {
      name: 'Neonruinerne', mapPos: { x: 840, y: 320 },
      theme: { bg1: '#0c0622', bg2: '#180e42', grid: '#261858', path: '#7d8cff', accent: '#ffe14d' },
      path: [[-1, 10], [6, 10], [6, 15], [12, 15], [12, 3], [19, 3], [19, 11], [26, 11]],
      speedScale: 1.18, base: 805, ramp: 0.18, tempo: 0.77,
      plan: 'X1 S TH E W X2 HE T X3 WS E X2 TH X3 HE X3'
    },
    {
      name: 'Sværmens rede', mapPos: { x: 730, y: 205 },
      theme: { bg1: '#14051c', bg2: '#2c0a36', grid: '#40144a', path: '#e06bff', accent: '#ff3d6e' },
      path: [[22, -1], [22, 5], [4, 5], [4, 11], [18, 11], [18, 15], [26, 15]],
      speedScale: 1.2, base: 830, ramp: 0.18, tempo: 0.76,
      plan: 'DH T WS E X2 S HE B TH X3 W E X2 X3 HE X3 B2'
    },
    // --------------------------------------------------------- Sektor Delta
    {
      name: 'Den glødende zone', mapPos: { x: 995, y: 145 },
      theme: { bg1: '#1a0806', bg2: '#34120c', grid: '#481c14', path: '#ff8a3d', accent: '#ffe14d' },
      path: [[-1, 13], [4, 13], [4, 4], [9, 4], [9, 13], [14, 13], [14, 4], [19, 4], [19, 13], [26, 13]],
      speedScale: 1.22, base: 855, ramp: 0.18, tempo: 0.75,
      plan: 'X2 S TH E WS X3 HE T X2 W E X3 TH S X3 HE X3'
    },
    {
      name: 'Hændelseshorisonten', mapPos: { x: 1135, y: 240 },
      theme: { bg1: '#1a0610', bg2: '#360c20', grid: '#4a1630', path: '#ff4d7d', accent: '#5ad8ff' },
      path: [[26, 2], [3, 2], [3, 9], [12, 9], [12, 15], [26, 15]],
      speedScale: 1.24, base: 880, ramp: 0.17, tempo: 0.74,
      plan: 'X2 WS E TH X3 S HE X2 T X3 W E X3 TH HE X2 X3 X3'
    },
    {
      name: 'Antistofværftet', mapPos: { x: 1010, y: 350 },
      theme: { bg1: '#1c0a04', bg2: '#381608', grid: '#4c2210', path: '#ffb020', accent: '#ff3df0' },
      path: [[6, -1], [6, 5], [18, 5], [18, 10], [3, 10], [3, 15], [22, 15], [22, 18]],
      speedScale: 1.26, base: 905, ramp: 0.17, tempo: 0.73,
      plan: 'X2 S TH E X3 WS HE X2 T X3 W E X3 TH HE X3 S X3 X3'
    },
    {
      name: 'Sidste bastion', mapPos: { x: 1145, y: 455 },
      theme: { bg1: '#1c0606', bg2: '#3a0c0c', grid: '#501616', path: '#ff5a3d', accent: '#3dffb4' },
      path: [[-1, 8], [8, 8], [8, 3], [17, 3], [17, 13], [26, 13]],
      speedScale: 1.28, base: 930, ramp: 0.17, tempo: 0.72,
      plan: 'X3 WS TH E X2 S HE X3 T X3 W E X3 TH HE X3 X2 X3 X3'
    },
    {
      name: 'Kernen', mapPos: { x: 1060, y: 595 },
      theme: { bg1: '#1e0412', bg2: '#400824', grid: '#581034', path: '#ff2bd6', accent: '#ffe14d' },
      path: [[-1, 2], [6, 2], [6, 8], [12, 8], [12, 2], [19, 2], [19, 9], [23, 9], [23, 15], [3, 15], [3, 18]],
      speedScale: 1.3, base: 955, ramp: 0.17, tempo: 0.7,
      plan: 'X2 S TH E X3 WS HE B X2 T X3 E W B2 X3 HE TH X3 X3 M'
    }
  ];

  function buildLevel(spec, index) {
    var eco = ECONOMY[index];
    return {
      id: index + 1,
      name: spec.name,
      sector: SECTORS[Math.floor(index / 5)].name,
      mapPos: spec.mapPos,
      theme: spec.theme,
      startMoney: eco[0],
      lives: 20,
      hpScale: eco[1],
      speedScale: spec.speedScale,
      rewardScale: eco[2],
      waveGrowth: eco[3],
      path: spec.path,
      waves: buildWaves(spec, eco),
      // Ekstra til galaksekortet
      difficulty: Math.min(5, 1 + Math.floor(index / 4)),
      boss: /(^| )(B|B2|B3|M)( |$)/.test(spec.plan)
    };
  }

  var levels = [];
  for (var i = 0; i < LEVEL_SPECS.length; i++) {
    levels.push(buildLevel(LEVEL_SPECS[i], i));
  }

  TD.DATA = {
    towers: towers,
    towerOrder: towerOrder,
    enemies: enemies,
    enemyOrder: enemyOrder,
    surprise: SURPRISE,
    sectors: SECTORS,
    difficultyNames: ['Let', 'Middel', 'Svær', 'Meget svær', 'Ekstrem'],
    levels: levels
  };
})();
