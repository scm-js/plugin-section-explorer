/**
 * The plugin's words in the editor's language. `t("English", params)` translates through
 * the catalogue registered at activation (`ko.ts`); `msg("English")` marks a string kept in
 * a table or handed to the editor in English (menu labels, command titles), which
 * `translate` — or the editor — turns into the reader's language where it is shown.
 * Both take a literal: `tests/ko.test.ts` reads them from the source.
 */
import type { PluginApi } from "@scm-js/plugin-api";

export type Params = Record<string, string | number>;

let i18n: PluginApi["i18n"] | null = null;

/** Called first thing at activation, before anything is labelled. */
export function bindLanguage(api: PluginApi): void {
  i18n = api.i18n;
}

export const t = (text: string, params?: Params): string => (i18n ? i18n.t(text, params) : english(text, params));
/** A `msg()`'d value, shown in the reader's language. */
export const translate = (text: string, params?: Params): string => (i18n ? i18n.t(text, params) : english(text, params));
export const msg = (text: string): string => text;

/**
 * The English text with its placeholders filled, for when no editor is there to ask (the
 * tests): `{name}`, `{name|을}` (the particle is Korean only), and `{n, plural, …}` /
 * `{x, select, …}` with `=0`, `one` and `other` branches.
 */
function english(text: string, params: Params = {}): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") { out += text[i]; continue; }
    const end = closing(text, i);
    const body = text.slice(i + 1, end);
    i = end;
    const m = /^(\w+)\s*,\s*(plural|select)\s*,([\s\S]*)$/.exec(body);
    if (!m) { const v = params[body.split("|")[0].trim()]; out += v === undefined ? `{${body}}` : String(v); continue; }
    const value = params[m[1]];
    const branches = new Map<string, string>();
    for (let rest = m[3]; rest.trim(); ) {
      const k = /^\s*(=?\w+)\s*\{/.exec(rest);
      if (!k) break;
      const open = k[0].length - 1;
      const close = closing(rest, open);
      branches.set(k[1], rest.slice(open + 1, close));
      rest = rest.slice(close + 1);
    }
    const pick = m[2] === "plural"
      ? branches.get(`=${value}`) ?? (value === 1 ? branches.get("one") : undefined) ?? branches.get("other")
      : branches.get(String(value)) ?? branches.get("other");
    out += english((pick ?? "").replace(/#/g, String(value)), params);
  }
  return out;
}

function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return s.length;
}
