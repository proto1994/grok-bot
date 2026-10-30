(function () {
  var ZH_TITLE = "Bots — 有自己电脑的 AI 队友";
  var EN_TITLE = "Bots — AI teammates with a computer of their own";

  var root = document.documentElement;
  var header = document.querySelector(".header");
  var menuBtn = document.querySelector(".menu-btn");
  var nav = document.querySelector("#site-nav");
  var themeBtn = document.querySelector(".theme-btn");
  var themeMeta = document.getElementById("theme-color");
  var frame = document.querySelector(".frame");
  var shots = Array.prototype.slice.call(document.querySelectorAll(".shot"));

  document.querySelectorAll("[data-alt-en]").forEach(function (img) {
    img.dataset.altZh = img.getAttribute("alt") || "";
  });

  function lang() {
    return root.getAttribute("data-lang") === "en" ? "en" : "zh";
  }

  function applyLang(next) {
    if (next === "en") {
      root.setAttribute("data-lang", "en");
      root.lang = "en";
      document.title = EN_TITLE;
    } else {
      root.removeAttribute("data-lang");
      root.lang = "zh-CN";
      document.title = ZH_TITLE;
    }
    try {
      localStorage.setItem("bots-lang", next === "en" ? "en" : "zh");
    } catch (e) {}
    document.querySelectorAll("[data-alt-en]").forEach(function (img) {
      img.alt = next === "en" ? img.dataset.altEn : img.dataset.altZh;
    });
    document.querySelectorAll("[data-set-lang]").forEach(function (btn) {
      btn.setAttribute("aria-pressed", String(btn.dataset.setLang === (next === "en" ? "en" : "zh")));
    });
    var navEl = document.querySelector("#site-nav");
    if (navEl) navEl.setAttribute("aria-label", next === "en" ? "Sections" : "页面");
  }

  document.querySelectorAll("[data-set-lang]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      applyLang(btn.dataset.setLang);
    });
  });
  applyLang(lang());

  function resolvedTheme() {
    var explicit = root.getAttribute("data-theme");
    if (explicit === "light" || explicit === "dark") return explicit;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function paintThemeColor() {
    if (themeMeta) themeMeta.setAttribute("content", resolvedTheme() === "dark" ? "#121214" : "#f4f4f5");
  }

  function setTheme(theme) {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("bots-theme", theme);
    } catch (e) {}
    paintThemeColor();
  }

  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      setTheme(resolvedTheme() === "dark" ? "light" : "dark");
    });
  }
  paintThemeColor();

  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  if (mq.addEventListener) {
    mq.addEventListener("change", function () {
      var stored = null;
      try {
        stored = localStorage.getItem("bots-theme");
      } catch (e) {}
      if (!stored) paintThemeColor();
    });
  }

  function onScroll() {
    if (header) header.classList.toggle("is-stuck", window.scrollY > 4);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  function closeMenu() {
    if (!nav || !menuBtn) return;
    nav.classList.remove("is-open");
    menuBtn.setAttribute("aria-expanded", "false");
  }

  if (menuBtn && nav) {
    menuBtn.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      menuBtn.setAttribute("aria-expanded", String(open));
    });
    nav.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", closeMenu);
    });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeMenu();
  });
  document.addEventListener("click", function (e) {
    if (!nav || !nav.classList.contains("is-open")) return;
    if (nav.contains(e.target) || (menuBtn && menuBtn.contains(e.target))) return;
    closeMenu();
  });

  function activate(id, focus) {
    shots.forEach(function (btn) {
      var on = btn.dataset.shot === id;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      if (on && focus) btn.focus();
    });
    document.querySelectorAll("[data-frame]").forEach(function (img) {
      img.classList.toggle("is-on", img.dataset.frame === id);
    });
    document.querySelectorAll("[data-cap]").forEach(function (cap) {
      cap.classList.toggle("is-on", cap.dataset.cap === id);
    });
    if (frame) frame.classList.toggle("is-phone", id === "10");
    var current = shots.find(function (s) { return s.dataset.shot === id; });
    if (current && current.scrollIntoView) {
      current.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  shots.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activate(btn.dataset.shot, false);
    });
  });

  var tour = document.querySelector(".tour-layout");
  if (tour) {
    tour.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      var ids = shots.map(function (s) { return s.dataset.shot; });
      var cur = shots.findIndex(function (s) { return s.getAttribute("aria-pressed") === "true"; });
      if (cur < 0) cur = 0;
      var dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
      e.preventDefault();
      activate(ids[(cur + dir + ids.length) % ids.length], true);
    });
  }

  var hash = (location.hash || "").replace("#", "");
  if (/^shot-\d\d$/.test(hash)) activate(hash.slice(5), false);

  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var block = btn.closest(".code");
      if (!block) return;
      var pre = Array.prototype.slice.call(block.querySelectorAll("pre")).find(function (el) {
        return window.getComputedStyle(el).display !== "none";
      });
      if (!pre) return;
      var text = pre.innerText.replace(/\n$/, "");
      var done = function () {
        btn.classList.add("is-copied");
        window.setTimeout(function () { btn.classList.remove("is-copied"); }, 1600);
      };
      var fallback = function () {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "0";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        ta.remove();
        if (!ok) throw new Error("copy failed");
      };
      var write = (navigator.clipboard && navigator.clipboard.writeText)
        ? navigator.clipboard.writeText(text).catch(fallback)
        : Promise.resolve().then(fallback);
      write.then(done).catch(function () {});
    });
  });
})();
