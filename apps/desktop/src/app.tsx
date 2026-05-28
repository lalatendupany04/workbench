import { Dashboard, setApiBase } from "@getworkbench/core/ui";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import * as React from "react";
import { Settings } from "./chrome/settings";
import { TitleBar } from "./chrome/title-bar";
import { type AppPhase, type ConnectionForm, defaultForm } from "./lib/state";
import {
  loadLastConnection,
  type SavedConnection,
  saveLastConnection,
} from "./lib/store";
import {
  type AppError,
  type ConnectResult,
  clearSavedPassword,
  loadSavedPassword,
  connect as tauriConnect,
  disconnect as tauriDisconnect,
  ping as tauriPing,
} from "./lib/tauri";
import { pushToast } from "./lib/toasts";
import { scheduleUpdateChecks } from "./lib/updates";
import { Connect } from "./onboarding/connect";
import { Connecting } from "./onboarding/connecting";
import { ErrorPanel } from "./onboarding/error-panel";
import { Welcome } from "./onboarding/welcome";

export function App(): JSX.Element {
  const [phase, setPhase] = React.useState<AppPhase>({ kind: "idle" });
  const [form, setForm] = React.useState<ConnectionForm>(defaultForm);
  const [auto, setAuto] = React.useState<boolean>(true);
  const [settingsOpen, setSettingsOpen] = React.useState<boolean>(false);

  // ── Auto-reconnect on launch ──────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      const saved = await loadLastConnection();
      if (cancelled) return;
      if (!saved) {
        setPhase({ kind: "welcome" });
        setAuto(false);
        return;
      }
      // We have a prior connection. Pull the password from the OS keychain
      // in parallel — the URL/username live in the plaintext store but the
      // secret stays in Keychain/Credential Manager/Secret Service.
      const savedPassword = await loadSavedPassword();
      if (cancelled) return;
      // Prefill the form so a failed auto-reconnect drops to a populated
      // Connect form rather than an empty one.
      setForm({
        ...defaultForm,
        url: saved.url,
        prefix: saved.prefix ?? "bull",
        username: saved.username ?? "",
        password: savedPassword ?? "",
        maxQueues: saved.maxQueues ?? 100,
        rememberPassword: true,
      });
      await runConnect(saved.url, {
        prefix: saved.prefix,
        username: saved.username,
        password: savedPassword ?? undefined,
        maxQueues: saved.maxQueues,
      });
      setAuto(false);
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally run this once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Updater + sidecar-crash listener ──────────────────────────────────────
  React.useEffect(() => {
    const cleanupUpdates = scheduleUpdateChecks();
    const unlistenP = listen("workbench://sidecar-crashed", () => {
      setPhase({ kind: "stale" });
      pushToast({
        id: "sidecar-crashed",
        title: "Backend stopped",
        description: "The connection to Redis was lost.",
        variant: "error",
        dismissible: true,
        action: {
          label: "Reconnect",
          onClick: () => {
            void runConnect(form.url, formExtras(form));
          },
        },
      });
    });
    return () => {
      cleanupUpdates();
      unlistenP.then((un) => un()).catch(() => {});
    };
    // form.url is read inside the toast callback at the time it's clicked,
    // so we capture the latest via the ref pattern below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep a ref to the latest form so async callbacks pick up the current
  // value without forcing a re-listen on every keystroke.
  const formRef = React.useRef(form);
  React.useEffect(() => {
    formRef.current = form;
  }, [form]);

  async function runConnect(
    url: string,
    extras?: Partial<SavedConnection> & { password?: string },
  ): Promise<void> {
    setPhase({ kind: "pinging" });
    try {
      await tauriPing(url);
    } catch (e) {
      const pingError = e as AppError;
      if (!shouldProceedAfterPingFailure(pingError)) {
        setPhase({ kind: "failed", stage: "ping", error: pingError });
        return;
      }
    }

    // Prefer an explicit password override (auto-reconnect path) over the
    // current form value. Empty string would tell Rust to clear the
    // keychain entry, so coerce to undefined.
    const password =
      (extras?.password ?? formRef.current.password) || undefined;

    setPhase({ kind: "connecting", pingDone: true });
    let result: ConnectResult;
    try {
      result = await tauriConnect({
        redisUrl: url,
        prefix: (extras?.prefix ?? formRef.current.prefix) || undefined,
        username: (extras?.username ?? formRef.current.username) || undefined,
        password,
        maxQueues: extras?.maxQueues ?? formRef.current.maxQueues,
        rememberPassword: formRef.current.rememberPassword,
      });
    } catch (e) {
      setPhase({ kind: "failed", stage: "connect", error: e as AppError });
      return;
    }

    setApiBase(`http://127.0.0.1:${result.port}`);
    setPhase({
      kind: "ready",
      port: result.port,
      queues: result.queues,
      discoveryTotal: result.discoveryTotal,
      discoveryCapped: result.discoveryCapped,
    });

    // Warn the user when the password didn't make it to the keychain —
    // otherwise the next launch silently fails to auto-reconnect and the
    // user wonders why "Remember password" didn't take. We only nag when
    // they had a non-empty password (no point complaining about saving "").
    if (
      result.passwordSaved === false &&
      formRef.current.rememberPassword &&
      formRef.current.password.length > 0
    ) {
      pushToast({
        id: "password-not-saved",
        title: "Password not saved",
        description:
          result.passwordSaveError ??
          "No system keychain is available on this machine.",
        variant: "warning",
        dismissible: true,
      });
    }

    await saveLastConnection({
      url,
      prefix: (extras?.prefix ?? formRef.current.prefix) || undefined,
      username: (extras?.username ?? formRef.current.username) || undefined,
      maxQueues: extras?.maxQueues ?? formRef.current.maxQueues,
      lastConnectedAt: Date.now(),
    });
  }

  const onSubmitConnect = (): void => {
    void runConnect(form.url, formExtras(form));
  };

  const onSwitchConnection = async (): Promise<void> => {
    await tauriDisconnect().catch(() => {});
    // Forget the saved password too — "Switch" means the user explicitly
    // wants a clean slate. The store entry stays so the URL still
    // prefills on the next connect screen.
    await clearSavedPassword();
    setApiBase(null);
    // Reset password field so the cleared keychain matches the UI state.
    setForm((f) => ({ ...f, password: "" }));
    setPhase({ kind: "welcome" });
  };

  const status = describeStatus(phase);
  // During the initial auto-reconnect attempt, show a minimal splash rather
  // than flashing the full "Connecting" pills — most reconnects succeed in
  // <500 ms and the pills feel like noise.
  const showChromeOnly =
    auto && (phase.kind === "pinging" || phase.kind === "connecting");

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TitleBar
        status={status}
        busy={phase.kind === "pinging" || phase.kind === "connecting"}
        onSwitchConnection={
          phase.kind === "ready" || phase.kind === "stale"
            ? onSwitchConnection
            : undefined
        }
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="relative flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {phase.kind === "idle" || showChromeOnly ? (
            <Splash key="splash" />
          ) : phase.kind === "welcome" ? (
            <Screen key="welcome">
              <Welcome onContinue={() => setPhase({ kind: "connect" })} />
            </Screen>
          ) : phase.kind === "connect" ? (
            <Screen key="connect">
              <Connect
                form={form}
                onChange={setForm}
                onSubmit={onSubmitConnect}
                hasError={null}
              />
            </Screen>
          ) : phase.kind === "pinging" || phase.kind === "connecting" ? (
            <Screen key="connecting">
              <Connecting
                pingState={phase.kind === "connecting" ? "done" : "active"}
                connectState={
                  phase.kind === "connecting" ? "active" : "pending"
                }
                openState="pending"
              />
            </Screen>
          ) : phase.kind === "failed" ? (
            <Screen key="failed">
              <div className="grid h-full grid-rows-[auto_1fr] gap-2 overflow-y-auto py-6">
                <ErrorPanel
                  error={phase.error}
                  onRetry={() => void runConnect(form.url, formExtras(form))}
                  onEdit={() => setPhase({ kind: "connect" })}
                />
                <div className="border-t border-border pt-2">
                  <Connect
                    form={form}
                    onChange={setForm}
                    onSubmit={onSubmitConnect}
                    hasError={phase.error}
                  />
                </div>
              </div>
            </Screen>
          ) : phase.kind === "ready" ? (
            <Screen key="ready">
              <Dashboard />
              {phase.discoveryCapped && phase.discoveryTotal !== null && (
                <CapNotice shown={phase.queues} total={phase.discoveryTotal} />
              )}
            </Screen>
          ) : phase.kind === "stale" ? (
            <Screen key="stale">
              <StaleOverlay
                onReconnect={() => void runConnect(form.url, formExtras(form))}
              />
            </Screen>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {settingsOpen && (
            <Settings
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function shouldProceedAfterPingFailure(error: AppError): boolean {
  const msg = (error.message || "").toLowerCase();
  if (error.code === "REDIS_TLS" || error.code === "REDIS_TIMEOUT") {
    return true;
  }
  if (
    (error.code === "UNKNOWN" || error.code === "REDIS_REFUSED") &&
    msg.includes("connection is closed")
  ) {
    return true;
  }
  return false;
}

function Splash(): JSX.Element {
  return (
    <motion.div
      key="splash"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="flex h-full items-center justify-center"
    >
      <div className="text-sm text-muted-foreground">Loading…</div>
    </motion.div>
  );
}

function Screen({
  children,
  ...rest
}: { children: React.ReactNode } & React.ComponentProps<
  typeof motion.div
>): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="absolute inset-0"
      {...rest}
    >
      {children}
    </motion.div>
  );
}

function StaleOverlay({
  onReconnect,
}: {
  onReconnect: () => void;
}): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <h2 className="text-lg font-semibold">Backend stopped</h2>
        <p className="text-sm text-muted-foreground">
          The connection to Redis was lost. Reconnect to resume.
        </p>
        <button
          type="button"
          onClick={onReconnect}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Reconnect
        </button>
      </div>
    </div>
  );
}

function CapNotice({
  shown,
  total,
}: {
  shown: number;
  total: number;
}): JSX.Element {
  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-md backdrop-blur">
      Showing first {shown} of {total} queues — change in Advanced.
    </div>
  );
}

function describeStatus(phase: AppPhase): string | undefined {
  switch (phase.kind) {
    case "pinging":
      return "Checking Redis…";
    case "connecting":
      return "Starting backend…";
    case "ready":
      return `${phase.queues} queue${phase.queues === 1 ? "" : "s"}`;
    case "stale":
      return "Disconnected";
    default:
      return undefined;
  }
}

function formExtras(form: ConnectionForm): Partial<SavedConnection> {
  return {
    prefix: form.prefix || undefined,
    username: form.username || undefined,
    maxQueues: form.maxQueues,
  };
}
