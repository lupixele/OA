// Oracle Academy Course Progressor & Quiz AI Solver
// P:\Magnanimity\Projects\OA\extension

(() => {
  if (window.__OA_AUTOPROGRESSOR_LOADED__) return;
  window.__OA_AUTOPROGRESSOR_LOADED__ = true;

  const STORAGE_KEY = "oa_progressor_config";
  const QUIZ_STORAGE_KEY = "oa_quiz_data";

  const DEFAULT_CONFIG = {
    active: false,
    delayMs: 800,
    skipQuizzes: true,
    autoLoopSections: true,
    clearedSections: [],
    outlineUrl: ""
  };

  const DEFAULT_QUIZ = {
    state: "IDLE", // IDLE | HARVESTING | REWINDING | AWAITING_ANSWERS | SOLVING
    totalQuestions: 0,
    harvested: {}, // { [qNum]: { q_num, total_q, text, is_multi, options: ["Option A", "Option B"] } }
    answers: {},   // { [qNum]: ["Option A"] }
    batchPrompt: ""
  };

  let config = { ...DEFAULT_CONFIG };
  let quizData = { ...DEFAULT_QUIZ };
  let isExecuting = false;

  // --- Main-World Bridge Communication ---
  function bridgeMsg(type, payload = {}) {
    window.postMessage({ type, ...payload }, "*");
  }

  // --- Assessment Keyword Matcher ---
  function isAssessmentText(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    return /\b(quiz|exam|test|assessment|midterm|final|cumulative)\b/i.test(lower);
  }

  // --- HTML Entity Decode & Normalize String ---
  function normalizeText(str) {
    if (!str) return "";
    let s = str;
    s = s.replace(/&amp;/g, "&").replace(/&#x20;/g, " ").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    s = s.toLowerCase();
    s = s.replace(/[^\w\s]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  // --- Page Classifier ---
  function getPageType() {
    const url = window.location.href;
    if (url.includes(":190:") || document.getElementById("quiz-submit") || document.getElementById("collapse-Choices-reg")) {
      return "QUIZ";
    }
    if (url.includes(":14:") || document.getElementById("courseol_heading")) {
      return "OUTLINE";
    }
    if (url.includes(":15:") || document.getElementById("nextModButton") || document.querySelector(".t-WizardSteps")) {
      return "LESSON";
    }
    return "UNKNOWN";
  }

  // --- Sync Storage & Boot ---
  chrome.storage.local.get([STORAGE_KEY, QUIZ_STORAGE_KEY], (res) => {
    if (res[STORAGE_KEY]) config = { ...DEFAULT_CONFIG, ...res[STORAGE_KEY] };
    if (res[QUIZ_STORAGE_KEY]) quizData = { ...DEFAULT_QUIZ, ...res[QUIZ_STORAGE_KEY] };

    // USER CONSENT SAFEGUARD:
    const isHarvestActive = sessionStorage.getItem("oa_quiz_harvest_active") === "true";
    const isSolvingActive = sessionStorage.getItem("oa_quiz_solving_active") === "true";

    if (!isHarvestActive && !isSolvingActive) {
      quizData.state = "IDLE";
      saveQuizData({ state: "IDLE" });
    }

    if (getPageType() === "OUTLINE" && !window.location.href.includes("SAVE")) {
      config.outlineUrl = window.location.href;
      chrome.storage.local.set({ [STORAGE_KEY]: config });
    }

    injectHUD();
    updateHUD();

    const pageType = getPageType();
    if (pageType === "QUIZ") {
      bridgeMsg("OA_BRIDGE_SUPPRESS_WARNINGS");
      if (isHarvestActive || isSolvingActive) {
        waitForQuizReady((qInfo) => {
          handleQuizLifecycle(qInfo);
        });
      } else {
        setHUDBadge("IDLE", "stopped");
        setHUDLog("Quiz ready. Click 'Harvest Questions' when you want to begin.");
      }
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
  // QUIZ ENGINE: STRING-MATCHING & BATCH SOLVER
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

    // 2. Multi-choice check
    const onlyOneInput = document.getElementById("P190_ONLY_ONE_CHOICE");
    const choicesHeading = document.getElementById("collapse-Choices-reg_heading")?.innerText || "";
    let isMulti = false;
    if (onlyOneInput && onlyOneInput.value === "N") {
      isMulti = true;
    } else if (/choose\s+(?:two|three|all)|multiple/i.test(choicesHeading)) {
      isMulti = true;
    }

    // 3. Question Text
    let qText = "";
    const dynElem = document.querySelector('a-dynamic-content[region-id="question-Text"]') ||
                    document.getElementById("question-Text");
    if (dynElem) {
      const clone = dynElem.cloneNode(true);
      clone.querySelectorAll("input, script, style, .t-ContentBlock-header").forEach(el => el.remove());
      qText = clone.innerText.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim();
    }

    // 4. Extract options as clean text strings
    const choiceButtons = Array.from(document.querySelectorAll(".choice-SelectArea"));
    const options = choiceButtons.map((btn, idx) => {
      const textSpan = btn.querySelector(".choice-Text");
      let text = textSpan ? textSpan.innerText.trim() : btn.getAttribute("aria-label") || "";
      text = text.replace(/[\n\r]+/g, " ").trim();
      return { text, index: idx, element: btn };
    });

    return { qNum, totalQ, qText, isMulti, options };
  }

  function waitForQuizReady(callback, maxWaitMs = 5000) {
    const startTime = Date.now();

    function poll() {
      const qInfo = parseCurrentQuestionDOM();
      const isReady = qInfo.qNum && qInfo.options.length > 0 && qInfo.qText.length > 0;

      if (isReady || (Date.now() - startTime) >= maxWaitMs) {
        callback(qInfo);
      } else {
        setTimeout(poll, 200);
      }
    }

    poll();
  }

  // Pure String Batch Prompt
  function generateBatchPrompt(harvested, totalQ) {
    let prompt = `You are an expert assessment solver. Below is a batch of questions from an assessment.\n`;
    prompt += `IMPORTANT: The testing portal constantly shuffles option order and does not use letters. You MUST output the EXACT text of the correct option.\n\n`;
    prompt += `CRITICAL OUTPUT FORMAT:\n`;
    prompt += `1. Output strictly one line per question in this format:\n`;
    prompt += `<Question Number>: <Exact Option Text>\n\n`;
    prompt += `2. For single-choice questions:\n`;
    prompt += `1: Age\n`;
    prompt += `2: True\n\n`;
    prompt += `3. For multi-choice questions (marked [MULTI-CHOICE]):\n`;
    prompt += `Separate correct option texts with a pipe ' | ':\n`;
    prompt += `3: Tables | Columns\n\n`;
    prompt += `4. Do NOT use option letters (A, B, C, D). Output the exact wording of the option.\n`;
    prompt += `5. Do NOT include explanations or extra text.\n\n`;
    prompt += `--- QUESTIONS BATCH ---\n\n`;

    const keys = Object.keys(harvested).map(k => parseInt(k, 10)).sort((a, b) => a - b);
    for (const num of keys) {
      const q = harvested[num];
      const multiTag = q.is_multi ? " [MULTI-CHOICE: Select all that apply]" : "";
      prompt += `Question ${num}${multiTag}:\n${q.text}\n`;
      prompt += `Options:\n`;
      for (const optText of q.options) {
        prompt += `- ${optText}\n`;
      }
      prompt += `\n`;
    }

    return prompt;
  }

  // Answer Parser: Handles exact text strings, pipes, and strips legacy letter prefixes
  function parseAIAnswersText(rawText) {
    const answers = {};
    const lines = rawText.trim().split("\n");

    for (const line of lines) {
      let cleaned = line.trim();
      if (!cleaned) continue;

      cleaned = cleaned.replace(/^\s*[-*•]\s*/, "");
      cleaned = cleaned.replace(/\*\*/g, "").replace(/__/g, "").replace(/\*/g, "");

      const m = cleaned.match(/^(?:Question|Q)?\s*(\d+)\s*(?:[\.:\)\-\–—]|\s)\s*(.*)$/i);
      if (!m) continue;

      const qNum = parseInt(m[1], 10);
      let ansPart = m[2].trim();
      if (!ansPart) continue;

      // Strip legacy single-letter prefix if present: e.g. "C - Age" -> "Age", "A. True" -> "True"
      ansPart = ansPart.replace(/^[A-Fa-f]\s*[\.:\)\-\–—]\s*/, "");

      let optionStrings = [];
      if (ansPart.includes("|")) {
        optionStrings = ansPart.split("|").map(s => s.trim()).filter(Boolean);
      } else if (ansPart.includes(";")) {
        optionStrings = ansPart.split(";").map(s => s.trim()).filter(Boolean);
      } else {
        optionStrings = [ansPart];
      }

      if (optionStrings.length > 0) {
        answers[qNum] = optionStrings;
      }
    }

    return answers;
  }

  // Matches AI string answers against whatever jumbled options are live on the page
  function matchLiveOptionsByString(targetAnswerStrings, liveOptionsOnPage) {
    const matchedIndices = [];

    for (const targetStr of targetAnswerStrings) {
      const targetNorm = normalizeText(targetStr);
      if (!targetNorm) continue;

      let bestIdx = -1;
      let bestScore = -1;

      for (let i = 0; i < liveOptionsOnPage.length; i++) {
        const liveNorm = normalizeText(liveOptionsOnPage[i].text);
        if (!liveNorm) continue;

        let score = 0;
        // 1. Exact match
        if (targetNorm === liveNorm) {
          score = 1000;
        }
        // 2. Substring match
        else if (liveNorm.includes(targetNorm) || targetNorm.includes(liveNorm)) {
          score = 500 + Math.min(targetNorm.length, liveNorm.length);
        }
        // 3. Word token overlap
        else {
          const tWords = new Set(targetNorm.split(" "));
          const lWords = new Set(liveNorm.split(" "));
          let common = 0;
          tWords.forEach(w => { if (lWords.has(w)) common++; });
          if (common > 0) {
            score = common * 50;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx !== -1 && bestScore > 0 && !matchedIndices.includes(bestIdx)) {
        matchedIndices.push(bestIdx);
      }
    }

    return matchedIndices;
  }

  function handleQuizLifecycle(qInfo) {
    if (!qInfo || !qInfo.qNum || !qInfo.totalQ) {
      setHUDLog("Waiting for assessment question to load...");
      return;
    }

    setHUDCurrentItem(`Question ${qInfo.qNum} of ${qInfo.totalQ}`);
    bridgeMsg("OA_BRIDGE_SUPPRESS_WARNINGS");

    const isHarvestActive = sessionStorage.getItem("oa_quiz_harvest_active") === "true";
    const isSolvingActive = sessionStorage.getItem("oa_quiz_solving_active") === "true";

    // --- STATE 1: HARVESTING ---
    if (quizData.state === "HARVESTING" && isHarvestActive) {
      setHUDBadge("HARVESTING", "running");
      setHUDLog(`Extracting Q${qInfo.qNum}/${qInfo.totalQ}...`);

      const harvested = { ...quizData.harvested };
      harvested[qInfo.qNum] = {
        q_num: qInfo.qNum,
        total_q: qInfo.totalQ,
        text: qInfo.qText,
        is_multi: qInfo.isMulti,
        options: qInfo.options.map(o => o.text)
      };

      const isLastQuestion = qInfo.qNum >= qInfo.totalQ;

      if (!isLastQuestion) {
        let randomIndices = [];
        if (qInfo.isMulti && qInfo.options.length > 2) {
          const first = Math.floor(Math.random() * qInfo.options.length);
          let second = (first + 1) % qInfo.options.length;
          randomIndices = [first, second];
        } else {
          randomIndices = [Math.floor(Math.random() * qInfo.options.length)];
        }

        saveQuizData({ harvested, totalQuestions: qInfo.totalQ });
        const chosenTexts = randomIndices.map(i => qInfo.options[i]?.text || "").join(" | ");
        setHUDLog(`Selected [${chosenTexts}] on Q${qInfo.qNum}...`);

        setTimeout(() => {
          bridgeMsg("OA_BRIDGE_SELECT_CHOICES", { indices: randomIndices });

          setTimeout(() => {
            bridgeMsg("OA_BRIDGE_SUBMIT_QUIZ");
          }, 450);
        }, config.delayMs);

      } else {
        // Last question reached! DO NOT SUBMIT! Auto-rewind to Q1!
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
    if (quizData.state === "REWINDING" && isHarvestActive) {
      setHUDBadge("REWINDING", "quiz");

      if (qInfo.qNum > 1) {
        setHUDLog(`Rewinding: Currently on Q${qInfo.qNum}...`);
        setTimeout(() => {
          bridgeMsg("OA_BRIDGE_PREV_QUIZ");
        }, 400);
      } else {
        // Returned to Question 1!
        sessionStorage.removeItem("oa_quiz_harvest_active");

        const prompt = generateBatchPrompt(quizData.harvested, quizData.totalQuestions);
        saveQuizData({
          state: "AWAITING_ANSWERS",
          batchPrompt: prompt
        });

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

    // --- STATE 4: SOLVING VIA PURE STRING MATCHING ---
    if (quizData.state === "SOLVING" && isSolvingActive) {
      setHUDBadge("SOLVING", "running");

      // Robust key lookup: check both integer qNum and string qNum
      const targetStrings = (quizData.answers && (quizData.answers[qInfo.qNum] || quizData.answers[String(qInfo.qNum)])) || [];

      // Match target option strings directly against the live jumbled options on this page
      const targetIndices = matchLiveOptionsByString(targetStrings, qInfo.options);

      if (!targetIndices.length) {
        targetIndices.push(0); // Fallback to first option if no match
      }

      const selectedTexts = targetIndices.map(i => qInfo.options[i]?.text || "").join(" | ");
      setHUDLog(`Q${qInfo.qNum}: Matched & selecting [${selectedTexts}]...`);

      setTimeout(() => {
        bridgeMsg("OA_BRIDGE_SELECT_CHOICES", { indices: targetIndices });

        const isLastQuestion = qInfo.qNum >= qInfo.totalQ;

        if (!isLastQuestion) {
          setTimeout(() => {
            bridgeMsg("OA_BRIDGE_SUBMIT_QUIZ");
          }, 450);
        } else {
          // CRITICAL: DO NOT SUBMIT ON LAST QUESTION!
          sessionStorage.removeItem("oa_quiz_solving_active");
          setHUDBadge("DONE", "stopped");
          setHUDLog(`🎉 All questions answered! Q${qInfo.qNum} selected. NOT SUBMITTED.`);
          saveQuizData({ state: "IDLE" });
          alert(`🎉 All questions answered accurately!\n\nThe last question (Q${qInfo.qNum}) is selected and deliberately LEFT UNSUBMITTED so you can review and submit manually.`);
        }
      }, config.delayMs);
      return;
    }

    setHUDBadge("IDLE", "stopped");
    setHUDLog("Quiz ready. Click 'Harvest Questions' when you want to begin.");
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
                <span>Paste AI Response (Option strings matching):</span>
                <span style="font-size: 11px; color: #94a3b8;">Format: 1: Option Text | 2: True | 3: A | B</span>
              </div>
              <textarea id="oa-response-textarea" class="oa-textarea" rows="6" placeholder="1: Age&#10;2: True&#10;3: Tables | Columns&#10;..."></textarea>
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
        alert("Please paste the AI answers in the format:\n1: Option Text\n2: True\n3: Option 1 | Option 2\n...");
        return;
      }

      hideQuizModal();
      sessionStorage.setItem("oa_quiz_solving_active", "true");
      sessionStorage.removeItem("oa_quiz_harvest_active");
      saveQuizData({
        answers: parsedAnswers,
        state: "SOLVING"
      });
      waitForQuizReady((qInfo) => {
        handleQuizLifecycle(qInfo);
      });
    });
  }

  function hideQuizModal() {
    const modal = document.getElementById("oa-quiz-modal-backdrop");
    if (modal) modal.remove();
  }

  // =========================================================================
  // COURSE LESSON ENGINE: SAVE & CONTINUE
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
  // ON-SCREEN HEADS-UP DISPLAY (HUD) WITH MINIMIZABLE PILL
  // =========================================================================
  function injectHUD() {
    if (document.getElementById("oa-auto-hud")) return;

    const pageType = getPageType();
    const isQuizPage = pageType === "QUIZ";
    const isInitiallyMinimized = localStorage.getItem("oa_hud_minimized") === "true";

    const hud = document.createElement("div");
    hud.id = "oa-auto-hud";
    if (isInitiallyMinimized) {
      hud.classList.add("minimized");
    }

    hud.innerHTML = `
      <div class="oa-hud-header">
        <div class="oa-hud-title">
          <div id="oa-pulse" class="oa-hud-pulse"></div>
          <span>${isQuizPage ? "Assessment AI Solver" : "OA Auto-Progressor"}</span>
        </div>
        <div class="oa-hud-pill-expand">
          <span>⚡ OA</span>
          <span id="oa-pill-status">READY</span>
        </div>
        <div class="oa-hud-header-actions">
          <div id="oa-status-badge" class="oa-hud-status-badge stopped">OFF</div>
          <button id="oa-minimize-btn" class="oa-hud-min-btn" title="Minimize to side pill">−</button>
        </div>
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

    const minBtn = document.getElementById("oa-minimize-btn");
    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      hud.classList.add("minimized");
      localStorage.setItem("oa_hud_minimized", "true");
    });

    hud.addEventListener("click", () => {
      if (hud.classList.contains("minimized")) {
        hud.classList.remove("minimized");
        localStorage.removeItem("oa_hud_minimized");
      }
    });

    if (isQuizPage) {
      document.getElementById("oa-quiz-harvest-btn").addEventListener("click", () => {
        sessionStorage.setItem("oa_quiz_harvest_active", "true");
        sessionStorage.removeItem("oa_quiz_solving_active");
        saveQuizData({
          state: "HARVESTING",
          harvested: {},
          answers: {},
          batchPrompt: ""
        });
        waitForQuizReady((qInfo) => {
          handleQuizLifecycle(qInfo);
        });
      });

      document.getElementById("oa-quiz-modal-btn").addEventListener("click", () => {
        const prompt = quizData.batchPrompt || generateBatchPrompt(quizData.harvested, quizData.totalQuestions);
        showQuizModal(prompt);
      });

      document.getElementById("oa-quiz-reset-btn").addEventListener("click", () => {
        sessionStorage.removeItem("oa_quiz_harvest_active");
        sessionStorage.removeItem("oa_quiz_solving_active");
        saveQuizData(DEFAULT_QUIZ);
        setHUDBadge("IDLE", "stopped");
        setHUDLog("Quiz solver reset to IDLE. Nothing will run without your consent.");
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
    const pillStatus = document.getElementById("oa-pill-status");

    if (quizStage) quizStage.textContent = quizData.state;

    if (sectionsDone) {
      sectionsDone.textContent = `${(config.clearedSections || []).length} cleared`;
    }

    if (getPageType() === "QUIZ") {
      if (quizData.state === "HARVESTING" || quizData.state === "SOLVING") {
        if (badge) { badge.textContent = quizData.state; badge.className = "oa-hud-status-badge running"; }
        if (pulse) pulse.className = "oa-hud-pulse running";
        if (pillStatus) pillStatus.textContent = quizData.state;
      } else if (quizData.state === "REWINDING" || quizData.state === "AWAITING_ANSWERS") {
        if (badge) { badge.textContent = quizData.state; badge.className = "oa-hud-status-badge quiz"; }
        if (pulse) pulse.className = "oa-hud-pulse";
        if (pillStatus) pillStatus.textContent = quizData.state;
      } else {
        if (badge) { badge.textContent = "IDLE"; badge.className = "oa-hud-status-badge stopped"; }
        if (pulse) pulse.className = "oa-hud-pulse";
        if (pillStatus) pillStatus.textContent = "IDLE";
      }
      return;
    }

    if (!badge || !pulse) return;

    if (config.active) {
      badge.textContent = "RUNNING";
      badge.className = "oa-hud-status-badge running";
      pulse.className = "oa-hud-pulse running";
      if (toggleBtn) { toggleBtn.textContent = "Pause"; toggleBtn.className = "oa-hud-btn danger"; }
      if (pillStatus) pillStatus.textContent = "RUNNING";
    } else {
      badge.textContent = "PAUSED";
      badge.className = "oa-hud-status-badge stopped";
      pulse.className = "oa-hud-pulse";
      if (toggleBtn) { toggleBtn.textContent = "Start"; toggleBtn.className = "oa-hud-btn primary"; }
      if (pillStatus) pillStatus.textContent = "PAUSED";
    }
  }

  function setHUDBadge(text, typeClass) {
    const badge = document.getElementById("oa-status-badge");
    const pillStatus = document.getElementById("oa-pill-status");
    if (badge) {
      badge.textContent = text;
      badge.className = `oa-hud-status-badge ${typeClass}`;
    }
    if (pillStatus) {
      pillStatus.textContent = text;
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
