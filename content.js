// Oracle Academy Auto-Progressor
// Autonomous section progression & quiz skipping engine

(() => {
  if (window.__OA_AUTOPROGRESSOR_LOADED__) return;
  window.__OA_AUTOPROGRESSOR_LOADED__ = true;

  const STORAGE_KEY = "oa_progressor_config";
  const DEFAULT_CONFIG = {
    active: false,
    delayMs: 800,        // Stable, human-like execution delay (800ms)
    skipQuizzes: true,
    autoLoopSections: true,
    clearedSections: [], // Section names completed in this run
    outlineUrl: ""
  };

  let config = { ...DEFAULT_CONFIG };
  let retryTimer = null;
  let actionTaken = false;

  // --- Dispatch message to MAIN world bridge.js (zero CSP violations) ---
  function bridgeClickSave() {
    window.postMessage({ type: "OA_BRIDGE_CLICK_SAVE" }, "*");
  }

  function bridgeSuppressWarnings() {
    window.postMessage({ type: "OA_BRIDGE_SUPPRESS_WARNINGS" }, "*");
  }

  // --- Helper: Check if text represents an assessment / quiz ---
  function isAssessmentText(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    return /\b(quiz|exam|test|assessment|midterm|final|cumulative)\b/i.test(lower);
  }

  // --- Helper: Detect current page type ---
  function getPageType() {
    const url = window.location.href;
    if (url.includes(":14:") || document.getElementById("courseol_heading")) {
      return "OUTLINE"; // Course Outline
    }
    if (url.includes(":15:") || document.getElementById("nextModButton") || document.querySelector(".t-WizardSteps")) {
      return "LESSON";  // Inside Course Lesson
    }
    return "UNKNOWN";
  }

  // --- Load Config & Initialize ---
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    if (res[STORAGE_KEY]) {
      config = { ...DEFAULT_CONFIG, ...res[STORAGE_KEY] };
    }

    if (getPageType() === "OUTLINE" && !window.location.href.includes("SAVE")) {
      config.outlineUrl = window.location.href;
      chrome.storage.local.set({ [STORAGE_KEY]: config });
    }

    injectHUD();
    updateHUD();

    if (config.active) {
      bridgeSuppressWarnings();
      scheduleRun();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      config = { ...config, ...changes[STORAGE_KEY].newValue };
      updateHUD();
      if (config.active && !actionTaken) {
        scheduleRun();
      } else if (!config.active) {
        if (retryTimer) clearInterval(retryTimer);
      }
    }
  });

  function saveConfig(updates) {
    config = { ...config, ...updates };
    chrome.storage.local.set({ [STORAGE_KEY]: config });
    updateHUD();
  }

  function scheduleRun() {
    if (!config.active || actionTaken) return;
    setTimeout(() => {
      if (!config.active || actionTaken) return;
      executeProgressor();
    }, config.delayMs);
  }

  function executeProgressor() {
    const pageType = getPageType();

    if (pageType === "LESSON") {
      handleLessonStep();
    } else if (pageType === "OUTLINE") {
      handleOutlineStep();
    } else {
      setHUDLog("Navigate to Course Outline or Lesson to start.");
    }
  }

  // =========================================================================
  // PAGE 15: INSIDE COURSE LESSON
  // =========================================================================
  function handleLessonStep() {
    bridgeSuppressWarnings();

    const sectionName = document.getElementById("P15_PARENT_MODULE_NAME")?.value ||
                        document.querySelector(".t-BreadcrumbRegion-breadcrumb h2")?.innerText ||
                        "Current Section";

    const p15Title = document.getElementById("P15_TITLE")?.value || "";
    const activeStepNode = document.querySelector("li.t-WizardSteps-step.is-active-module") ||
                           document.querySelector("li.t-WizardSteps-step.is-active");
    const activeStepText = activeStepNode ? activeStepNode.innerText.replace(/[\n\r]+/g, " ").trim() : "";
    const currentTitle = p15Title || activeStepText || "Lesson Module";

    setHUDCurrentItem(currentTitle);

    // 1. STRICT QUIZ DETECTION
    const p15AssessmentId = document.getElementById("P15_ASSESSMENT_ID")?.value;
    const isCurrentQuiz = isAssessmentText(currentTitle) ||
                          isAssessmentText(activeStepText) ||
                          (p15AssessmentId && p15AssessmentId.trim().length > 0);

    if (isCurrentQuiz) {
      setHUDBadge("QUIZ SKIPPED", "quiz");
      setHUDLog(`Skipping Quiz: "${currentTitle}". Section finished!`);
      markSectionCleared(sectionName);

      if (config.autoLoopSections) {
        actionTaken = true;
        setTimeout(navigateToCourseOutline, config.delayMs + 300);
      } else {
        saveConfig({ active: false });
        setHUDLog("Paused before quiz. Enable Auto-Loop to continue.");
      }
      return;
    }

    // 2. WAIT FOR & CLICK "SAVE AND CONTINUE"
    let attempts = 0;
    if (retryTimer) clearInterval(retryTimer);

    function doClick() {
      if (!config.active) {
        clearInterval(retryTimer);
        return;
      }

      const nextBtn = document.getElementById("nextModButton");

      if (nextBtn && !nextBtn.disabled && !nextBtn.classList.contains("is-disabled")) {
        attempts++;
        setHUDLog(`Saving module: "${currentTitle}"...`);

        // A. Direct DOM click in isolated world
        try {
          nextBtn.click();
        } catch (e) {}

        // B. Full mouse event dispatch
        try {
          const opts = { bubbles: true, cancelable: true, view: window };
          nextBtn.dispatchEvent(new MouseEvent("mousedown", opts));
          nextBtn.dispatchEvent(new MouseEvent("mouseup", opts));
          nextBtn.dispatchEvent(new MouseEvent("click", opts));
        } catch (e) {}

        // C. Clean Main-World execution via bridge.js (zero CSP violation)
        bridgeClickSave();

        // If after 8 retries (8 seconds) page has not navigated, section might be at end
        if (attempts >= 8) {
          clearInterval(retryTimer);
          setHUDLog("Section finished. Returning to course outline...");
          markSectionCleared(sectionName);
          setTimeout(navigateToCourseOutline, 500);
        }
      } else {
        // Button not present or disabled -> section finished
        clearInterval(retryTimer);
        setHUDLog("No save button. Section finished. Returning to outline...");
        markSectionCleared(sectionName);
        setTimeout(navigateToCourseOutline, 500);
      }
    }

    // Initial click after stable delay
    setTimeout(() => {
      doClick();
      // Retry every 1000ms if page doesn't transition immediately
      retryTimer = setInterval(doClick, 1000);
    }, config.delayMs);
  }

  // =========================================================================
  // PAGE 14: COURSE OUTLINE
  // =========================================================================
  function handleOutlineStep() {
    if (retryTimer) clearInterval(retryTimer);
    setHUDCurrentItem("Course Outline");

    if (!config.outlineUrl || config.outlineUrl.includes(":15:")) {
      config.outlineUrl = window.location.href;
      saveConfig({ outlineUrl: window.location.href });
    }

    const outlineHeader = document.getElementById("courseol_heading");
    const container = outlineHeader ? outlineHeader.closest(".t-ContentBlock") : document;
    const mediaItems = Array.from((container || document).querySelectorAll(".t-MediaList-item"));

    if (!mediaItems.length) {
      setHUDLog("Waiting for outline items to render...");
      setTimeout(handleOutlineStep, 400);
      return;
    }

    const cleared = config.clearedSections || [];
    const candidateSections = [];

    for (const item of mediaItems) {
      const titleElem = item.querySelector(".t-MediaList-title");
      const title = titleElem ? titleElem.innerText.replace(/[\n\r]+/g, " ").trim() : "";
      const linkElem = item.querySelector("a.t-MediaList-itemWrap") || item.querySelector("a");
      const badgeElem = item.querySelector(".t-MediaList-badge");
      const badge = badgeElem ? badgeElem.innerText.trim() : "";
      const href = linkElem ? (linkElem.getAttribute("href") || "") : "";

      if (!linkElem || !href) continue;

      // RULE 1: Must link to Lesson page (:15:)
      if (!href.includes(":15:")) continue;

      // RULE 2: Must be a section (Section 0, Section 1, etc.)
      if (!/^section\s+\d+/i.test(title)) continue;

      // RULE 3: Exclude assessments / exams / quizzes
      if (isAssessmentText(title)) continue;

      // RULE 4: Ignore 100% completed sections
      if (badge.includes("100%")) continue;

      // RULE 5: Skip if cleared in this run
      const isAlreadyCleared = cleared.some(cName => {
        return title.toLowerCase().includes(cName.toLowerCase()) ||
               cName.toLowerCase().includes(title.toLowerCase());
      });
      if (isAlreadyCleared) continue;

      const secMatch = title.match(/section\s+(\d+)/i);
      const secNum = secMatch ? parseInt(secMatch[1], 10) : 999;

      candidateSections.push({
        secNum,
        title,
        link: linkElem,
        href,
        badge
      });
    }

    // Sort sequentially by section number
    candidateSections.sort((a, b) => a.secNum - b.secNum);

    if (candidateSections.length === 0) {
      setHUDLog("All course sections completed! 🎉 (Quizzes skipped safely)");
      setHUDBadge("FINISHED", "stopped");
      saveConfig({ active: false });
      return;
    }

    // Pick earliest incomplete section
    const target = candidateSections[0];
    setHUDLog(`Entering ${target.title} (${target.badge || "0%"})...`);
    actionTaken = true;

    setTimeout(() => {
      // Trigger navigation
      target.link.click();
      setTimeout(() => {
        if (window.location.href.includes(":14:") && target.link.href) {
          window.location.href = target.link.href;
        }
      }, 500);
    }, config.delayMs);
  }

  // --- Mark Section as Cleared in Run Cache ---
  function markSectionCleared(name) {
    if (!name) return;
    const cleared = config.clearedSections || [];
    if (!cleared.some(c => c.toLowerCase() === name.toLowerCase())) {
      cleared.push(name);
      saveConfig({ clearedSections: cleared });
    }
  }

  // --- Return to Course Outline ---
  function navigateToCourseOutline() {
    if (retryTimer) clearInterval(retryTimer);
    bridgeSuppressWarnings();

    // 1. Try "Course" button on Page 15
    const courseBtn = document.querySelector(
      "button#B91059063829211655, button[id^='B91059'], button.t-Button:has(.fa-home)"
    );
    if (courseBtn) {
      courseBtn.click();
      return;
    }

    // 2. Try breadcrumb link for 'Taking a Class'
    const outlineBreadcrumb = Array.from(document.querySelectorAll("a.t-Breadcrumb-label, a"))
      .find(a => (a.innerText || "").includes("Taking a Class") || (a.href && a.href.includes(":14:")));
    if (outlineBreadcrumb && outlineBreadcrumb.href) {
      window.location.href = outlineBreadcrumb.href;
      return;
    }

    // 3. Use saved outline URL if valid
    if (config.outlineUrl && config.outlineUrl.includes(":14:")) {
      window.location.href = config.outlineUrl;
      return;
    }

    // 4. Construct APEX URL back to Page 14 preserving session
    const match = window.location.href.match(/f\?p=(\d+):15:([^:]+):/);
    if (match) {
      const appId = match[1];
      const session = match[2];
      const classCourseId = document.getElementById("P15_CLASS_COURSE_ID")?.value || "";
      window.location.href = `f?p=${appId}:14:${session}:::RP:P14_ID:${classCourseId}`;
      return;
    }

    window.history.back();
  }

  // =========================================================================
  // ON-SCREEN HEADS-UP DISPLAY (HUD)
  // =========================================================================
  function injectHUD() {
    if (document.getElementById("oa-auto-hud")) return;

    const hud = document.createElement("div");
    hud.id = "oa-auto-hud";
    hud.innerHTML = `
      <div class="oa-hud-header">
        <div class="oa-hud-title">
          <div id="oa-pulse" class="oa-hud-pulse"></div>
          <span>OA Auto-Progressor</span>
        </div>
        <div id="oa-status-badge" class="oa-hud-status-badge stopped">OFF</div>
      </div>
      <div class="oa-hud-body">
        <div class="oa-hud-row">
          <span>Target Item:</span>
          <span id="oa-current-item" class="val">Detecting...</span>
        </div>
        <div class="oa-hud-row">
          <span>Skip Quizzes:</span>
          <span class="val" style="color: #34d399;">Active (Strict)</span>
        </div>
        <div class="oa-hud-row">
          <span>Sections Cleared:</span>
          <span id="oa-sections-done" class="val" style="color: #60a5fa;">0</span>
        </div>
        <div class="oa-hud-controls">
          <button id="oa-toggle-btn" class="oa-hud-btn primary">Start</button>
          <button id="oa-outline-btn" class="oa-hud-btn secondary">Outline</button>
          <button id="oa-reset-btn" class="oa-hud-btn secondary" title="Reset cleared sections cache">Reset</button>
        </div>
        <div id="oa-hud-log" class="oa-hud-log">Ready. Click Start to begin.</div>
      </div>
    `;

    document.body.appendChild(hud);

    document.getElementById("oa-toggle-btn").addEventListener("click", () => {
      const nextActive = !config.active;
      actionTaken = false;
      if (retryTimer) clearInterval(retryTimer);
      saveConfig({ active: nextActive });
      if (nextActive) {
        scheduleRun();
      }
    });

    document.getElementById("oa-outline-btn").addEventListener("click", () => {
      navigateToCourseOutline();
    });

    document.getElementById("oa-reset-btn").addEventListener("click", () => {
      actionTaken = false;
      if (retryTimer) clearInterval(retryTimer);
      saveConfig({ clearedSections: [] });
      setHUDLog("Cache cleared! Ready to re-run all sections.");
    });
  }

  function updateHUD() {
    const badge = document.getElementById("oa-status-badge");
    const toggleBtn = document.getElementById("oa-toggle-btn");
    const pulse = document.getElementById("oa-pulse");
    const sectionsDone = document.getElementById("oa-sections-done");

    if (!badge || !toggleBtn || !pulse) return;

    if (sectionsDone) {
      sectionsDone.textContent = `${(config.clearedSections || []).length} cleared`;
    }

    if (config.active) {
      badge.textContent = "RUNNING";
      badge.className = "oa-hud-status-badge running";
      pulse.className = "oa-hud-pulse running";
      toggleBtn.textContent = "Pause";
      toggleBtn.className = "oa-hud-btn danger";
    } else {
      badge.textContent = "PAUSED";
      badge.className = "oa-hud-status-badge stopped";
      pulse.className = "oa-hud-pulse";
      toggleBtn.textContent = "Start";
      toggleBtn.className = "oa-hud-btn primary";
    }
  }

  function setHUDBadge(text, typeClass) {
    const badge = document.getElementById("oa-status-badge");
    if (badge) {
      badge.textContent = text;
      badge.className = `oa-hud-status-badge ${typeClass}`;
    }
  }

  function setHUDCurrentItem(name) {
    const elem = document.getElementById("oa-current-item");
    if (elem) {
      elem.textContent = name || "None";
      elem.title = name || "";
    }
  }

  function setHUDLog(msg) {
    const logElem = document.getElementById("oa-hud-log");
    if (logElem) {
      logElem.textContent = msg;
    }
  }
})();
