const sessions = new WeakMap();
// Within the 15 s settle window, how long stable geometry may wait for media.
const MEDIA_GRACE_MS = 8000;
function pageTask(action, id, index, leaseMs) {
  const key = "__zuckerScrollCapture";
  let state = window[key];
  if (action === "restore") {
    if (state?.id === id) state.restore();
    return {};
  }
  if (action === "init") {
    if (state) throw new Error("Another scrolling-content capture is active");
    const elements = [...document.querySelectorAll("*")];
    if (elements.length > 30000)
      throw new Error(
        "This page is too complex to expand its scrolling content safely.",
      );
    const panels = elements.filter((el) => {
      if (
        el === document.body ||
        el === document.documentElement ||
        el === document.scrollingElement ||
        el.closest(
          'nav,aside,[role="navigation"],[role="menu"],textarea,select',
        )
      )
        return false;
      const rect = el.getBoundingClientRect(),
        css = getComputedStyle(el);
      if (
        rect.width < 120 ||
        rect.height < 80 ||
        el.scrollHeight <= el.clientHeight + 2 ||
        !/^(auto|scroll|overlay)$/.test(css.overflowY) ||
        css.visibility !== "visible"
      )
        return false;
      for (let parent = el; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || Number(style.opacity) === 0)
          return false;
      }
      return true;
    });
    if (!panels.length) return { count: 0 };
    if (panels.length > 24)
      throw new Error(
        "This page has too many independent scrolling areas. Use Visible window or export smaller sections.",
      );
    // These lists only keep a small moving window of rows in the DOM. Merely
    // increasing their CSS height would silently produce large empty regions.
    const virtual =
      '.rc-virtual-list-holder,.ant-table-tbody-virtual-holder,[data-virtuoso-scroller],.ReactVirtualized__Grid,.ReactVirtualized__List,[data-virtualized="true"]';
    if (
      panels.some(
        (el) =>
          el.matches(virtual) ||
          [...el.querySelectorAll(virtual)].some(
            (list) =>
              list.getClientRects().length &&
              list.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }),
          ),
      )
    )
      throw new Error(
        "This page uses a virtual scrolling list. A complete full-page capture is not available; use the table's export or Visible window.",
      );
    const changes = new Map(),
      scrolls = new Map();
    state = {
      id,
      panels,
      changes,
      scrolls,
      boxes: new Map(),
      // Last applied panel height and growth step, used to detect content whose
      // size tracks the panel's own height (e.g. min-height:100% plus a footer).
      growth: new Map(),
      intrinsic: new Set(),
      watchdog: null,
      leaseMs,
    };
    state.set = (el, property, value) => {
      if (!changes.has(el))
        changes.set(el, {
          hadStyle: el.hasAttribute("style"),
          properties: new Map(),
        });
      const saved = changes.get(el).properties;
      if (!saved.has(property))
        saved.set(property, {
          value: el.style.getPropertyValue(property),
          priority: el.style.getPropertyPriority(property),
        });
      el.style.setProperty(property, value, "important");
    };
    state.restore = () => {
      clearTimeout(state.watchdog);
      // Restore layout before scroll positions, while smooth/snap scrolling is disabled.
      const scrollingProperties = new Set([
        "scroll-behavior",
        "scroll-snap-type",
        "overflow-anchor",
      ]);
      const restoreProperty = (el, property, old) =>
        old.value
          ? el.style.setProperty(property, old.value, old.priority)
          : el.style.removeProperty(property);
      for (const [el, saved] of [...changes].reverse())
        for (const [property, old] of saved.properties)
          if (!scrollingProperties.has(property))
            restoreProperty(el, property, old);
      for (const [el, saved] of scrolls) {
        el.scrollLeft = saved.x;
        el.scrollTop = saved.y;
      }
      for (const [el, saved] of changes) {
        for (const [property, old] of saved.properties)
          if (scrollingProperties.has(property))
            restoreProperty(el, property, old);
        if (!saved.hadStyle && !el.style.length) {
          // Chromium lazily synchronizes CSSOM writes to the style attribute.
          // Flush first or removeAttribute can resurrect an empty style="".
          el.getAttribute('style');
          el.removeAttribute('style');
        }
      }
      if (window[key]?.id === id) delete window[key];
    };
    window[key] = state;
    // Also recover if the extension worker unexpectedly goes away mid-capture.
    state.watchdog = setTimeout(state.restore, state.leaseMs);
    // Growing a flex/grid ancestor can clamp a sibling sidebar's scroll offset
    // even though we never expand that sidebar. Preserve those offsets too.
    for (const el of elements) {
      if (!el.scrollTop && !el.scrollLeft) continue;
      scrolls.set(el, { x: el.scrollLeft, y: el.scrollTop });
      state.set(el, "scroll-behavior", "auto");
      state.set(el, "scroll-snap-type", "none");
      state.set(el, "overflow-anchor", "none");
    }
    // Record every panel and ancestor box before any change, so later expansion
    // passes compare against and keep the original geometry rather than a
    // partially expanded one.
    for (const panel of panels)
      for (let el = panel; el; el = el.parentElement)
        if (!state.boxes.has(el)) {
          const rect = el.getBoundingClientRect();
          state.boxes.set(el, {
            width: rect.width,
            height: rect.height,
            x: rect.x,
          });
        }
    for (const panel of panels) {
      scrolls.set(panel, { x: panel.scrollLeft, y: panel.scrollTop });
      state.set(panel, "scroll-behavior", "auto");
      state.set(panel, "scroll-snap-type", "none");
      state.set(panel, "overflow-anchor", "none");
      panel.scrollTop = 0;
    }
    return { count: panels.length };
  }
  if (!state || state.id !== id)
    throw new Error(
      "The page changed while preparing its scrolling content.",
    );
  clearTimeout(state.watchdog);
  state.watchdog = setTimeout(state.restore, state.leaseMs);
  if (action === "scroll" || action === "position") {
    const panel = state.panels[index];
    if (!panel.isConnected)
      throw new Error(
        "A scrolling area changed during capture. Please retry.",
      );
    if (action === "scroll")
      panel.scrollTop += Math.max(80, panel.clientHeight * 0.8);
    return {
      bottom: panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1,
      height: panel.scrollHeight,
    };
  }
  if (action === "expand") {
    // Work from inner panels outward, keeping original widths and restoring
    // only the exact CSS properties temporarily changed by this capture.
    for (const panel of [...state.panels].reverse()) {
      if (!panel.isConnected)
        throw new Error(
          "A scrolling area changed during capture. Please retry.",
        );
      let el = panel;
      while (el) {
        const rect = el.getBoundingClientRect(),
          css = getComputedStyle(el);
        if (!state.scrolls.has(el))
          state.scrolls.set(el, { x: el.scrollLeft, y: el.scrollTop });
        if (!state.boxes.has(el))
          state.boxes.set(el, {
            width: rect.width,
            height: rect.height,
            x: rect.x,
          });
        state.set(el, "scroll-behavior", "auto");
        state.set(el, "overflow-anchor", "none");
        state.set(el, "transition", "none");
        state.set(el, "box-sizing", "border-box");
        state.set(el, "width", `${state.boxes.get(el).width}px`);
        state.set(el, "max-height", "none");
        state.set(el, "flex-shrink", "0");
        if (css.position === "fixed") {
          state.set(el, "position", "absolute");
          state.set(el, "top", `${rect.top + scrollY}px`);
          state.set(el, "left", `${rect.left + scrollX}px`);
          state.set(el, "right", "auto");
        }
        if (css.position === "fixed" || css.position === "absolute")
          state.set(el, "bottom", "auto");
        if (state.panels.includes(el)) {
          const height = el.scrollHeight + el.offsetHeight - el.clientHeight,
            last = state.growth.get(el);
          if (
            !state.intrinsic.has(el) &&
            last?.step > 1 &&
            Math.abs(height - last.height - last.step) <= 1
          )
            // Growing by the same step again means the content is sized from
            // the panel's own height, so a fixed height has no fixed point.
            // Let percentage heights resolve to auto and use the content size.
            state.intrinsic.add(el);
          if (state.intrinsic.has(el)) {
            state.set(el, "height", "auto");
            state.set(el, "min-height", `${state.boxes.get(el).height}px`);
          } else {
            state.growth.set(el, {
              height,
              step: last ? height - last.height : 0,
            });
            state.set(el, "height", `${height}px`);
            state.set(el, "min-height", `${height}px`);
          }
          // Preserve the original scrollbar gutter and horizontal scroll offset.
          state.set(el, "scrollbar-gutter", "stable");
          state.set(el, "overflow-y", "hidden");
          el.scrollTop = 0;
        } else {
          state.set(el, "height", "auto");
          // Keep the original size as a floor. Using the current, already
          // expanded size would ratchet and never shrink if a panel switches
          // to its intrinsic height.
          state.set(el, "min-height", `${state.boxes.get(el).height}px`);
          // clip on X prevents revealing off-canvas drawers while allowing Y to grow.
          if (/hidden|clip|auto|scroll/.test(css.overflowY)) {
            state.set(el, "overflow-x", "clip");
            state.set(el, "overflow-y", "visible");
          }
        }
        if (css.contain !== "none") state.set(el, "contain", "none");
        el = el.parentElement;
      }
    }
    return { height: document.documentElement.scrollHeight };
  }
  if (action === "measure") {
    for (const panel of state.panels) {
      const rect = panel.getBoundingClientRect(),
        original = state.boxes.get(panel);
      if (
        Math.abs(rect.width - original.width) > 1 ||
        Math.abs(rect.x - original.x) > 1
      )
        throw new Error(
          "This scrolling layout cannot be expanded without changing its width. Use Visible window or the website's export.",
        );
    }
    return {
      height: Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0,
      ),
      panels: state.panels.map((el) => [el.scrollHeight, el.clientHeight]),
      fontsPending: document.fonts.status !== "loaded",
      // Same size floor as the page readiness check: tracking pixels and tiny
      // icons must not block geometry that is otherwise final.
      imagesPending: [...document.images].filter(
        (image) =>
          !image.complete &&
          image.width * image.height > 4000 &&
          state.panels.some((panel) => panel.contains(image)) &&
          image.getClientRects().length &&
          image.checkVisibility?.({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }) !== false,
      ).length,
    };
  }
  return {};
}
async function command(ctx, id, action, index, leaseMs) {
  const response = await ctx[action === "restore" ? "cleanup" : "send"](
    "Runtime.evaluate",
    {
      expression: `(${pageTask.toString()})(${JSON.stringify(action)},${JSON.stringify(id)},${JSON.stringify(index)},${JSON.stringify(leaseMs)})`,
      returnByValue: true,
    },
  );
  if (response?.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description?.split("\n")[0] ||
        "Could not prepare scrolling content",
    );
  return response?.result?.value || {};
}
async function prepare(ctx, waitForContent = async () => {}) {
  const id = crypto.randomUUID();
  sessions.set(ctx, id);
  const readinessMs = Math.min(
    60000,
    Math.max(0, Number(ctx.options?.readyTimeoutMs) || 25000),
  );
  // A live worker can legitimately wait the configured 60 seconds. Recovery
  // must not undo the page just before that allowed wait returns.
  const initial = await command(
    ctx,
    id,
    "init",
    null,
    Math.max(60000, readinessMs + 15000),
  );
  if (!initial.count) {
    sessions.delete(ctx);
    return "";
  }
  let deadline = Date.now() + readinessMs + 15000;
  for (let index = 0; index < initial.count; index++) {
    let bottom = false;
    for (let step = 0; step < 60 && Date.now() < deadline; step++) {
      const position = await command(ctx, id, "scroll", index);
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (position.bottom) {
        // Reaching the old bottom can start another page of asynchronous data.
        // Wait and check again before changing the panel's scroll geometry.
        await waitForContent();
        const loaded = await command(ctx, id, "position", index);
        if (loaded.bottom && loaded.height === position.height) {
          bottom = true;
          break;
        }
      }
    }
    if (!bottom)
      throw new Error(
        "Scrolling content keeps growing or exceeds the capture limit. Use Visible window or a smaller section.",
      );
  }
  // Scrolling and expanding panels can each start page-owned business requests.
  // Reuse the engine's readiness observer before deciding that the height is final.
  await waitForContent();
  await command(ctx, id, "expand");
  await waitForContent();
  const started = Date.now();
  deadline = started + 15000;
  let previous = "",
    stable = 0;
  while (Date.now() < deadline) {
    await command(ctx, id, "expand");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const measured = await command(ctx, id, "measure");
    const signature = JSON.stringify([measured.height, measured.panels]);
    stable =
      signature === previous &&
      measured.panels.every(([full, view]) => full <= view + 2)
        ? stable + 1
        : 0;
    previous = signature;
    if (stable < 2) continue;
    if (!measured.imagesPending && !measured.fontsPending) return "";
    // Final geometry with only media still loading: a stalled image request
    // must not fail an otherwise complete capture. Give media a bounded grace
    // period, then capture and report it.
    if (Date.now() - started >= MEDIA_GRACE_MS)
      return measured.imagesPending
        ? "Some images in scrolling areas had not finished loading."
        : "Some web fonts had not finished loading.";
  }
  if (ctx.options?.allowUnstable)
    return "Scrolling content was still changing; captured after the timeout at your request.";
  throw new Error(
    "Scrolling content did not settle in time. Wait for it to finish loading and retry.",
  );
}
async function restore(ctx) {
  const id = sessions.get(ctx);
  if (!id) return;
  sessions.delete(ctx);
  await command(ctx, id, "restore");
}

export { prepare, restore };
