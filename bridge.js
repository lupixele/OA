// Oracle Academy Main-World Execution Bridge
// Runs natively in the page's MAIN execution world (Chrome Manifest V3)
// Completely eliminates Content Security Policy (CSP) inline script violations.

(() => {
  // Suppress warnings on initial load
  function suppressWarnings() {
    try {
      window.onbeforeunload = null;
      if (window.apex && window.apex.page && window.apex.page.ignoreWarnOnUnsavedChanges) {
        window.apex.page.ignoreWarnOnUnsavedChanges();
      }
    } catch (e) {}
  }

  suppressWarnings();

  // Listen for actions requested by content.js
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || !event.data.type) return;

    if (event.data.type === "OA_BRIDGE_CLICK_SAVE") {
      suppressWarnings();

      try {
        const nextBtn = document.getElementById("nextModButton");

        // 1. If apex.jQuery is present, trigger click on button
        if (window.apex && window.apex.jQuery) {
          window.apex.jQuery("#nextModButton").trigger("click");
        }

        // 2. Direct DOM click
        if (nextBtn) {
          nextBtn.click();
        }

        console.log("[OA-Bridge] Triggered 'Save and Continue'");
      } catch (err) {
        console.warn("[OA-Bridge] Error triggering click:", err);
      }
    }

    if (event.data.type === "OA_BRIDGE_SUPPRESS_WARNINGS") {
      suppressWarnings();
    }
  });
})();
