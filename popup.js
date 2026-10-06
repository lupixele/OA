const STORAGE_KEY = "oa_progressor_config";

const DEFAULT_CONFIG = {
  active: false,
  delayMs: 800,
  skipQuizzes: true,
  autoLoopSections: true
};

document.addEventListener("DOMContentLoaded", () => {
  const statusBadge = document.getElementById("statusBadge");
  const mainToggleBtn = document.getElementById("mainToggleBtn");
  const autoLoopToggle = document.getElementById("autoLoopToggle");
  const openOutlineBtn = document.getElementById("openOutlineBtn");
  const speedButtons = document.querySelectorAll(".speed-btn");

  let currentConfig = { ...DEFAULT_CONFIG };

  // Load configuration
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    if (res[STORAGE_KEY]) {
      currentConfig = { ...DEFAULT_CONFIG, ...res[STORAGE_KEY] };
    }
    renderUI();
  });

  function renderUI() {
    // 1. Status badge & Main button
    if (currentConfig.active) {
      statusBadge.textContent = "RUNNING";
      statusBadge.className = "status-badge running";
      mainToggleBtn.textContent = "Pause Auto-Runner";
      mainToggleBtn.className = "btn btn-danger";
    } else {
      statusBadge.textContent = "PAUSED";
      statusBadge.className = "status-badge stopped";
      mainToggleBtn.textContent = "Start Auto-Runner";
      mainToggleBtn.className = "btn btn-primary";
    }

    // 2. Auto-loop switch
    autoLoopToggle.checked = !!currentConfig.autoLoopSections;

    // 3. Speed selector
    speedButtons.forEach((btn) => {
      const speed = parseInt(btn.dataset.speed, 10);
      if (speed === currentConfig.delayMs) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }

  function saveConfig() {
    chrome.storage.local.set({ [STORAGE_KEY]: currentConfig }, () => {
      renderUI();
    });
  }

  // Toggle Runner
  mainToggleBtn.addEventListener("click", () => {
    currentConfig.active = !currentConfig.active;
    saveConfig();
  });

  // Toggle Auto-loop
  autoLoopToggle.addEventListener("change", (e) => {
    currentConfig.autoLoopSections = e.target.checked;
    saveConfig();
  });

  // Speed Buttons
  speedButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      currentConfig.delayMs = parseInt(btn.dataset.speed, 10);
      saveConfig();
    });
  });

  // Reset Cache
  const resetCacheBtn = document.getElementById("resetCacheBtn");
  if (resetCacheBtn) {
    resetCacheBtn.addEventListener("click", () => {
      currentConfig.clearedSections = [];
      saveConfig();
      resetCacheBtn.textContent = "Cache Cleared!";
      setTimeout(() => { resetCacheBtn.textContent = "Reset Progress Cache"; }, 1500);
    });
  }

  // Open Outline Tab / Navigate
  openOutlineBtn.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => {
            const courseBtn = document.querySelector("button[id^='B91059'], button#B91059063829211655");
            if (courseBtn) {
              courseBtn.click();
              return;
            }
            const outlineLink = Array.from(document.querySelectorAll("a.t-Breadcrumb-label, a"))
              .find(a => (a.innerText || "").includes("Taking a Class") || a.href.includes(":14:"));
            if (outlineLink) {
              outlineLink.click();
              return;
            }
            window.history.back();
          }
        });
      }
    });
  });
});
