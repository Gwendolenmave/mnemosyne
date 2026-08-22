/**
 * T05B/T05C — the systemd adapter for `SchedulerPort` (LM-GATE-01 amendment A).
 *
 * systemd is ONE way to make a job recur. Core never names it: core declares a
 * `ScheduledJob` and this module renders it. The consequence that matters is that
 * a container, a Mac, or a future runtime is a new file next to this one rather
 * than an edit to the backup logic.
 *
 * The unit text is produced by a PURE function so the schedule can be asserted in
 * a test without installing anything, and so a review can read exactly what will
 * be written into the operator's home directory.
 *
 * Two properties are deliberate rather than default:
 *
 *   `Persistent=true`     — Owner's machine is a laptop that is asleep at 04:15. A
 *                           timer without this silently skips every night the
 *                           machine was off, and the operator discovers it during
 *                           a restore. With it, the job runs on the next wake.
 *   `TimeoutStartSec`     — a backup that hangs must die and alert, not sit holding
 *                           a staging directory until someone notices next month.
 *
 * The second one was `RuntimeMaxSec` first, and systemd said so out loud on the
 * very first run: "RuntimeMaxSec= has no effect in combination with Type=oneshot.
 * Ignoring." The bound existed in the unit, read correctly to a human, and bounded
 * nothing. For `Type=oneshot` the whole run is the *start* job, so
 * `TimeoutStartSec` is the directive that actually kills a hung backup. Worth
 * recording rather than quietly correcting: it is the same defect this programme
 * keeps finding — a guard that cannot fail because it is never consulted.
 */

import type { ScheduledJob } from "../../core/ports/backup-ports.js";

export const BACKUP_JOB: ScheduledJob = {
  id: "delos-backup",
  description: "Delos nightly backup: snapshot, encrypt, and prove by isolated restore",
  schedule: "daily@04:15",
  catchUpMissed: true,
  timeoutSeconds: 30 * 60,
};

export interface RenderedUnits {
  readonly serviceName: string;
  readonly timerName: string;
  readonly serviceUnit: string;
  readonly timerUnit: string;
}

/** `daily@HH:MM` and `hourly:MM` are the two forms core is allowed to declare. */
export function toOnCalendar(schedule: string): string {
  const daily = /^daily@(\d{2}):(\d{2})$/.exec(schedule);
  if (daily !== null) return `*-*-* ${daily[1]}:${daily[2]}:00`;
  const hourly = /^hourly:(\d{2})$/.exec(schedule);
  if (hourly !== null) return `*-*-* *:${hourly[1]}:00`;
  throw new Error(`unsupported schedule "${schedule}" (expected daily@HH:MM or hourly:MM)`);
}

export function systemdUserTimerUnits(
  job: ScheduledJob,
  options: { readonly workingDirectory: string; readonly execStart: string },
): RenderedUnits {
  const serviceName = `${job.id}.service`;
  const timerName = `${job.id}.timer`;
  const serviceUnit = [
    "[Unit]",
    `Description=${job.description}`,
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${options.workingDirectory}`,
    `ExecStart=${options.execStart}`,
    // For Type=oneshot the entire run IS the start job, so this — not
    // RuntimeMaxSec — is the directive that bounds it.
    `TimeoutStartSec=${job.timeoutSeconds}`,
    // A failed backup must be visible in `systemctl --user status`, and must NOT
    // be retried in a tight loop: the next scheduled run is the retry.
    "Restart=no",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
  ].join("\n");
  const timerUnit = [
    "[Unit]",
    `Description=${job.description} (timer)`,
    "",
    "[Timer]",
    `OnCalendar=${toOnCalendar(job.schedule)}`,
    `Persistent=${job.catchUpMissed ? "true" : "false"}`,
    "AccuracySec=1min",
    "RandomizedDelaySec=5min",
    `Unit=${serviceName}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { serviceName, timerName, serviceUnit, timerUnit };
}
