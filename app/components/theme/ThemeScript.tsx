/**
 * Blocking, pre-paint theme resolution.
 *
 * This MUST run before the browser's first paint, which is why it is an inline
 * <script> in <head> and not a useEffect. If theme resolution waited for React
 * hydration, every visitor whose stored preference differs from the CSS default
 * would see a full-page flash of the wrong theme — the single most common
 * dark-mode implementation bug, and one that reads as broken on a finance tool.
 *
 * Resolution order: explicit stored choice -> OS preference -> dark (product
 * default; the design system flags light-mode-default as an anti-pattern for
 * data-dense analytics surfaces).
 *
 * It sets the attribute and nothing else: the colour transition is applied by
 * the toggle at swap time (.theme-switching), so first paint never animates.
 */
export const THEME_STORAGE_KEY = "defidesh-theme";

const SCRIPT = `(function(){try{
var k=${JSON.stringify(THEME_STORAGE_KEY)};
var s=localStorage.getItem(k);
var t=(s==="light"||s==="dark")?s:(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");
var r=document.documentElement;
r.setAttribute("data-theme",t);
r.style.colorScheme=t;

}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export default function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
