/** The demo button enlarges fixed Stage3D viewports together with their display-list overlay. */
export function bindFullscreen(
  stage: HTMLElement,
  player: HTMLElement,
  button: HTMLButtonElement,
  composed: () => boolean,
  refused: () => void,
): void {
  let width = 0;
  let height = 0;
  let requesting = false;
  const clear = () => {
    width = height = 0;
    stage.classList.remove("composed-fullscreen");
    stage.style.removeProperty("--fullscreen-width");
    stage.style.removeProperty("--fullscreen-height");
    stage.style.removeProperty("--fullscreen-scale");
  };
  const fit = () => {
    if (!width || !height || document.fullscreenElement !== stage) {
      return;
    }

    stage.style.setProperty(
      "--fullscreen-scale",
      String(Math.min(stage.clientWidth / width, stage.clientHeight / height)),
    );
  };
  new ResizeObserver(fit).observe(stage);
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === stage) {
      fit();
    } else {
      clear();
    }
  });
  button.addEventListener("click", async () => {
    if (requesting || document.fullscreenElement === stage) {
      return;
    }

    requesting = true;
    if (composed()) {
      // Preserve the SWF's viewport while the browser enlarges every composed
      // canvas; resizing only the overlay leaves fixed GPU viewports behind.
      width = Math.max(1, player.clientWidth);
      height = Math.max(1, player.clientHeight);
      stage.style.setProperty("--fullscreen-width", `${width}px`);
      stage.style.setProperty("--fullscreen-height", `${height}px`);
      stage.classList.add("composed-fullscreen");
    }

    try {
      await stage.requestFullscreen();
      if (!player.hidden) {
        player.focus();
      }
    } catch {
      clear();
      refused();
    } finally {
      requesting = false;
    }
  });
}
