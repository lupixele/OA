// Oracle Academy Course Progressor & Quiz AI Solver
// P:\Magnanimity\Projects\OA\extension

(() => {
  if (window.__OA_AUTOPROGRESSOR_LOADED__) return;
  window.__OA_AUTOPROGRESSOR_LOADED__ = true;

  const STORAGE_KEY = "oa_progressor_config";
  const QUIZ_STORAGE_KEY = "oa_quiz_data";

  const DEFAULT_CONFIG = {
    active: false,
    delayMs: 600,
    skipQuizzes: true,
    autoLoopSections: true,
    clearedSections: [],
    outlineUrl: ""
  };

  const DEFAULT_QUIZ = {
    state: "IDLE", // IDLE | HARVESTING | REWINDING | AWAITING_ANSWERS | SOLVING
    totalQuestions: 0,
    harvested: {}, // { [qNum]: { q_num, total_q, text, options: [{ label, text, index }] } }
    answers: {},   // { [qNum]: "C" }
    batchPrompt: ""
  };

  let config = { ...DEFAULT_CONFIG };
  let quizData = { ...DEFAULT_QUIZ };
  let isExecuting = false;

  // --- Bridge Communication Helpers ---
  function bridgeMsg(type, payload = {}) {
    window.postMessage({ type, ...payload }, "*");
  }

  // --- Assessment / Quiz Keyword Matcher ---
  function isAssessmentText(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    return /\b(quiz|exam|test|assessment|midterm|final|cumulative)\b/i.test(lower);
  }

  // --- Page Classifier ---
  function getPageType() {
    const url = window.location.href;
    // Page 190 or #quiz-submit or #collapse-Choices-reg or P190 items
    if (url.includes(":190:") || document.getElementById("quiz-submit") || document.getElementById("collapse-Choices-reg")) {
      return "QUIZ";
    }
    // Page 14 is Course Outline
    if (url.includes(":14:") || document.getElementById("courseol_heading")) {
      return "OUTLINE";
    }
    // Page 15 is Inside Lesson
    if (url.includes(":15:") || document.getElementById("nextModButton") || document.querySelector(".t-WizardSteps")) {
      return "LESSON";
    }
    return "UNKNOWN";
  }

  // --- Sync Storage & Boot ---
  chrome.storage.local.get([STORAGE_KEY, QUIZ_STORAGE_KEY], (res) => {
    if (res[STORAGE_KEY]) config = { ...DEFAULT_CONFIG, ...res[STORAGE_KEY] };
    if (res[QUIZ_STORAGE_KEY]) quizData = { ...DEFAULT_QUIZ, ...res[QUIZ_STORAGE_KEY] };

    if (getPageType() === "OUTLINE" && !window.location.href.includes("SAVE")) {
      config.outlineUrl = window.location.href;
      chrome.storage.local.set({ [STORAGE_KEY]: config });
    }

    injectHUD();
    updateHUD();

    const pageType = getPageType();
    if (pageType === "QUIZ") {
      handleQuizLifecycle();
    } else if (config.active) {
      bridgeMsg("OA_BRIDGE_SUPPRESS_WARNINGS");
      scheduleCourseRun();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) {
      config = { ...config, ...changes[STORAGE_KEY].newValue };
      updateHUD();
      if (config.active && !isExecuting && getPageType() !== "QUIZ") {
        scheduleCourseRun();
      }
    }
    if (changes[QUIZ_STORAGE_KEY]) {
      quizData = { ...quizData, ...changes[QUIZ_STORAGE_KEY].newValue };
      updateHUD();
    }
  });

  function saveConfig(updates) {
    config = { ...config, ...updates };
    chrome.storage.local.set({ [STORAGE_KEY]: config });
    updateHUD();
  }

  function saveQuizData(updates) {
    quizData = { ...quizData, ...updates };
    chrome.storage.local.set({ [QUIZ_STORAGE_KEY]: quizData });
    updateHUD();
  }

  // =========================================================================
  // QUIZ ENGINE: HARVESTING, REWINDING, AND AI SOLVING
  // =========================================================================

  function parseCurrentQuestionDOM() {
    // 1. Question Number & Total Count
    const seqInput = document.getElementById("P190_QUESTION_SEQUENCE");
    const countInput = document.getElementById("P190_QUESTION_COUNT");

    let qNum = seqInput && seqInput.value ? parseInt(seqInput.value, 10) : null;
    let totalQ = countInput && countInput.value ? parseInt(countInput.value, 10) : null;

    if (!qNum || !totalQ) {
      const heading = document.getElementById("question-Text_heading")?.innerText || "";
      const match = heading.match(/Question\s+(\d+)\s+of\s+(\d+)/i);
      if (match) {
        qNum = parseInt(match[1], 10);
        totalQ = parseInt(match[2], 10);
      }
    }

    // 2. Question Text
    const qDynamic = document.querySelector('a-dynamic-content[region-id="question-Text"]');
    let qText = "";
    if (qDynamic) {
      const clone = qDynamic.cloneNode(true);
      clone.querySelectorAll("input, script, style").forEach(el => el.remove());
      qText = clone.innerText.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim();
    }

    // 3. Options
    const choiceButtons = Array.from(document.querySelectorAll(".choice-SelectArea"));
    const options = choiceButtons.map((btn, idx) => {
      const textSpan = btn.querySelector(".choice-Text");
      const label = String.fromCharCode(65 + idx); // A, B, C, D...
      const text = textSpan ? textSpan.innerText.trim() : btn.getAttribute("aria-label") || "";
      return { label, text, index: idx };
    });

    return { qNum, totalQ, qText, options };
  }

  function generateBatchPrompt(harvested, totalQ) {
    let prompt = `You are an expert assessment solver. Below is a batch of multiple-choice questions from an assessment.\n`;
    prompt += `Analyze each question carefully and provide the single correct answer letter (A, B, C, D, etc.).\n\n`;
    prompt += `STRICT OUTPUT REQUIREMENT:\n`;
    prompt += `Output ONLY the question number followed by the correct option letter, one per line.\n`;
    prompt += `Do NOT include any explanations, markdown titles, or additional text.\n\n`;
    prompt += `FORMAT EXAMPLE:\n1: C\n2: A\n3: D\n...\n\n`;
    prompt += `--- QUESTIONS BATCH ---\n\n`;

    const keys = Object.keys(harvested).map(k => parseInt(k, 10)).sort((a, b) => a - b);
    for (const num of keys) {
      const q = harvested[num];
      prompt += `Question ${num}:\n${q.text}\n`;
      for (const opt of q.options) {
        prompt += `${opt.label}. ${opt.text}\n`;
      }
      prompt += `\n`;
    }

    return prompt;
  }

  function parseAIAnswersText(rawText) {
    const answers = {};
    const lines = rawText.trim().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Match "1: C" or "1. C" or "1 - C" or "Q1: C" or "Question 1: C"
      const match = trimmed.match(/^(?:Q(?:uestion)?\s*)?(\d+)[\s.:\)-]+([A-Za-z0-9]+)/i);
      if (match) {
        const qNum = parseInt(match[1], 10);
        const ans = match[2].trim().toUpperCase();
        answers[qNum] = ans;
      }
    }
    return answers;
  }

  function handleQuizLifecycle() {
    const qInfo = parseCurrentQuestionDOM();
    if (!qInfo.qNum || !qInfo.totalQ) return;

    setHUDCurrentItem(`Question ${qInfo.qNum} of ${qInfo.totalQ}`);
    bridgeMsg("OA_BRIDGE_SUPPRESS_WARNINGS");

    // --- STATE 1: HARVESTING ---
    if (quizData.state === "HARVESTING") {
      setHUDBadge("HARVESTING", "running");
      setHUDLog(`Extracting Q${qInfo.qNum}/${qInfo.totalQ}...`);

      // Store current question data
      const harvested = { ...quizData.harvested };
      harvested[qInfo.qNum] = {
        q_num: qInfo.qNum,
        total_q: qInfo.totalQ,
        text: qInfo.qText,
        options: qInfo.options
      };

      const isLastQuestion = qInfo.qNum >= qInfo.totalQ;

      if (!isLastQuestion) {
        // Pick a random option
        const randomIdx = Math.floor(Math.random() * qInfo.options.length);
        saveQuizData({ harvested, totalQuestions: qInfo.totalQ });

        setTimeout(() => {
          bridgeMsg("OA_BRIDGE_SELECT_CHOICE", { index: randomIdx });
          setTimeout(() => {
            bridgeMsg("OA_BRIDGE_SUBMIT_QUIZ");
          }, 350);
        }, config.delayMs);

      } else {
        // Last question reached! Do NOT submit! Transition to REWINDING!
        setHUDLog(`All ${qInfo.totalQ} questions captured! Rewinding to Question 1...`);
        saveQuizData({
          harvested,
          totalQuestions: qInfo.totalQ,
          state: "REWINDING"
        });

        setTimeout(() => {
          bridgeMsg("OA_BRIDGE_PREV_QUIZ");
        }, 500);
      }
      return;
    }

    // --- STATE 2: REWINDING ---
    if (quizData.state === "REWINDING") {
      setHUDBadge("REWINDING", "quiz");

      if (qInfo.qNum > 1) {
        setHUDLog(`Rewinding: Currently on Q${qInfo.qNum}...`);
        setTimeout(() => {
          bridgeMsg("OA_BRIDGE_PREV_QUIZ");
        }, 350);
      } else {
        // Reached Question 1!
        const prompt = generateBatchPrompt(quizData.harvested, quizData.totalQuestions);
        saveQuizData({
          state: "AWAITING_ANSWERS",
          batchPrompt: prompt
        });

        // Copy to clipboard
        try {
          navigator.clipboard.writeText(prompt);
          setHUDLog(`✅ All questions harvested! Batch prompt copied to clipboard.`);
        } catch (e) {
          setHUDLog(`✅ All questions harvested! View prompt in modal.`);
        }

        showQuizModal(prompt);
      }
      return;
    }

    // --- STATE 3: AWAITING ANSWERS ---
    if (quizData.state === "AWAITING_ANSWERS") {
      setHUDBadge("AWAITING AI", "quiz");
      setHUDLog("Questions harvested. Paste AI answers in modal to solve.");
      showQuizModal(quizData.batchPrompt);
      return;
    }

    // --- STATE 4: SOLVING ---
    if (quizData.state === "SOLVING") {
      setHUDBadge("SOLVING", "running");

      const targetLetter = (quizData.answers[qInfo.qNum] || "").toUpperCase();
      let selectedIdx = -1;

      // Find matching option index
      if (targetLetter) {
        selectedIdx = qInfo.options.findIndex(o => o.label === targetLetter);
      }
      if (selectedIdx === -1) {
        // Fallback default first option
        selectedIdx = 0;
      }

      setHUDLog(`Setting Q${qInfo.qNum} answer: ${targetLetter || "A"}...`);

      setTimeout(() => {
        bridgeMsg("OA_BRIDGE_SELECT_CHOICE", { index: selectedIdx });

        const isLastQuestion = qInfo.qNum >= qInfo.totalQ;

        if (!isLastQuestion) {
          // Submit and advance to next question
          setTimeout(() => {
            bridgeMsg("OA_BRIDGE_SUBMIT_QUIZ");
          }, 400);
        } else {
          // CRITICAL: DO NOT SUBMIT ON LAST QUESTION!
          setHUDBadge("DONE", "stopped");
          setHUDLog(`🎉 All questions answered! Q${qInfo.qNum} selected. NOT SUBMITTED.`);
          saveQuizData({ state: "IDLE" });
          alert(`🎉 All questions answered accurately!\n\nThe last question (Q${qInfo.qNum}) is selected and deliberately LEFT UNSUBMITTED so you can review and submit manually.`);
        }
      }, config.delayMs);
      return;
    }

    // IDLE on quiz page
    setHUDBadge("QUIZ READY", "stopped");
  }

  // --- Show Quiz Prompt & Solver Modal ---
  function showQuizModal(promptText) {
    if (document.getElementById("oa-quiz-modal-backdrop")) return;

    const modalHTML = `
      <div id="oa-quiz-modal-backdrop">
        <div id="oa-quiz-modal">
          <div class="oa-modal-header">
            <h2>⚡ Assessment AI Solver</h2>
            <button class="oa-modal-close" id="oa-close-modal-btn">&times;</button>
          </div>
          <div class="oa-modal-body">
            <div class="oa-prompt-box">
              <div class="oa-box-title">
                <span>Batch Questions Prompt (Give this to your AI):</span>
                <button class="oa-btn oa-btn-secondary" id="oa-copy-prompt-btn">📋 Copy Prompt</button>
              </div>
              <textarea id="oa-prompt-textarea" class="oa-textarea" rows="8" readonly>${promptText || ""}</textarea>
            </div>
            <div class="oa-response-box">
              <div class="oa-box-title">
                <span>Paste AI Response (e.g., 1: C, 2: A...):</span>
                <span style="font-size: 11px; color: #94a3b8;">Format: &lt;Question&gt;: &lt;Option&gt;</span>
              </div>
              <textarea id="oa-response-textarea" class="oa-textarea" rows="6" placeholder="1: C&#10;2: A&#10;3: D&#10;..."></textarea>
            </div>
          </div>
          <div class="oa-modal-footer">
            <button class="oa-btn oa-btn-secondary" id="oa-cancel-modal-btn">Close</button>
            <button class="oa-btn oa-btn-success" id="oa-start-solving-btn">🚀 Apply Answers & Fill Quiz</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHTML);

    document.getElementById("oa-close-modal-btn").addEventListener("click", hideQuizModal);
    document.getElementById("oa-cancel-modal-btn").addEventListener("click", hideQuizModal);

    document.getElementById("oa-copy-prompt-btn").addEventListener("click", () => {
      const textarea = document.getElementById("oa-prompt-textarea");
      textarea.select();
      navigator.clipboard.writeText(textarea.value);
      const copyBtn = document.getElementById("oa-copy-prompt-btn");
      copyBtn.textContent = "✅ Copied!";
      setTimeout(() => { copyBtn.textContent = "📋 Copy Prompt"; }, 1500);
    });

    document.getElementById("oa-start-solving-btn").addEventListener("click", () => {
      const respText = document.getElementById("oa-response-textarea").value;
      const parsedAnswers = parseAIAnswersText(respText);

      if (Object.keys(parsedAnswers).length === 0) {
        alert("Please paste the AI answers in the format:\n1: C\n2: A\n3: D\n...");
        return;
      }

      hideQuizModal();
      saveQuizData({
        answers: parsedAnswers,
        state: "SOLVING"
      });
      handleQuizLifecycle();
    });
  }

  function hideQuizModal() {
    const modal = document.getElementById("oa-quiz-modal-backdrop");
    if (modal) modal.remove();
  }

  // =========================================================================
  // COURSE ENGINE: SAVE & CONTINUE (LESSON & OUTLINE)
  // =========================================================================

  function scheduleCourseRun() {
    if (!config.active || isExecuting) return;
    isExecuting = true;
    setTimeout(() => {
      isExecuting = false;
      if (!config.active) return;
      executeCourseStep();
    }, config.delayMs);
  }

  function executeCourseStep() {
    const pageType = getPageType();
    if (pageType === "LESSON") {
      handleLessonStep();
    } else if (pageType === "OUTLINE") {
      handleOutlineStep();
    }
  }

  function handleLessonStep() {
    bridgeMsg("OA_BRIDGE_SUPPRESS_WARNINGS");

    const sectionName = document.getElementById("P15_PARENT_MODULE_NAME")?.value ||
                        document.querySelector(".t-BreadcrumbRegion-breadcrumb h2")?.innerText ||
                        "Current Section";

    const p15Title = document.getElementById("P15_TITLE")?.value || "";
    const activeStepNode = document.querySelector("li.t-WizardSteps-step.is-active-module") ||
                           document.querySelector("li.t-WizardSteps-step.is-active");
    const activeStepText = activeStepNode ? activeStepNode.innerText.replace(/[\n\r]+/g, " ").trim() : "";
    const currentTitle = p15Title || activeStepText || "Lesson Module";

    setHUDCurrentItem(currentTitle);

    // Skip quizzes when in course lesson mode
    const p15AssessmentId = document.getElementById("P15_ASSESSMENT_ID")?.value;
    const isCurrentQuiz = isAssessmentText(currentTitle) ||
                          isAssessmentText(activeStepText) ||
                          (p15AssessmentId && p15AssessmentId.trim().length > 0);

    if (isCurrentQuiz) {
      setHUDBadge("QUIZ SKIPPED", "quiz");
      setHUDLog(`Skipping Quiz: "${currentTitle}". Section finished!`);
      markSectionCleared(sectionName);

      if (config.autoLoopSections) {
        setTimeout(navigateToCourseOutline, config.delayMs + 200);
      } else {
        saveConfig({ active: false });
      }
      return;
    }

    // Save and Continue
    const nextBtn = document.getElementById("nextModButton");
    if (nextBtn && !nextBtn.disabled && !nextBtn.classList.contains("is-disabled")) {
      setHUDLog(`Saving module: "${currentTitle}"...`);
      bridgeMsg("OA_BRIDGE_CLICK_SAVE");
    } else {
      setHUDLog("No save button. Section finished. Returning to outline...");
      markSectionCleared(sectionName);
      setTimeout(navigateToCourseOutline, config.delayMs);
    }
  }

  function handleOutlineStep() {
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
      if (!href.includes(":15:")) continue;
      if (!/^section\s+\d+/i.test(title)) continue;
      if (isAssessmentText(title)) continue;
      if (badge.includes("100%")) continue;

      const isAlreadyCleared = cleared.some(cName => {
        return title.toLowerCase().includes(cName.toLowerCase()) ||
               cName.toLowerCase().includes(title.toLowerCase());
      });
      if (isAlreadyCleared) continue;

      const secMatch = title.match(/section\s+(\d+)/i);
      const secNum = secMatch ? parseInt(secMatch[1], 10) : 999;

      candidateSections.push({ secNum, title, link: linkElem, href, badge });
    }

    candidateSections.sort((a, b) => a.secNum - b.secNum);

    if (candidateSections.length === 0) {
      setHUDLog("All course sections completed! 🎉 (Quizzes untouched)");
      setHUDBadge("FINISHED", "stopped");
      saveConfig({ active: false });
      return;
    }

    const target = candidateSections[0];
    setHUDLog(`Entering ${target.title} (${target.badge || "0%"})...`);

    setTimeout(() => {
      target.link.click();
      setTimeout(() => {
        if (window.location.href.includes(":14:") && target.link.href) {
          window.location.href = target.link.href;
        }
      }, 500);
    }, config.delayMs);
  }

  function markSectionCleared(name) {
    if (!name) return;
    const cleared = config.clearedSections || [];
    if (!cleared.some(c => c.toLowerCase() === name.toLowerCase())) {
      cleared.push(name);
      saveConfig({ clearedSections: cleared });
    }
  }

  function navigateToCourseOutline() {
    bridgeMsg("OA_BRIDGE_SUPPRESS_WARNINGS");

    const courseBtn = document.querySelector(
      "button#B91059063829211655, button[id^='B91059'], button.t-Button:has(.fa-home)"
    );
    if (courseBtn) {
      courseBtn.click();
      return;
    }

    const outlineBreadcrumb = Array.from(document.querySelectorAll("a.t-Breadcrumb-label, a"))
      .find(a => (a.innerText || "").includes("Taking a Class") || (a.href && a.href.includes(":14:")));
    if (outlineBreadcrumb && outlineBreadcrumb.href) {
      window.location.href = outlineBreadcrumb.href;
      return;
    }

    if (config.outlineUrl && config.outlineUrl.includes(":14:")) {
      window.location.href = config.outlineUrl;
      return;
    }

    window.history.back();
  }

  // =========================================================================
  // ON-SCREEN HEADS-UP DISPLAY (HUD)
  // =========================================================================
  function injectHUD() {
    if (document.getElementById("oa-auto-hud")) return;

    const pageType = getPageType();
    const isQuizPage = pageType === "QUIZ";

    const hud = document.createElement("div");
    hud.id = "oa-auto-hud";
    hud.innerHTML = `
      <div class="oa-hud-header">
        <div class="oa-hud-title">
          <div id="oa-pulse" class="oa-hud-pulse"></div>
          <span>${isQuizPage ? "Assessment AI Solver" : "OA Auto-Progressor"}</span>
        </div>
        <div id="oa-status-badge" class="oa-hud-status-badge stopped">OFF</div>
      </div>
      <div class="oa-hud-body">
        <div class="oa-hud-row">
          <span>Target Item:</span>
          <span id="oa-current-item" class="val">Detecting...</span>
        </div>
        ${isQuizPage ? `
          <div class="oa-hud-row">
            <span>Quiz Status:</span>
            <span id="oa-quiz-stage" class="val" style="color: #38bdf8;">${quizData.state}</span>
          </div>
          <div class="oa-hud-controls">
            <button id="oa-quiz-harvest-btn" class="oa-hud-btn primary">Harvest Questions</button>
            <button id="oa-quiz-modal-btn" class="oa-hud-btn secondary">AI Answers</button>
            <button id="oa-quiz-reset-btn" class="oa-hud-btn secondary">Reset</button>
          </div>
        ` : `
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
        `}
        <div id="oa-hud-log" class="oa-hud-log">Ready.</div>
      </div>
    `;

    document.body.appendChild(hud);

    if (isQuizPage) {
      document.getElementById("oa-quiz-harvest-btn").addEventListener("click", () => {
        saveQuizData({
          state: "HARVESTING",
          harvested: {},
          answers: {},
          batchPrompt: ""
        });
        handleQuizLifecycle();
      });

      document.getElementById("oa-quiz-modal-btn").addEventListener("click", () => {
        const prompt = quizData.batchPrompt || generateBatchPrompt(quizData.harvested, quizData.totalQuestions);
        showQuizModal(prompt);
      });

      document.getElementById("oa-quiz-reset-btn").addEventListener("click", () => {
        saveQuizData(DEFAULT_QUIZ);
        setHUDLog("Quiz solver reset to IDLE.");
      });
    } else {
      document.getElementById("oa-toggle-btn").addEventListener("click", () => {
        const nextActive = !config.active;
        saveConfig({ active: nextActive });
        if (nextActive) scheduleCourseRun();
      });

      document.getElementById("oa-outline-btn").addEventListener("click", navigateToCourseOutline);

      document.getElementById("oa-reset-btn").addEventListener("click", () => {
        saveConfig({ clearedSections: [] });
        setHUDLog("Cache cleared! Ready to re-run all sections.");
      });
    }
  }

  function updateHUD() {
    const badge = document.getElementById("oa-status-badge");
    const pulse = document.getElementById("oa-pulse");
    const sectionsDone = document.getElementById("oa-sections-done");
    const toggleBtn = document.getElementById("oa-toggle-btn");
    const quizStage = document.getElementById("oa-quiz-stage");

    if (quizStage) quizStage.textContent = quizData.state;

    if (sectionsDone) {
      sectionsDone.textContent = `${(config.clearedSections || []).length} cleared`;
    }

    if (getPageType() === "QUIZ") {
      if (quizData.state === "HARVESTING" || quizData.state === "SOLVING") {
        if (badge) { badge.textContent = quizData.state; badge.className = "oa-hud-status-badge running"; }
        if (pulse) pulse.className = "oa-hud-pulse running";
      } else if (quizData.state === "REWINDING" || quizData.state === "AWAITING_ANSWERS") {
        if (badge) { badge.textContent = quizData.state; badge.className = "oa-hud-status-badge quiz"; }
        if (pulse) pulse.className = "oa-hud-pulse";
      } else {
        if (badge) { badge.textContent = "IDLE"; badge.className = "oa-hud-status-badge stopped"; }
        if (pulse) pulse.className = "oa-hud-pulse";
      }
      return;
    }

    if (!badge || !pulse) return;

    if (config.active) {
      badge.textContent = "RUNNING";
      badge.className = "oa-hud-status-badge running";
      pulse.className = "oa-hud-pulse running";
      if (toggleBtn) { toggleBtn.textContent = "Pause"; toggleBtn.className = "oa-hud-btn danger"; }
    } else {
      badge.textContent = "PAUSED";
      badge.className = "oa-hud-status-badge stopped";
      pulse.className = "oa-hud-pulse";
      if (toggleBtn) { toggleBtn.textContent = "Start"; toggleBtn.className = "oa-hud-btn primary"; }
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
    if (logElem) logElem.textContent = msg;
  }
})();
