"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface Me {
  githubUsername: string;
  displayName: string;
  avatarUrl: string;
  hasCustomAvatar: boolean;
  hasMcpKey: boolean;
  hasPin: boolean;
  version: string;
}

type Theme = "light" | "dark";

const INPUT_CLASS =
  "w-full rounded-xl px-3 py-2.5 text-sm transition-colors focus:outline-hidden";
const INPUT_STYLE: React.CSSProperties = {
  background: "var(--input-bg)",
  border: "1px solid var(--gold-low)",
  color: "var(--fg)",
};
const CARD_STYLE: React.CSSProperties = {
  background: "var(--card-bg)",
  border: "1px solid var(--gold-faint)",
};

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem("xkg-theme") ?? localStorage.getItem("xmu-theme") ?? localStorage.getItem("mnemos-theme");
    if (stored === "dark" || stored === "light") return stored;
  } catch { /* private mode */ }
  if (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark") {
    return "dark";
  }
  return "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("xkg-theme", theme); } catch { /* ignore */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#11131A" : "#F2F1F6");
}

function mcpCommand(key: string): string {
  return `npx -y @xmu-labs/xkg@latest serve-mcp --key ${key}`;
}

function compressAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const size = 192;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Could not process image."));
        return;
      }
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image."));
    };
    img.src = url;
  });
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-[10px] font-medium uppercase tracking-widest px-1 mb-2" style={{ color: "var(--gold)" }}>
      {children}
    </p>
  );
}

