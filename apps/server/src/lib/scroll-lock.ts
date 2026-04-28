let bodyScrollLockCount = 0;
let savedBodyOverflow = "";

function preventScroll(event: Event): void {
  event.preventDefault();
}

export function acquireBodyScrollLock(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  if (bodyScrollLockCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("wheel", preventScroll, { capture: true, passive: false });
    window.addEventListener("touchmove", preventScroll, { capture: true, passive: false });
  }

  bodyScrollLockCount += 1;

  return () => {
    if (typeof document === "undefined" || bodyScrollLockCount === 0) {
      return;
    }

    bodyScrollLockCount -= 1;
    if (bodyScrollLockCount === 0) {
      document.body.style.overflow = savedBodyOverflow;
      window.removeEventListener("wheel", preventScroll, { capture: true });
      window.removeEventListener("touchmove", preventScroll, { capture: true });
    }
  };
}

export function containViewportScroll(e: WheelEvent): void {
  const target = e.currentTarget as HTMLElement | null;
  if (!target) return;

  const delta = e.deltaY;
  if (delta === 0) return;

  const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1;
  const atTop = target.scrollTop <= 1;

  if ((delta > 0 && atBottom) || (delta < 0 && atTop)) {
    e.preventDefault();
  }
}