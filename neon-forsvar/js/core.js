// NEON FORSVAR – fælles grundlag: navnerum, konstanter, hændelser og gemt fremskridt.
(function () {
  'use strict';

  var TD = window.TD = window.TD || {};

  TD.C = {
    COLS: 26,
    ROWS: 18,
    CELL: 40,
    FIELD_W: 1040,
    FIELD_H: 720,
    APP_W: 1280,
    APP_H: 720,
    SELL_RATE: 0.7,
    SAVE_KEY: 'neon-forsvar-v1'
  };

  TD.cellCenter = function (cx, cy) {
    return { x: cx * TD.C.CELL + TD.C.CELL / 2, y: cy * TD.C.CELL + TD.C.CELL / 2 };
  };

  // Simpel hændelsesbus. En fejl i én lytter må ikke stoppe spillet.
  var listeners = {};
  TD.events = {
    on: function (name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    },
    off: function (name, fn) {
      var list = listeners[name];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit: function (name, payload) {
      var list = listeners[name];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        try {
          list[i](payload || {});
        } catch (err) {
          console.error('Fejl i lytter til "' + name + '":', err);
        }
      }
    }
  };

  function defaults() {
    return {
      unlocked: 1,
      stars: [],
      settings: { master: 0.8, sfx: 0.8, music: 0.5, muted: false }
    };
  }

  TD.Save = {
    data: defaults(),
    load: function () {
      var data = defaults();
      try {
        var raw = window.localStorage.getItem(TD.C.SAVE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.unlocked === 'number') data.unlocked = Math.max(1, Math.floor(parsed.unlocked));
            if (Array.isArray(parsed.stars)) data.stars = parsed.stars;
            if (parsed.settings && typeof parsed.settings === 'object') {
              for (var key in data.settings) {
                if (parsed.settings[key] !== undefined) data.settings[key] = parsed.settings[key];
              }
            }
          }
        }
      } catch (err) {
        // localStorage kan være spærret (privat vindue) – spil videre uden gemt fremskridt.
      }
      TD.Save.data = data;
      return data;
    },
    save: function () {
      try {
        window.localStorage.setItem(TD.C.SAVE_KEY, JSON.stringify(TD.Save.data));
      } catch (err) {
        // Se ovenfor.
      }
    },
    reset: function () {
      TD.Save.data = defaults();
      TD.Save.save();
    }
  };
})();
