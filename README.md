# Oracle Academy Fast Auto-Progressor Extension

Autonomous section navigation and lesson progress engine for Oracle Academy courses (`academy.oracle.com`).

---

### Features
1. **High Speed**: Directly triggers Oracle APEX `Save and Continue` (`#nextModButton`) with configurable delays down to **150ms** (Turbo Mode).
2. **Zero Quiz/Exam Interference**:
   - Skips all quizzes within sections (e.g. `Quiz: DFo - Section 2`).
   - Skips standalone exams on the Course Outline (`Midterm Exam`, `Final Exam`, `Cumulative Exam`).
   - Never clicks or submits test questions.
3. **Auto-Loop All Sections**:
   - Traverses incomplete sections in the course outline (`Page 14`).
   - Completes all slides, student guides, practice, and project modules (`Page 15`).
   - Automatically navigates back to outline when a quiz is reached, advancing to the next section.
4. **On-Screen Heads-Up Display (HUD)**:
   - Live overlay showing active item, progress status, and instant Pause/Start controls directly in the browser tab.

---

### Installation
1. Open Google Chrome (or any Chromium browser).
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked**.
5. Select the folder:
   ```text
   P:\Magnanimity\Projects\OJIJ\extension
   ```
6. Open your Oracle Academy course tab and click **Start**.
