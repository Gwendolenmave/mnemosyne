/**
 * Deterministic Asia/Shanghai time labels (DELOS-TG-TIME-AWARENESS-REGRESSION-01).
 *
 * Root cause fixed here: renderers sliced canonical-UTC ISO strings into naive
 * datetimes ("2026-07-19 23:29") and presented them as if local, so a message
 * sent 07:29 +08 read as "昨晚 23:29" to the model. From now on every instant
 * shown to the model carries an explicit +08:00 local stamp plus a CODE-
 * COMPUTED elapsed label and local-date relation — the model never does time
 * arithmetic itself. Storage stays canonical UTC; nothing is migrated.
 *
 * Semantic constraints (fixed):
 *  - within 30 minutes → 刚才/刚刚 family;
 *  - 今天早上 only = the SAME local date, morning hours;
 *  - 昨天 only = the previous local date;
 *  - 昨晚/昨夜 only = the previous local date's evening/night (17:00-23:59).
 * Asia/Shanghai is fixed UTC+8 (no DST) — pure arithmetic, server-TZ-免疫,
 * identical across midnights and restarts.
 */

export const SHANGHAI_OFFSET_MS = 8 * 3600000;
const DAY_MS = 86400000;

export interface LocalParts {
  /** "YYYY-MM-DD HH:mm:ss +08:00" — always explicit offset, never naive. */
  stamp: string;
  /** Local calendar date "YYYY-MM-DD". */
  localDate: string;
  /** Local "HH:mm". */
  localClock: string;
  hour: number;
}

export function localParts(iso: string): LocalParts | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const l = new Date(t + SHANGHAI_OFFSET_MS).toISOString();
  return {
    stamp: `${l.slice(0, 10)} ${l.slice(11, 19)} +08:00`,
    localDate: l.slice(0, 10),
    localClock: l.slice(11, 16),
    hour: Number(l.slice(11, 13)),
  };
}

function daySegment(hour: number): string {
  if (hour < 5) return "凌晨";
  if (hour < 11) return "早上";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  return "晚上";
}

/** Local-date relation, per the fixed semantic constraints. */
export function dateRelation(iso: string, nowIso: string): string {
  const p = localParts(iso);
  const n = localParts(nowIso);
  if (p === null || n === null) return "时间未知";
  const dayDiff = Math.round(
    (Date.parse(`${n.localDate}T00:00:00Z`) - Date.parse(`${p.localDate}T00:00:00Z`)) / DAY_MS,
  );
  const seg = daySegment(p.hour);
  if (dayDiff === 0) return `今天${seg}`;
  if (dayDiff === 1) return seg === "晚上" ? "昨晚" : `昨天${seg}`;
  if (dayDiff === 2) return `前天${seg}`;
  return `${p.localDate}(${dayDiff} 天前)`;
}

/** Code-computed elapsed label; the model must never derive this itself. */
export function elapsedLabel(iso: string, nowIso: string): string {
  const t = Date.parse(iso);
  const n = Date.parse(nowIso);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return "间隔未知";
  const min = Math.max(0, Math.round((n - t) / 60000));
  if (min < 2) return "刚刚";
  if (min < 30) return `${min} 分钟前(刚才)`;
  if (min < 60) return `${min} 分钟前`;
  if (min < 48 * 60) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 1440)} 天前`;
}

/** Full annotation: "2026-07-20 07:29:00 +08:00 · 6 分钟前(刚才) · 今天早上". */
export function timeAnnotation(iso: string | null | undefined, nowIso: string | null | undefined): string {
  if (iso == null) return "time ?";
  const p = localParts(iso);
  if (p === null) return "time ?";
  if (nowIso == null) return p.stamp;
  return `${p.stamp} · ${elapsedLabel(iso, nowIso)} · ${dateRelation(iso, nowIso)}`;
}