export default function SettingsDrawer({
  me,
  onMe,
  newVersionAvailable,
}: {
  me: Me | null;
  onMe: (me: Me) => void;
  newVersionAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document === "undefined" ? "light" : readTheme(),
  );
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const openedFromPop = useRef(false);

  const [displayName, setDisplayName] = useState("");
  const [profileStatus, setProfileStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [profileError, setProfileError] = useState("");

  const [mcpKey, setMcpKey] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<"idle" | "loading" | "error">("idle");
  const [keyError, setKeyError] = useState("");
  const [copied, setCopied] = useState(false);

  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinStatus, setPinStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [pinError, setPinError] = useState("");

  const [signingOut, setSigningOut] = useState(false);

  const cleanup = useCallback(() => {
    setMcpKey(null);
    setKeyError("");
    setKeyStatus("idle");
    setCopied(false);
    setCurrentPin("");
    setNewPin("");
    setConfirmPin("");
    setPinError("");
    setPinStatus("idle");
    setProfileError("");
    setProfileStatus("idle");
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const close = useCallback(() => {
    cleanup();
    setVisible(false);
    window.setTimeout(() => setOpen(false), 200);
    if (openedFromPop.current && window.history.state?.xkgDrawer) {
      openedFromPop.current = false;
      window.history.back();
    }
  }, [cleanup]);

  const openDrawer = useCallback(() => {
    setDisplayName(me?.displayName ?? "");
    setOpen(true);
    requestAnimationFrame(() => setVisible(true));
    openedFromPop.current = true;
    window.history.pushState({ xkgDrawer: true }, "");
  }, [me]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function onPop() {
      openedFromPop.current = false;
      cleanup();
      setVisible(false);
      window.setTimeout(() => setOpen(false), 200);
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
    };
  }, [open, close, cleanup]);

  function chooseTheme(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  async function saveName() {
    setProfileStatus("saving");
    setProfileError("");
    try {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onMe(await res.json() as Me);
      setProfileStatus("saved");
      window.setTimeout(() => setProfileStatus("idle"), 1500);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Could not save name");
      setProfileStatus("error");
    }
  }

  async function onPickAvatar(file: File | undefined) {
    if (!file) return;
    setProfileStatus("saving");
    setProfileError("");
    try {
      const avatarData = await compressAvatar(file);
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarData }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onMe(await res.json() as Me);
      setProfileStatus("saved");
      window.setTimeout(() => setProfileStatus("idle"), 1500);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Could not save photo");
      setProfileStatus("error");
    }
  }

  async function resetAvatar() {
    setProfileStatus("saving");
    setProfileError("");
    try {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarData: null }),
      });
      if (!res.ok) throw new Error("Could not reset photo");
      onMe(await res.json() as Me);
      setProfileStatus("idle");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Could not reset photo");
      setProfileStatus("error");
    }
  }

  async function handleGenerateKey() {
    if (!window.confirm("Generate a new MCP key? Any existing key will immediately stop working.")) return;
    setKeyStatus("loading");
    setKeyError("");
    try {
      const res = await fetch("/api/rotate-key", { method: "POST" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { apiKey: string };
      setMcpKey(data.apiKey);
      setKeyStatus("idle");
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to generate key");
      setKeyStatus("error");
    }
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }

  async function handleChangePin() {
    if (newPin !== confirmPin) {
      setPinStatus("error");
      setPinError("New PIN and confirmation do not match.");
      return;
    }
    setPinStatus("saving");
    setPinError("");
    try {
      const res = await fetch("/api/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPin, newPin }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setCurrentPin("");
      setNewPin("");
      setConfirmPin("");
      setPinStatus("saved");
      window.setTimeout(() => setPinStatus("idle"), 1500);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "Could not change PIN");
      setPinStatus("error");
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  }

  const avatar = me?.avatarUrl;

  return (
    <>
      <button
        type="button"
        onClick={openDrawer}
        aria-label="Open settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="ml-auto shrink-0 rounded-full overflow-hidden transition-opacity"
        style={{
          width: 36,
          height: 36,
          background: "var(--card-bg)",
          border: "1px solid var(--gold-low)",
          opacity: 0.95,
        }}
      >
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" width={36} height={36} className="w-full h-full object-cover" />
        ) : (
          <span className="flex items-center justify-center w-full h-full" style={{ color: "var(--fg-muted)" }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" />
            </svg>
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-80" role="presentation">
          <div
            className="absolute inset-0"
            onClick={close}
            aria-hidden="true"
            style={{
              background: "var(--scrim)",
              opacity: visible ? 1 : 0,
              transition: `opacity var(--motion-fast) var(--ease-out)`,
            }}
          />
          <aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="absolute top-0 right-0 h-full flex flex-col"
            style={{
              width: "min(100%, 22rem)",
              background: "var(--bg)",
              boxShadow: "var(--drawer-shadow)",
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "env(safe-area-inset-bottom)",
              transform: visible ? "translateX(0)" : "translateX(100%)",
              transition: `transform var(--motion-medium) var(--ease-out)`,
            }}
          >
            <header className="flex items-center justify-between px-5 h-14 shrink-0"
              style={{ borderBottom: "1px solid var(--gold-faint)" }}>
              <h2 id={titleId} className="text-sm font-semibold tracking-tight" style={{ color: "var(--fg)" }}>
                Settings
              </h2>
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                aria-label="Close settings"
                className="p-2 -mr-2 rounded-lg"
                style={{ color: "var(--fg-muted)" }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-5 stack-8">
              {/* 1. Account */}
              <section>
                <SectionLabel>Account</SectionLabel>
                <div className="rounded-2xl p-4 stack-4" style={CARD_STYLE}>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      aria-label="Change photo"
                      className="relative rounded-full overflow-hidden shrink-0"
                      style={{ width: 56, height: 56, border: "1px solid var(--gold-low)" }}
                    >
                      {avatar ? (
                        <img src={avatar} alt="" width={56} height={56} className="w-full h-full object-cover" />
                      ) : (
                        <span className="flex items-center justify-center w-full h-full text-xs" style={{ color: "var(--fg-muted)" }}>
                          Photo
                        </span>
                      )}
                    </button>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--fg)" }}>
                        {me?.displayName ?? "—"}
                      </p>
                      <p className="text-xs truncate" style={{ color: "var(--fg-muted)" }}>
                        @{me?.githubUsername ?? ""}
                      </p>
                      <div className="flex gap-3 mt-1">
                        <button type="button" onClick={() => fileRef.current?.click()}
                          className="text-xs font-medium" style={{ color: "var(--gold)" }}>
                          Add photo
                        </button>
                        {me?.hasCustomAvatar && (
                          <button type="button" onClick={() => void resetAvatar()}
                            className="text-xs" style={{ color: "var(--fg-muted)" }}>
                            Use GitHub
                          </button>
                        )}
                      </div>
                    </div>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic"
                      className="hidden"
                      onChange={(e) => void onPickAvatar(e.target.files?.[0])}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium uppercase tracking-widest mb-1.5"
                      style={{ color: "var(--fg-muted)" }}>
                      Name
                    </label>
                    <input
                      type="text"
                      value={displayName}
                      maxLength={40}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className={INPUT_CLASS}
                      style={INPUT_STYLE}
                    />
                    <button
                      type="button"
                      onClick={() => void saveName()}
                      disabled={profileStatus === "saving" || !displayName.trim() || displayName.trim() === me?.displayName}
                      className="mt-2 text-sm font-medium rounded-xl px-3 py-2 transition-opacity disabled:opacity-30"
                      style={{ background: "var(--btn)", color: "var(--btn-fg)" }}
                    >
                      {profileStatus === "saving" ? "Saving…" : profileStatus === "saved" ? "Saved" : "Save name"}
                    </button>
                    {profileStatus === "error" && (
                      <p className="text-xs mt-2" style={{ color: "var(--danger)" }}>{profileError}</p>
                    )}
                  </div>
                </div>
              </section>

              {/* 2. Credentials */}
              <section>
                <SectionLabel>Credentials</SectionLabel>
                <div className="rounded-2xl p-4 stack-5" style={CARD_STYLE}>
                  <div>
                    <p className="text-sm font-medium mb-1" style={{ color: "var(--fg)" }}>Connect with your AI worker</p>
                    <p className="text-xs leading-relaxed mb-3" style={{ color: "var(--fg-muted)" }}>
                      Generate an MCP key to use xkg from terminal. This action rotates your key — any existing one stops working.
                    </p>
                    {!mcpKey ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleGenerateKey()}
                          disabled={keyStatus === "loading"}
                          className="text-sm font-medium rounded-xl px-3 py-2 transition-opacity disabled:opacity-40"
                          style={{ background: "transparent", border: "1px solid var(--gold-mid)", color: "var(--fg)" }}
                        >
                          {keyStatus === "loading" ? "Generating…" : "Generate MCP key"}
                        </button>
                        {keyStatus === "error" && (
                          <p className="text-xs mt-2" style={{ color: "var(--danger)" }}>{keyError}</p>
                        )}
                      </>
                    ) : (
                      <div className="stack-3">
                        <div>
                          <p className="text-[10px] font-medium uppercase tracking-widest mb-1" style={{ color: "var(--gold)" }}>
                            Your new API key
                          </p>
                          <code className="text-xs block p-2 rounded-lg break-all" style={{ background: "var(--input-bg)", color: "var(--fg-muted)" }}>
                            {mcpKey}
                          </code>
                          <p className="text-[10px] mt-1" style={{ color: "var(--fg-muted)" }}>
                            Save this — it will not be shown again. Closing settings discards it.
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] font-medium uppercase tracking-widest mb-1" style={{ color: "var(--gold)" }}>
                            Add to your worker
                          </p>
                          <code className="text-xs block p-2 rounded-lg break-all" style={{ background: "var(--input-bg)", color: "var(--fg-muted)" }}>
                            {mcpCommand(mcpKey)}
                          </code>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCopy(mcpCommand(mcpKey))}
                          className="text-sm font-medium rounded-xl px-3 py-2"
                          style={{ background: "transparent", border: "1px solid var(--gold-mid)", color: "var(--fg)" }}
                        >
                          {copied ? "Copied" : "Copy command"}
                        </button>
                      </div>
                    )}
                  </div>

                  <div style={{ borderTop: "1px solid var(--gold-faint)", paddingTop: 16 }}>
                    <p className="text-sm font-medium mb-1" style={{ color: "var(--fg)" }}>Change PIN</p>
                    <p className="text-xs mb-3" style={{ color: "var(--fg-muted)" }}>
                      Quick unlock on this device. Minimum 6 characters.
                    </p>
                    <div className="stack-2">
                      <input type="password" autoComplete="current-password" placeholder="Current PIN"
                        value={currentPin} onChange={(e) => setCurrentPin(e.target.value)}
                        className={INPUT_CLASS} style={INPUT_STYLE} />
                      <input type="password" autoComplete="new-password" placeholder="New PIN"
                        value={newPin} onChange={(e) => setNewPin(e.target.value)}
                        className={INPUT_CLASS} style={INPUT_STYLE} />
                      <input type="password" autoComplete="new-password" placeholder="Confirm new PIN"
                        value={confirmPin} onChange={(e) => setConfirmPin(e.target.value)}
                        className={INPUT_CLASS} style={INPUT_STYLE} />
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleChangePin()}
                      disabled={pinStatus === "saving" || !currentPin || !newPin || !confirmPin}
                      className="mt-2 text-sm font-medium rounded-xl px-3 py-2 disabled:opacity-30"
                      style={{ background: "transparent", border: "1px solid var(--gold-mid)", color: "var(--fg)" }}
                    >
                      {pinStatus === "saving" ? "Updating…" : pinStatus === "saved" ? "PIN updated" : "Update PIN"}
                    </button>
                    {pinStatus === "error" && (
                      <p className="text-xs mt-2" style={{ color: "var(--danger)" }}>{pinError}</p>
                    )}
                  </div>
                </div>
              </section>

              {/* 3. System */}
              <section>
                <SectionLabel>System</SectionLabel>
                <div className="rounded-2xl p-4 stack-4" style={CARD_STYLE}>
                  <div>
                    <p className="text-sm font-medium mb-2" style={{ color: "var(--fg)" }}>Theme</p>
                    <div className="grid grid-cols-2 gap-2">
                      {(["light", "dark"] as const).map((value) => {
                        const active = theme === value;
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => chooseTheme(value)}
                            aria-pressed={active}
                            className="rounded-xl py-2 text-sm font-medium capitalize"
                            style={{
                              background: active ? "var(--gold)" : "transparent",
                              color: active ? "var(--btn-fg)" : "var(--fg)",
                              border: `1px solid ${active ? "var(--gold)" : "var(--gold-mid)"}`,
                            }}
                          >
                            {value}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ borderTop: "1px solid var(--gold-faint)", paddingTop: 16 }}>
                    <p className="text-sm font-medium" style={{ color: "var(--fg)" }}>Version</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--fg-muted)" }}>
                      {me?.version ?? "—"}
                    </p>
                    {newVersionAvailable ? (
                      <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="mt-2 text-sm font-medium rounded-xl px-3 py-2"
                        style={{ background: "var(--btn)", color: "var(--btn-fg)" }}
                      >
                        Update to latest
                      </button>
                    ) : (
                      <p className="text-xs mt-2" style={{ color: "var(--fg-muted)" }}>
                        You are on the latest version.
                      </p>
                    )}
                  </div>
                </div>
              </section>

              {/* 4. Session */}
              <section>
                <SectionLabel>Session</SectionLabel>
                <div className="rounded-2xl p-4" style={CARD_STYLE}>
                  <button
                    type="button"
                    onClick={() => void handleSignOut()}
                    disabled={signingOut}
                    className="w-full text-sm font-medium rounded-xl py-2.5"
                    style={{ color: "var(--danger)", border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)" }}
                  >
                    {signingOut ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              </section>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
