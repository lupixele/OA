// Oracle Academy Main-World Execution Bridge
// Runs natively in the page's MAIN execution world (Chrome Manifest V3)

(() => {
  function suppressWarnings() {
    try {
      window.onbeforeunload = null;
      if (window.apex && window.apex.page && window.apex.page.ignoreWarnOnUnsavedChanges) {
        window.apex.page.ignoreWarnOnUnsavedChanges();
      }
    } catch (e) {}
  }

  suppressWarnings();

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || !event.data.type) return;

    if (event.data.type === "OA_BRIDGE_SUPPRESS_WARNINGS") {
      suppressWarnings();
    }

    // 1. LESSON SAVE & CONTINUE
    if (event.data.type === "OA_BRIDGE_CLICK_SAVE") {
      suppressWarnings();
      try {
        if (window.apex && window.apex.jQuery) {
          window.apex.jQuery("#nextModButton").trigger("click");
        }
        const b = document.getElementById("nextModButton");
        if (b) b.click();
      } catch (err) {
        console.warn("[OA-Bridge] Save click err:", err);
      }
    }

    // 2. QUIZ SELECT CHOICE
    if (event.data.type === "OA_BRIDGE_SELECT_CHOICE") {
      const index = event.data.index;
      try {
        const choiceBtns = document.querySelectorAll(".choice-SelectArea");
        if (choiceBtns && choiceBtns[index]) {
          if (window.apex && window.apex.jQuery) {
            window.apex.jQuery(choiceBtns[index]).trigger("click");
          }
          choiceBtns[index].click();
        }
      } catch (err) {
        console.warn("[OA-Bridge] Select choice err:", err);
      }
    }

    // 3. QUIZ SUBMIT ANSWER
    if (event.data.type === "OA_BRIDGE_SUBMIT_QUIZ") {
      suppressWarnings();
      try {
        const submitBtn = document.getElementById("quiz-submit");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove("apex_disabled");
          submitBtn.click();
        }
        if (window.apex && window.apex.submit) {
          window.apex.submit({ request: "SUBMIT", validate: true });
        }
      } catch (err) {
        console.warn("[OA-Bridge] Quiz submit err:", err);
      }
    }

    // 4. QUIZ PREVIOUS QUESTION
    if (event.data.type === "OA_BRIDGE_PREV_QUIZ") {
      suppressWarnings();
      try {
        const prevBtn = document.querySelector("button[data-otel-label='PREVIOUS'], button#B102387680792266124");
        if (prevBtn) {
          prevBtn.click();
        }
        if (window.apex && window.apex.submit) {
          window.apex.submit({ request: "PREVIOUS", validate: true });
        }
      } catch (err) {
        console.warn("[OA-Bridge] Quiz prev err:", err);
      }
    }
  });
})();
