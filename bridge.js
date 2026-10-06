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

    // 2. QUIZ SELECT CHOICE(S) (SUPPORTS SINGLE AND MULTI OPTIONS)
    if (event.data.type === "OA_BRIDGE_SELECT_CHOICE" || event.data.type === "OA_BRIDGE_SELECT_CHOICES") {
      const indices = Array.isArray(event.data.indices)
        ? event.data.indices
        : [event.data.index !== undefined ? event.data.index : 0];

      try {
        const choiceBtns = Array.from(document.querySelectorAll(".choice-SelectArea"));
        if (!choiceBtns.length) return;

        // Clear all existing choices first
        if (typeof clearAllChoices === "function") {
          clearAllChoices();
        } else {
          choiceBtns.forEach(btn => {
            btn.setAttribute("aria-checked", "false");
            const h = btn.querySelector(".qzlab-choice") || btn.querySelector('input[name="f01"]');
            if (h) h.value = "N";
            const ic = btn.querySelector(".choice-Icon");
            if (ic) { ic.classList.remove("fa-check"); ic.classList.add("fa-square-o"); }
          });
        }

        // Apply selection for all specified indices
        indices.forEach(idx => {
          if (choiceBtns[idx]) {
            const btn = choiceBtns[idx];

            if (typeof toggleChoice === "function" && window.$) {
              toggleChoice(window.$(btn));
            } else if (window.apex && window.apex.jQuery) {
              window.apex.jQuery(btn).trigger("click");
            }

            btn.click();
            btn.setAttribute("aria-checked", "true");

            const hiddenChoice = btn.querySelector(".qzlab-choice") || btn.querySelector('input[name="f01"]');
            if (hiddenChoice) hiddenChoice.value = "Y";

            const icon = btn.querySelector(".choice-Icon");
            if (icon) {
              icon.classList.remove("fa-square-o");
              icon.classList.add("fa-check");
            }
          }
        });

        // Force validation & enable submit
        if (typeof checkSubmitButton === "function") checkSubmitButton();
        if (typeof enableSubmitButton === "function") enableSubmitButton();
        if (window.apex && window.apex.item) {
          const item = window.apex.item("P190_CHOICE_CLICKED");
          if (item) item.setValue("Y");
        }

        const submitBtn = document.getElementById("quiz-submit");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove("apex_disabled");
        }

        console.log("[OA-Bridge] Successfully selected choices:", indices);
      } catch (err) {
        console.warn("[OA-Bridge] Select choices err:", err);
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
