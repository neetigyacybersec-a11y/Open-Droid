// ISSUE-96: the approved ADB transport boundary.
//
// Host-side argv and device-side shell arguments are different worlds. Local
// execFile arrays do not preserve boundaries after `adb shell`; every value
// that crosses into the device shell is validated by command grammar and then
// quoted as one POSIX argument. Device selection stays an argv pair, never a
// concatenated command string.
import { run, type RunOptions, type RunResult } from "./process-runner.js";

const JAVA_CLASS = "[A-Za-z_$][A-Za-z0-9_$]*";
const JAVA_QUALIFIED = `${JAVA_CLASS}(?:\\.${JAVA_CLASS})*`;
const ACTIVITY_RELATIVE_RE = new RegExp(`^\\.${JAVA_QUALIFIED}$`);
const ACTIVITY_QUALIFIED_RE = new RegExp(`^${JAVA_QUALIFIED}$`);

/** Device selection is an argv pair, not a shell fragment. */
export function adbArgs(deviceId?: string): string[] {
  return deviceId ? ["-s", deviceId] : [];
}

/** Run an adb subcommand with the same process-runner guarantees as host tools. */
export function runAdb(
  deviceId: string | undefined,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return run("adb", [...adbArgs(deviceId), ...args], options);
}

// Issue 67: adb joins everything after "shell" with spaces and the DEVICE's
// shell re-parses that string, so local execFile argument arrays do NOT
// preserve remote argument boundaries. Quote for the remote shell: wrap in
// single quotes, escaping embedded single quotes POSIX-style ('\'').
export function shquote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Issue 67: destructive remote paths must be absolute, in a test-relevant
// scope, and free of shell metacharacters and traversal.
export function validateRemotePath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("..") &&
    !/["'`\n\r;|&$<>(){}[\]#*?!~]/.test(path) &&
    /^(\/sdcard|\/storage\/emulated|\/data\/local\/tmp|\/cache|\/data\/data)\//.test(path)
  );
}

// Issue 67: intent actions ("am broadcast -a", "am start -a") and component
// names ("am startservice -n pkg/cls") have constrained grammars.
export function validateIntentAction(action: string): boolean {
  return /^[a-zA-Z0-9_.$]+$/.test(action) && action.split(".").every((part) => part.length > 0);
}

export function validateComponent(component: string): boolean {
  // Full component form: package/class, both segments non-empty.
  return /^[a-zA-Z][a-zA-Z0-9_.$]*\/[a-zA-Z][a-zA-Z0-9_.$]*$/.test(component);
}

// ISSUE-82: an activity may be shorthand (".Secondary"), a simple class
// ("Secondary"), or fully qualified inside the requested package. Resolve it to
// one canonical package/class component; anything else is rejected as data
// before it can reach the device shell.
export function resolveActivityComponent(pkg: string, activity: string): string | null {
  // Return a flattened ComponentName ("package/class"). `am start -n` parses
  // this with ComponentName.unflattenFromString, which rejects values without
  // a slash, so a bare "package.Class" would fail on the device.
  if (activity.startsWith(".")) {
    return ACTIVITY_RELATIVE_RE.test(activity) ? `${pkg}/${pkg}${activity}` : null;
  }
  if (!ACTIVITY_QUALIFIED_RE.test(activity)) return null;
  if (!activity.includes(".")) return `${pkg}/${pkg}.${activity}`;
  return activity.startsWith(`${pkg}.`) ? `${pkg}/${activity}` : null;
}
