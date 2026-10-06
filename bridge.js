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
        const b = document.getElementById("nextModButton");
        if (b) {
          b.click();
        } else if (window.apex && window.apex.jQuery) {
          window.apex.jQuery("#nextModButton").trigger("click");
        }
      } catch (err) {
        console.warn("[OA-Bridge] Save click err:", err);
      }
    }

    // 2. QUIZ SELECT CHOICE(S) (SINGLE & MULTI)
    if (event.data.type === "OA_BRIDGE_SELECT_CHOICE" || event.data.type === "OA_BRIDGE_SELECT_CHOICES") {
      const indices = Array.isArray(event.data.indices)
        ? event.data.indices
        : [event.data.index !== undefined ? event.data.index : 0];

      try {
        const choiceBtns = Array.from(document.querySelectorAll(".choice-SelectArea"));
        if (!choiceBtns.length) return;

        // Clear existing selections first
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

        // Apply selections directly to APEX state without double-toggling
        indices.forEach(idx => {
          if (choiceBtns[idx]) {
            const btn = choiceBtns[idx];

            // Set hidden choice input to Y
            const hiddenChoice = btn.querySelector(".qzlab-choice") || btn.querySelector('input[name="f01"]');
            if (hiddenChoice) {
              hiddenChoice.value = "Y";
              if (window.$) window.$(hiddenChoice).val("Y");
            }

            // Set visual aria and icon
            btn.setAttribute("aria-checked", "true");
            const icon = btn.querySelector(".choice-Icon");
            if (icon) {
              icon.classList.remove("fa-square-o");
              icon.classList.add("fa-check");
            }
          }
        });

        // Trigger APEX state setters and enable submit
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

    // 3. QUIZ SUBMIT ANSWER (EXACTLY ONCE)
    if (event.data.type === "OA_BRIDGE_SUBMIT_QUIZ") {
      suppressWarnings();
      try {
        const submitBtn = document.getElementById("quiz-submit");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove("apex_disabled");
          submitBtn.click();
        } else if (window.apex && window.apex.submit) {
          window.apex.submit({ request: "SUBMIT", validate: true });
        }
        console.log("[OA-Bridge] Submitted quiz answer.");
      } catch (err) {
        console.warn("[OA-Bridge] Quiz submit err:", err);
      }
    }

    // 4. QUIZ PREVIOUS QUESTION (EXACTLY ONCE)
    if (event.data.type === "OA_BRIDGE_PREV_QUIZ") {
      suppressWarnings();
      try {
        const prevBtn = document.querySelector("button[data-otel-label='PREVIOUS'], button#B102387680792266124");
        if (prevBtn) {
          prevBtn.click();
        } else if (window.apex && window.apex.submit) {
          window.apex.submit({ request: "PREVIOUS", validate: true });
        }
        console.log("[OA-Bridge] Navigated to previous question.");
      } catch (err) {
        console.warn("[OA-Bridge] Quiz prev err:", err);
      }
    }
  });
})();
