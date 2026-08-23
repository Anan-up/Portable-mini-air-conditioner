/* 便携小空调 —— 逻辑脚本
 * 复刻原版行为：开关机 / 制冷制热切换 / 温度调节（16-31°C）
 * 状态存 localStorage（30 天有效），音效用 WebAudio 合成，不依赖外部资源
 */
(function () {
  "use strict";

  var TEMP_MIN = 16, TEMP_MAX = 31;
  var EXPIRE_DAYS = 30;

  /* ---------- 安全存储 ----------
   * 某些环境（沙箱 iframe、隐私模式）会禁用 localStorage，
   * 直接访问会抛 SecurityError 导致整个脚本崩溃，这里降级为内存存储 */
  var storage = (function () {
    try {
      localStorage.setItem("__ac_test__", "1");
      localStorage.removeItem("__ac_test__");
      return localStorage;
    } catch (e) {
      var mem = {};
      return {
        getItem: function (k) { return k in mem ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); }
      };
    }
  })();

  /* ---------- 状态初始化 ---------- */
  var now = parseInt(Date.now() / 1000, 10);
  var month = new Date().getMonth() + 1;
  // 11 月 ~ 次年 2 月默认制热，其余默认制冷
  var seasonMode = (month >= 11 || month <= 2) ? "hot" : "cold";

  var expiration = parseInt(storage.getItem("expirationTime") || "0", 10);
  if (expiration > now && storage.getItem("mode")) {
    // 有效期内，沿用上次设置
  } else {
    storage.setItem("mode", seasonMode);
    storage.setItem("temperature", seasonMode === "cold" ? "22" : "28");
  }
  storage.setItem("expirationTime", String(now + EXPIRE_DAYS * 86400));

  var state = {
    power: false,
    mode: storage.getItem("mode") || seasonMode,
    temperature: parseInt(storage.getItem("temperature") || (seasonMode === "cold" ? "22" : "28"), 10)
  };

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var elTemp = $("tempNumber"),
      elMode = $("modeText"),
      elLed  = $("statusLed"),
      elWind = $("wind"),
      elPanel = document.querySelector(".ac .temperature"),
      btnOpen = $("open");

  /* ---------- 原版音效（来自原站 res.wx.qq.com） ----------
   * button.mp3    按键"哔"声
   * power.mp3     开机音（约 9 秒：哔声 + 风声渐强）
   * operation.mp3 空调运行风声（循环） */
  var SOUND_BUTTON = "./button.mp3",
      SOUND_POWER = "./power.mp3",
      SOUND_OPERATION = "./operation.mp3";

  function play(audio) {
    try {
      audio.currentTime = 0;
      var p = audio.play();
      if (p && p.catch) p.catch(function () { /* 浏览器拦截时静默 */ });
    } catch (e) { /* 无声也能玩 */ }
  }

  var audioButton = new Audio(SOUND_BUTTON);
  audioButton.preload = "auto";
  var soundButton = function () { play(audioButton); };

  /* ---------- 风声引擎（WebAudio，复刻原版时序） ----------
   * 原版逻辑（解包自原站 JS）：
   *   开机：powerSound 从头播放，7.5 秒后 operationSound 从头接入
   *        （两音频尾部/头部都是风声噪声，重叠 1.7 秒听感连续，无需淡化）
   *   循环：风声每次播到约 59 秒处跳回 0.5 秒处循环（跳过开头的起音）
   *   关机：原版直接掐断，这里优化为 0.6s 淡出
   * 加载失败自动降级为普通 <audio> 播放。 */
  var windOn, windOff;
  (function () {
    var ac = null, bufPower = null, bufOp = null, loadFailed = false;
    var powerSrc = null, powerGain = null, opSrc = null, opGain = null;
    var WIND_DELAY = 7.5,      // 风声在开机音第 7.5 秒时接入（原版定值）
        LOOP_START = 0.5,      // 循环起点（原版定值，跳过开头起音）
        LOOP_END = 59.0,       // 循环终点（原版：起点 + 58.5s 周期）
        OFF_FADE = 0.6;

    /* 降级方案：普通 <audio> + 定时器复刻原版时序（fetch/decode 不可用时） */
    var elPower = new Audio(SOUND_POWER), elOp = new Audio(SOUND_OPERATION);
    var tPower = null, tLoop = null;
    function fallbackOn() {
      fallbackOff();
      play(elPower);
      /* 预载风声：先播再暂停，消除 7.5 秒后接入时的加载空隙（原版同款技巧） */
      try {
        elOp.currentTime = 0;
        var p = elOp.play();
        if (p && p.catch) p.catch(function () {});
        elOp.pause();
      } catch (e) {}
      tPower = setTimeout(function () {
        play(elOp);
        tLoop = setInterval(function () {
          try { elOp.currentTime = 0.5; elOp.play(); } catch (e) {}
        }, 58500);
      }, 7500);
    }
    function fallbackOff() {
      if (tPower) { clearTimeout(tPower); tPower = null; }
      if (tLoop) { clearInterval(tLoop); tLoop = null; }
      [elPower, elOp].forEach(function (a) { try { a.pause(); a.currentTime = 0; } catch (e) {} });
    }

    function ctx() {
      if (!ac) {
        var AC = window.AudioContext || window.webkitAudioContext;
        ac = new AC();
      }
      if (ac.state === "suspended") ac.resume();
      return ac;
    }
    function decode(url) {
      return fetch(url)
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) { return ctx().decodeAudioData(ab); });
    }
    /* 页面加载即预解码，保证按键零延迟（AudioContext 挂起状态也可解码） */
    var ready = Promise.all([decode(SOUND_POWER), decode(SOUND_OPERATION)])
      .then(function (b) { bufPower = b[0]; bufOp = b[1]; })
      .catch(function () { loadFailed = true; });

    function killNodes(fade) {
      if (!ac || (!powerSrc && !opSrc)) return;
      var t = ac.currentTime;
      [powerGain, opGain].forEach(function (g) {
        if (!g) return;
        try {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.linearRampToValueAtTime(0.0001, t + fade);
        } catch (e) {}
      });
      var ps = powerSrc, os = opSrc;
      powerSrc = powerGain = opSrc = opGain = null;
      [ps, os].forEach(function (s) {
        if (!s) return;
        try { s.stop(t + fade + 0.1); } catch (e) {}
      });
    }

    windOn = function () {
      ready.then(function () {
        if (loadFailed || !bufPower || !bufOp) return fallbackOn();
        if (!state.power) return; // 等待解码期间已被关机
        try {
          var c = ctx();
          killNodes(0);
          var t = c.currentTime + 0.03;

          /* 开机音：从头完整播放，尾部 1.7 秒与风声自然重叠 */
          powerSrc = c.createBufferSource();
          powerSrc.buffer = bufPower;
          powerGain = c.createGain();
          powerGain.gain.value = 1;
          powerSrc.connect(powerGain);
          powerGain.connect(c.destination);

          /* 循环风声：7.5 秒时从头接入，此后在 [0.5s, 59s] 区间循环 */
          opSrc = c.createBufferSource();
          opSrc.buffer = bufOp;
          opSrc.loop = true;
          opSrc.loopStart = LOOP_START;
          opSrc.loopEnd = LOOP_END;
          opGain = c.createGain();
          opSrc.connect(opGain);
          opGain.connect(c.destination);

          /* 50ms 淡入仅用于防爆音，不改变原版的重叠衔接设计 */
          var opStart = t + WIND_DELAY;
          opGain.gain.setValueAtTime(0.0001, opStart);
          opGain.gain.linearRampToValueAtTime(1, opStart + 0.05);

          powerSrc.start(t);
          opSrc.start(opStart, 0);
        } catch (e) { fallbackOn(); }
      });
    };

    windOff = function () {
      killNodes(OFF_FADE);
      fallbackOff();
    };
  })();

  var soundPowerOn = function () { windOn(); };
  // 关机：风声缓缓淡出，留一声短"哔"确认
  var soundPowerOff = function () { windOff(); play(audioButton); };

  /* ---------- 渲染 ---------- */
  function render() {
    if (state.power) {
      elPanel.style.display = "block";
      elLed.classList.add("on");
      elWind.style.opacity = "1";
      elWind.classList.add("blow");
      btnOpen.classList.add("open");
      elMode.textContent = state.mode === "cold" ? "❄ 制冷" : "☀ 制热";
      elTemp.textContent = state.temperature;
    } else {
      elPanel.style.display = "none";
      elLed.classList.remove("on");
      elWind.style.opacity = "0";
      elWind.classList.remove("blow");
      btnOpen.classList.remove("open");
    }
  }

  function save() {
    storage.setItem("mode", state.mode);
    storage.setItem("temperature", String(state.temperature));
  }

  /* ---------- 交互 ---------- */
  $("open").addEventListener("click", function () {
    state.power = !state.power;
    state.power ? soundPowerOn() : soundPowerOff();
    render();
  });

  $("cold").addEventListener("click", function () {
    if (!state.power) return;
    if (state.mode !== "cold") { state.mode = "cold"; save(); soundButton(); render(); }
  });

  $("hot").addEventListener("click", function () {
    if (!state.power) return;
    if (state.mode !== "hot") { state.mode = "hot"; save(); soundButton(); render(); }
  });

  $("plus").addEventListener("click", function () {
    if (!state.power) return;
    if (state.temperature < TEMP_MAX) {
      state.temperature++;
      save(); soundButton(); render();
    }
  });

  $("minus").addEventListener("click", function () {
    if (!state.power) return;
    if (state.temperature > TEMP_MIN) {
      state.temperature--;
      save(); soundButton(); render();
    }
  });

  /* ---------- 启动 ---------- */
  render();
})();
