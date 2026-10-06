const STORAGE_KEY = "oa_progressor_config";
const QUIZ_STORAGE_KEY = "oa_quiz_data";

const DEFAULT_CONFIG = {
  active: false,
  delayMs: 800,
  skipQuizzes: true,
  autoLoopSections: true,
  clearedSections: []
};

document.addEventListener("DOMContentLoaded", () => {
  const statusBadge = document.getElementById("statusBadge");
  const mainToggleBtn = document.getElementById("mainToggleBtn");
  const autoLoopToggle = document.getElementById("autoLoopToggle");
  const openOutlineBtn = document.getElementById("openOutlineBtn");
  const resetCacheBtn = document.getElementById("resetCacheBtn");
  const speedButtons = document.querySelectorAll(".speed-btn");
  const quizStatusDesc = document.getElementById("quizStatusDesc");
  const harvestQuizBtn = document.getElementById("harvestQuizBtn");
  const openSolverModalBtn = document.getElementById("openSolverModalBtn");

  let currentConfig = { ...DEFAULT_CONFIG };
  let currentQuiz = {};

  // Load config & quiz state
  chrome.storage.local.get([STORAGE_KEY, QUIZ_STORAGE_KEY], (res) => {
    if (res[STORAGE_KEY]) currentConfig = { ...DEFAULT_CONFIG, ...res[STORAGE_KEY] };
    if (res[QUIZ_STORAGE_KEY]) currentQuiz = res[QUIZ_STORAGE_KEY];
    renderUI();
  });

  function renderUI() {
    // 1. Status badge & Main button
    if (currentConfig.active) {
      statusBadge.textContent = "RUNNING";
      statusBadge.className = "status-badge running";
      mainToggleBtn.textContent = "Pause Course Auto-Runner";
      mainToggleBtn.className = "btn btn-danger";
    } else {
      statusBadge.textContent = "PAUSED";
      statusBadge.className = "status-badge stopped";
      mainToggleBtn.textContent = "Start Course Auto-Runner";
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

    // 4. Quiz Status
    if (quizStatusDesc && currentQuiz.state) {
      const qCount = Object.keys(currentQuiz.harvested || {}).length;
      quizStatusDesc.textContent = `State: ${currentQuiz.state} (${qCount} Qs harvested)`;
    }
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
  if (resetCacheBtn) {
    resetCacheBtn.addEventListener("click", () => {
      currentConfig.clearedSections = [];
      saveConfig();
      resetCacheBtn.textContent = "Cache Cleared!";
      setTimeout(() => { resetCacheBtn.textContent = "Reset Course Cache"; }, 1500);
    });
  }

  // Quiz Harvester Button
  if (harvestQuizBtn) {
    harvestQuizBtn.addEventListener("click", () => {
      chrome.storage.local.set({
        [QUIZ_STORAGE_KEY]: {
          state: "HARVESTING",
          harvested: {},
          answers: {},
          batchPrompt: ""
        }
      }, () => {
        window.close();
      });
    });
  }

  // Quiz Solver Modal Button
  if (openSolverModalBtn) {
    openSolverModalBtn.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: () => {
              const modalBtn = document.getElementById("oa-quiz-modal-btn");
              if (modalBtn) modalBtn.click();
            }
          });
          window.close();
        }
      });
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
