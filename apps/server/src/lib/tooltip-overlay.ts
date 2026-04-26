const TIP_SELECTOR = "[data-tip]";
const TOOLTIP_ROOT_ATTR = "data-tooltip-overlay";

type ActiveState = {
  anchor: HTMLElement;
  tooltip: HTMLDivElement;
};

let active: ActiveState | null = null;

function ensureTooltip(): HTMLDivElement {
  let tooltip = document.querySelector(".app-tooltip-overlay") as HTMLDivElement | null;
  if (tooltip) return tooltip;

  tooltip = document.createElement("div");
  tooltip.className = "app-tooltip-overlay";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tooltip);
  return tooltip;
}

function getTipText(el: HTMLElement): string {
  return (el.getAttribute("data-tip") ?? "").trim();
}

function positionTooltip(anchor: HTMLElement, tooltip: HTMLDivElement): void {
  const gap = 8;
  const rect = anchor.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  tooltip.style.visibility = "hidden";
  tooltip.style.opacity = "0";
  tooltip.style.display = "block";

  const tipRect = tooltip.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;

  let left = centerX - tipRect.width / 2;
  left = Math.max(8, Math.min(viewportW - tipRect.width - 8, left));

  const canShowAbove = rect.top >= tipRect.height + gap + 6;
  let top = canShowAbove ? rect.top - tipRect.height - gap : rect.bottom + gap;

  if (!canShowAbove && top + tipRect.height > viewportH - 6) {
    top = Math.max(6, viewportH - tipRect.height - 6);
  }

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.visibility = "visible";
  tooltip.style.opacity = "1";
}

function show(anchor: HTMLElement): void {
  const text = getTipText(anchor);
  if (!text) {
    hide();
    return;
  }

  const tooltip = ensureTooltip();
  tooltip.textContent = text;
  tooltip.setAttribute("aria-hidden", "false");

  active = { anchor, tooltip };
  positionTooltip(anchor, tooltip);
}

function hide(): void {
  if (!active) return;

  active.tooltip.style.opacity = "0";
  active.tooltip.style.visibility = "hidden";
  active.tooltip.style.display = "none";
  active.tooltip.setAttribute("aria-hidden", "true");
  active = null;
}

function handleMouseOver(event: MouseEvent): void {
  const target = (event.target as Element | null)?.closest(TIP_SELECTOR) as HTMLElement | null;
  if (!target) return;
  if (active?.anchor === target) return;
  show(target);
}

function handleMouseOut(event: MouseEvent): void {
  if (!active) return;
  const toEl = event.relatedTarget as Node | null;
  if (toEl && active.anchor.contains(toEl)) return;
  hide();
}

function handleFocusIn(event: FocusEvent): void {
  const target = (event.target as Element | null)?.closest(TIP_SELECTOR) as HTMLElement | null;
  if (!target) return;
  show(target);
}

function handleFocusOut(event: FocusEvent): void {
  if (!active) return;
  const toEl = event.relatedTarget as Node | null;
  if (toEl && active.anchor.contains(toEl)) return;
  hide();
}

function repositionActive(): void {
  if (!active) return;
  positionTooltip(active.anchor, active.tooltip);
}

export function initializeTooltipOverlay(): void {
  if (typeof document === "undefined") return;

  document.documentElement.setAttribute(TOOLTIP_ROOT_ATTR, "on");

  document.addEventListener("mouseover", handleMouseOver, true);
  document.addEventListener("mouseout", handleMouseOut, true);
  document.addEventListener("focusin", handleFocusIn, true);
  document.addEventListener("focusout", handleFocusOut, true);

  window.addEventListener("scroll", repositionActive, true);
  window.addEventListener("resize", repositionActive);
}
