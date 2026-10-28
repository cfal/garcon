import { expect, test } from "bun:test";
import { captureBrowserErrors } from '../../support/browser-errors.js';
import { chromium } from "playwright";
import { buildWebBrowserEntry } from "../../support/web-browser-bundle";
import type {
  mountFontEditor,
  reattachFontEditor,
  scrollFontEditor,
  undo,
} from "../../../web/src/lib/theme/__tests__/editor-font-fixture";

test("live editor fonts refresh cached metrics while preserving document, selection and undo", async () => {
  const bundle = await buildWebBrowserEntry(
    "src/lib/theme/__tests__/editor-font-fixture.ts",
  );
  const font = Buffer.from(
    await Bun.file(
      new URL(
        "../../../web/src/lib/theme/assets/DepartureMono-1.500.woff2",
        import.meta.url,
      ),
    ).arrayBuffer(),
  ).toString("base64");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const browserErrors: string[] = [];
    captureBrowserErrors(page.context(), browserErrors);
    await page.setContent(
      `<style>@font-face { font-family: "Departure Mono"; src: url(data:font/woff2;base64,${font}); }</style><div id="editor"></div>`,
    );
    await page.addScriptTag({
      type: "module",
      content: `${bundle}\nwindow.fontFixture = { mountFontEditor, reattachFontEditor, scrollFontEditor, undo };`,
    });
    const result = await page.evaluate(async () => {
      const scope = window as typeof window & {
        fontFixture: {
          mountFontEditor: typeof mountFontEditor;
          reattachFontEditor: typeof reattachFontEditor;
          scrollFontEditor: typeof scrollFontEditor;
          undo: typeof undo;
        };
      };
      let view = scope.fontFixture.mountFontEditor(
        document.querySelector<HTMLElement>("#editor")!,
      );
      const settle = () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      await document.fonts.ready;
      await document.fonts.load('16px "Departure Mono"');
      await settle();
      const measure = () => {
        const range = document.createRange();
        range.selectNodeContents(view.contentDOM.querySelector(".cm-line")!);
        return {
          cached: view.defaultCharacterWidth,
          actual: range.getBoundingClientRect().width / view.state.doc.length,
        };
      };
      const selectFont = async (departure: boolean) => {
        document.documentElement.style.setProperty(
          "--code-editor-font-override",
          departure ? '"Departure Mono"' : "monospace",
        );
        document.documentElement.dataset.codeEditorFont = departure
          ? "departure-mono"
          : "default";
        await settle();
      };
      const before = measure();
      view.dispatch({
        changes: { from: 0, insert: "z" },
        selection: { anchor: 8 },
      });
      const originalDom = view.dom;
      const originalDoc = view.state.doc;
      // Equal line height makes stale horizontal metrics visible rather than incidentally refreshed.
      await selectFont(true);
      const changed = measure();
      const preserved =
        view.dom === originalDom &&
        view.state.doc === originalDoc &&
        view.state.selection.main.anchor === 8;
      document.documentElement.style.setProperty(
        "--code-editor-font-override",
        "monospace",
      );
      document.fonts.dispatchEvent(new Event("loadingdone"));
      await settle();
      const loaded = measure();
      const undid = scope.fontFixture.undo(view);
      const text = view.state.doc.toString();
      const overlappingEdits = [];
      for (const trigger of ["attribute", "loadingdone"]) {
        document.documentElement.style.setProperty(
          "--code-editor-font-override",
          "monospace",
        );
        document.documentElement.dataset.codeEditorFont = "default";
        await settle();
        document.documentElement.style.setProperty(
          "--code-editor-font-override",
          '"Departure Mono"',
        );
        if (trigger === "attribute") {
          document.documentElement.dataset.codeEditorFont = "departure-mono";
          await Promise.resolve();
        } else {
          document.fonts.dispatchEvent(new Event("loadingdone"));
        }
        view.dispatch({ changes: { from: 0, insert: "x" } });
        await settle();
        overlappingEdits.push(measure());
      }
      const offscreenSwitches = [];
      const host = view.dom.parentElement!;
      for (const mode of [
        "offscreen",
        "hidden",
        "hidden-scroll-before",
        "hidden-scroll-during",
      ]) {
        await selectFont(false);
        const retainedDom = view.dom;
        const retainedDoc = view.state.doc;
        if (mode === "offscreen") host.style.marginTop = "200vh";
        else host.style.display = "none";
        view.requestMeasure();
        await settle();
        const wasOffscreen = !view.inView;
        if (mode === "hidden-scroll-before") {
          scope.fontFixture.scrollFontEditor(view, 8);
          await settle();
        }
        const fontChange = selectFont(true);
        if (mode === "hidden-scroll-during") {
          scope.fontFixture.scrollFontEditor(view, 8);
        }
        await fontChange;
        host.style.marginTop = "";
        host.style.display = "";
        view.requestMeasure();
        await settle();
        offscreenSwitches.push({
          mode,
          wasOffscreen,
          ...measure(),
          retained: view.dom === retainedDom && view.state.doc === retainedDoc,
        });
      }
      const diffHost = document.createElement("div");
      document.body.append(diffHost);
      const diffView = scope.fontFixture.mountFontEditor(diffHost, "code-diff");
      await settle();
      const editorStateBeforeDiff = view.state;
      const diffStateBeforeChange = diffView.state;
      document.documentElement.style.setProperty(
        "--code-diff-font-override",
        '"Departure Mono"',
      );
      document.documentElement.style.setProperty(
        "--code-diff-font-size",
        "20px",
      );
      document.documentElement.dataset.codeDiffFont = "departure-mono";
      document.documentElement.dataset.codeDiffFontSize = "20";
      await settle();
      const scopedDiff = {
        editorUnchanged: view.state === editorStateBeforeDiff,
        diffRefreshed: diffView.state !== diffStateBeforeChange,
        family: getComputedStyle(diffView.contentDOM).fontFamily,
        size: getComputedStyle(diffView.contentDOM).fontSize,
      };
      const retainedDiffState = diffView.state;
      document.documentElement.style.setProperty(
        "--code-editor-font-size",
        "18px",
      );
      document.documentElement.dataset.codeEditorFontSize = "18";
      await settle();
      const scopedEditor = {
        diffUnchanged: diffView.state === retainedDiffState,
        size: getComputedStyle(view.contentDOM).fontSize,
        ...measure(),
      };
      diffView.destroy();
      diffHost.remove();
      document.documentElement.style.removeProperty("--code-editor-font-size");
      document.documentElement.dataset.codeEditorFontSize = "default";
      await settle();
      const ruleCount = () =>
        Array.from(document.styleSheets).reduce(
          (count, sheet) => count + sheet.cssRules.length,
          0,
        );
      const rulesBefore = ruleCount();
      for (let index = 0; index < 100; index++) {
        document.fonts.dispatchEvent(new Event("loadingdone"));
      }
      await settle();
      const rulesAfter = ruleCount();
      view.destroy();
      const transfers = [];
      for (const triggers of [1, 2]) {
        await selectFont(false);
        view = scope.fontFixture.mountFontEditor(
          document.querySelector<HTMLElement>("#editor")!,
        );
        for (let index = 0; index < triggers; index++)
          await selectFont(index % 2 === 0);
        const retainedDoc = view.state.doc;
        view = scope.fontFixture.reattachFontEditor(view);
        await settle();
        const beforeTransferSwitch = measure();
        await selectFont(triggers % 2 === 0);
        transfers.push({
          before: beforeTransferSwitch,
          after: measure(),
          retained: view.state.doc === retainedDoc,
        });
        view.destroy();
      }
      document.documentElement.dataset.codeEditorFont = "default";
      document.fonts.dispatchEvent(new Event("loadingdone"));
      await settle();
      return {
        scopedDiff,
        scopedEditor,
        before,
        changed,
        loaded,
        preserved,
        undid,
        text,
        overlappingEdits,
        rulesBefore,
        rulesAfter,
        transfers,
        offscreenSwitches,
      };
    });
    expect(result.scopedDiff.editorUnchanged).toBe(true);
    expect(result.scopedDiff.diffRefreshed).toBe(true);
    expect(result.scopedDiff.family).toContain("Departure Mono");
    expect(result.scopedDiff.size).toBe("20px");
    expect(result.scopedEditor.diffUnchanged).toBe(true);
    expect(result.scopedEditor.size).toBe("18px");
    expect(result.scopedEditor.cached).toBeCloseTo(
      result.scopedEditor.actual,
      1,
    );
    expect(result.changed.actual).not.toBeCloseTo(result.before.actual, 1);
    expect(result.changed.cached).toBeCloseTo(result.changed.actual, 1);
    expect(result.loaded.cached).toBeCloseTo(result.loaded.actual, 1);
    expect(result.preserved).toBe(true);
    expect(result.undid).toBe(true);
    expect(result.text).toBe("abcdefghijklmnopqrst");
    for (const measurement of result.overlappingEdits) {
      expect(measurement.cached).toBeCloseTo(measurement.actual, 1);
    }
    expect(result.rulesAfter).toBe(result.rulesBefore);
    for (const measurement of result.offscreenSwitches) {
      expect(measurement.wasOffscreen).toBe(true);
      expect(measurement.cached).toBeCloseTo(measurement.actual, 1);
      expect(measurement.retained).toBe(true);
    }
    for (const transfer of result.transfers) {
      expect(transfer.after.actual).not.toBeCloseTo(transfer.before.actual, 1);
      expect(transfer.after.cached).toBeCloseTo(transfer.after.actual, 1);
      expect(transfer.retained).toBe(true);
    }
    expect(browserErrors).toEqual([]);
  } finally {
    await browser.close();
  }
});
