import { icon } from './icon';

/**
 * Every panel closes.
 *
 * Panels rebuild their own innerHTML whenever they re-render, which would tear
 * out a button appended from outside. The observer puts it back, so a caller
 * only ever has to say this once.
 */
export function closeable(el: HTMLElement, close: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'panel-close';
  btn.title = 'Close';
  btn.setAttribute('aria-label', 'close');
  btn.innerHTML = icon('close', 13);
  btn.onclick = (e) => { e.stopPropagation(); close(); };

  const keep = () => { if (btn.parentElement !== el) el.appendChild(btn); };
  keep();
  new MutationObserver(keep).observe(el, { childList: true });
  return btn;
}
