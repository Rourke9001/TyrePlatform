// A ref callback for a layer drawn over the whole screen. What is outside it
// when it mounts goes inert, up to <body>, so nothing it covers takes focus
// (WCAG 2.4.11); an element mounted later is left alone. On unmount it clears
// only what it set.
export function inertOutside(layer: HTMLElement | null): (() => void) | undefined {
  if (layer === null) return undefined;
  const marked: Element[] = [];
  let node: HTMLElement = layer;
  while (node !== document.body && node.parentElement !== null) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      marked.push(sibling);
    }
    node = parent;
  }
  return () => {
    for (const el of marked) el.removeAttribute("inert");
  };
}
