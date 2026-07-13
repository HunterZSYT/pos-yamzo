import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Cloud,
  ExternalLink,
  FileSpreadsheet,
  Mail,
  RefreshCw,
  ShieldCheck,
  Unplug
} from "lucide-react";
import type {
  EmailSettings,
  GoogleSheetTabOption,
  GoogleSheetsSettings,
  GoogleSpreadsheetOption
} from "../../shared/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { Separator } from "@/components/ui/separator";

type BusyAction =
  | "load"
  | "credentials"
  | "connect"
  | "disconnect"
  | "discover"
  | "tabs"
  | "mapping"
  | "sync"
  | "report"
  | "email"
  | "preview"
  | "send"
  | "";

const defaultEmail: EmailSettings = {
  enabled: false,
  recipientEmail: "",
  sendDailySummary: true,
  sendEachSettledOrder: false,
  sendTime: "21:00"
};

export function IntegrationsAdmin() {
  const [google, setGoogle] = useState<GoogleSheetsSettings | null>(null);
  const [email, setEmail] = useState<EmailSettings>(defaultEmail);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [spreadsheets, setSpreadsheets] = useState<GoogleSpreadsheetOption[]>([]);
  const [tabs, setTabs] = useState<GoogleSheetTabOption[]>([]);
  const [emailPreview, setEmailPreview] = useState("");
  const [busy, setBusy] = useState<BusyAction>("load");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!window.yamzo) {
        if (active) {
          setError("Google integrations are available in the installed Yamzo desktop app.");
          setBusy("");
        }
        return;
      }
      try {
        const [googleSettings, emailSettings] = await Promise.all([
          window.yamzo.settings.getGoogleSheets(),
          window.yamzo.email.getSettings()
        ]);
        if (!active) return;
        setGoogle(googleSettings);
        setClientId(googleSettings.clientId ?? "");
        setEmail({ ...defaultEmail, ...emailSettings, sendTime: emailSettings.sendTime || "21:00" });
        if (googleSettings.connected) {
          void discoverSpreadsheets(false);
          if (googleSettings.spreadsheetId) void discoverTabs(googleSettings.spreadsheetId, false);
        }
      } catch (caught) {
        if (active) setError(readableError(caught, "Could not load integration settings."));
      } finally {
        if (active) setBusy("");
      }
    }
    void load();
    return () => {
      active = false;
    };
    // Initial load owns discovery; later refreshes are explicit to avoid duplicate OAuth requests in StrictMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const spreadsheetOptions = useMemo<SearchableSelectOption[]>(() => {
    const options = spreadsheets.map((sheet) => ({
      value: sheet.id,
      label: sheet.name,
      description: sheet.modifiedTime ? `Updated ${formatTimestamp(sheet.modifiedTime)}` : undefined,
      keywords: sheet.id
    }));
    if (google?.spreadsheetId && !options.some((option) => option.value === google.spreadsheetId)) {
      options.unshift({
        value: google.spreadsheetId,
        label: google.spreadsheetTitle || "Configured spreadsheet",
        description: "Saved mapping",
        keywords: google.spreadsheetId
      });
    }
    return options;
  }, [google?.spreadsheetId, google?.spreadsheetTitle, spreadsheets]);

  const tabOptions = useMemo<SearchableSelectOption[]>(() => {
    const options = tabs.map((tab) => ({
      value: tab.title,
      label: tab.title,
      description: tab.hidden ? "Hidden tab" : `Tab ${tab.index + 1}`,
      keywords: String(tab.id)
    }));
    for (const title of [google?.ordersTab, google?.orderItemsTab, google?.costsTab]) {
      if (title && !options.some((option) => option.value === title)) {
        options.push({ value: title, label: title, description: "Saved mapping", keywords: title });
      }
    }
    return options;
  }, [google?.costsTab, google?.orderItemsTab, google?.ordersTab, tabs]);

  const clientIsDirty = Boolean(google && (clientId.trim() !== google.clientId || clientSecret.trim()));
  const secretIsRequired = Boolean(google && (!google.hasClientCredentials || clientId.trim() !== google.clientId));
  const connected = Boolean(google?.connected);
  const appsScriptNeedsAccess = google?.lastErrorCode === "apps_script_user_setting_disabled";

  function startAction(action: BusyAction, waitingMessage = "") {
    setBusy(action);
    setError("");
    setNotice(waitingMessage);
  }

  function finishError(caught: unknown, fallback: string) {
    setNotice("");
    setError(readableError(caught, fallback));
    setBusy("");
  }

  async function saveCredentials() {
    if (!window.yamzo || !google) return null;
    if (!clientId.trim()) {
      setError("Enter the OAuth client ID from Google Cloud.");
      return null;
    }
    if (secretIsRequired && !clientSecret.trim()) {
      setError("Enter the client secret for this OAuth client ID.");
      return null;
    }
    startAction("credentials");
    try {
      const saved = await window.yamzo.settings.saveGoogleOAuthClient({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined
      });
      setGoogle(saved);
      setClientId(saved.clientId);
      setClientSecret("");
      setNotice("OAuth client saved securely on this computer.");
      return saved;
    } catch (caught) {
      finishError(caught, "Could not save the Google OAuth client.");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function connectGoogle() {
    if (!window.yamzo || !google) return;
    startAction("connect", "Your browser is opening. Approve the requested Yamzo permissions to continue.");
    try {
      if (clientIsDirty || !google.hasClientCredentials) {
        if (!clientId.trim()) throw new Error("Enter the OAuth client ID before connecting.");
        if (secretIsRequired && !clientSecret.trim()) throw new Error("Enter the client secret before connecting.");
        const saved = await window.yamzo.settings.saveGoogleOAuthClient({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim() || undefined
        });
        setGoogle(saved);
        setClientSecret("");
      }
      const result = await window.yamzo.settings.connectGoogleSheets();
      setGoogle(result.settings);
      setClientId(result.settings.clientId);
      const refreshedEmail = await window.yamzo.email.getSettings();
      setEmail({ ...defaultEmail, ...refreshedEmail, sendTime: refreshedEmail.sendTime || "21:00" });
      setNotice(`Connected${result.connectedEmail ? ` as ${result.connectedEmail}` : ""}. Choose a spreadsheet and map its tabs.`);
      await Promise.all([
        discoverSpreadsheets(false),
        result.settings.spreadsheetId ? discoverTabs(result.settings.spreadsheetId, false) : Promise.resolve()
      ]);
    } catch (caught) {
      finishError(caught, "Google authorization did not complete.");
    } finally {
      setBusy("");
    }
  }

  async function disconnectGoogle() {
    if (!window.yamzo) return;
    startAction("disconnect");
    try {
      const saved = await window.yamzo.settings.disconnectGoogle();
      setGoogle(saved);
      setSpreadsheets([]);
      setTabs([]);
      setEmail((current) => ({ ...current, connectedEmail: null }));
      setDisconnectOpen(false);
      setNotice("Google authorization was removed from this computer. Your saved mapping was kept.");
    } catch (caught) {
      finishError(caught, "Could not disconnect Google.");
    } finally {
      setBusy("");
    }
  }

  async function discoverSpreadsheets(showBusy = true) {
    if (!window.yamzo) return;
    if (showBusy) startAction("discover");
    try {
      const options = await window.yamzo.settings.listGoogleSpreadsheets();
      setSpreadsheets(options);
      if (showBusy) setNotice(`Loaded ${options.length} available spreadsheet${options.length === 1 ? "" : "s"}.`);
    } catch (caught) {
      if (showBusy) finishError(caught, "Could not load Google spreadsheets. Reconnect Google if permissions changed.");
    } finally {
      if (showBusy) setBusy("");
    }
  }

  async function discoverTabs(spreadsheetId: string, showBusy = true) {
    if (!window.yamzo || !spreadsheetId) return;
    if (showBusy) startAction("tabs");
    try {
      const result = await window.yamzo.settings.listGoogleSheetTabs(spreadsheetId);
      setTabs(result.tabs);
      setGoogle((current) => current ? { ...current, spreadsheetId: result.spreadsheetId, spreadsheetTitle: result.spreadsheetTitle } : current);
      if (showBusy) setNotice(`Loaded ${result.tabs.length} tabs from ${result.spreadsheetTitle}.`);
    } catch (caught) {
      if (showBusy) finishError(caught, "Could not load spreadsheet tabs.");
    } finally {
      if (showBusy) setBusy("");
    }
  }

  async function chooseSpreadsheet(spreadsheetId: string) {
    if (!google) return;
    const selected = spreadsheets.find((item) => item.id === spreadsheetId);
    setGoogle({ ...google, spreadsheetId, spreadsheetTitle: selected?.name ?? null });
    setTabs([]);
    await discoverTabs(spreadsheetId);
  }

  async function saveMapping() {
    if (!window.yamzo || !google) return;
    if (!google.spreadsheetId || !google.ordersTab || !google.orderItemsTab || !google.costsTab) {
      setError("Choose a spreadsheet and map the Orders, Order Items, and Costs tabs.");
      return;
    }
    startAction("mapping");
    try {
      const saved = await window.yamzo.settings.setGoogleSheets({
        enabled: google.enabled,
        spreadsheetId: google.spreadsheetId,
        ordersTab: google.ordersTab,
        orderItemsTab: google.orderItemsTab,
        costsTab: google.costsTab
      });
      setGoogle(saved);
      setNotice("Spreadsheet mapping saved.");
    } catch (caught) {
      finishError(caught, "Could not save the spreadsheet mapping.");
    } finally {
      setBusy("");
    }
  }

  async function syncNow() {
    if (!window.yamzo) return;
    startAction("sync");
    try {
      const result = await window.yamzo.settings.syncGoogleSheets();
      const refreshed = await window.yamzo.settings.getGoogleSheets();
      setGoogle(refreshed);
      setNotice(`Synced ${result.orders} orders, ${result.orderItems} order items, and ${result.costs} costs to ${result.spreadsheetTitle}.`);
    } catch (caught) {
      finishError(caught, "Google Sheets sync failed. Local POS data was not affected.");
    } finally {
      setBusy("");
    }
  }

  async function installReportMenu() {
    if (!window.yamzo) return;
    startAction("report");
    try {
      await window.yamzo.settings.installGoogleReportTool();
      const refreshed = await window.yamzo.settings.getGoogleSheets();
      setGoogle(refreshed);
      setNotice("Yamzo Reports was installed. Reload the spreadsheet once to see the menu.");
    } catch (caught) {
      const refreshed = await window.yamzo.settings.getGoogleSheets().catch(() => null);
      if (refreshed) setGoogle(refreshed);
      finishError(caught, "Could not install the spreadsheet report menu.");
    } finally {
      setBusy("");
    }
  }

  async function saveEmailSettings() {
    if (!window.yamzo) return;
    if (email.enabled && !email.recipientEmail.trim()) {
      setError("Enter the email address that should receive Yamzo summaries.");
      return;
    }
    startAction("email");
    try {
      const saved = await window.yamzo.email.saveSettings({
        enabled: email.enabled,
        recipientEmail: email.recipientEmail.trim(),
        sendDailySummary: email.sendDailySummary,
        sendEachSettledOrder: false,
        sendTime: email.sendTime || "21:00"
      });
      setEmail({ ...defaultEmail, ...saved, sendTime: saved.sendTime || "21:00" });
      setNotice("Email delivery settings saved.");
    } catch (caught) {
      finishError(caught, "Could not save email settings.");
    } finally {
      setBusy("");
    }
  }

  async function previewEmail() {
    if (!window.yamzo) return;
    startAction("preview");
    try {
      setEmailPreview(await window.yamzo.email.dailyPreview());
      setNotice("Daily summary preview refreshed.");
    } catch (caught) {
      finishError(caught, "Could not build the daily summary preview.");
    } finally {
      setBusy("");
    }
  }

  async function sendTestEmail() {
    if (!window.yamzo) return;
    startAction("send");
    try {
      await window.yamzo.email.saveSettings({
        enabled: email.enabled,
        recipientEmail: email.recipientEmail.trim(),
        sendDailySummary: email.sendDailySummary,
        sendEachSettledOrder: false,
        sendTime: email.sendTime || "21:00"
      });
      const result = await window.yamzo.email.sendDaily();
      const refreshed = await window.yamzo.email.getSettings();
      setEmail({ ...defaultEmail, ...refreshed, sendTime: refreshed.sendTime || "21:00" });
      setNotice(`Summary sent to ${result.recipientEmail} from ${result.connectedEmail}.`);
    } catch (caught) {
      finishError(caught, "Could not send the summary email.");
    } finally {
      setBusy("");
    }
  }

  if (!google) {
    return <div className="pt-4"><Card><CardContent className="flex items-center gap-3 p-5 text-muted-foreground"><RefreshCw className="size-4 animate-spin" />Loading integrations...</CardContent></Card></div>;
  }

  return (
    <div className="grid max-w-7xl gap-4 pt-4">
      <section className="grid gap-3 lg:grid-cols-3" aria-label="Integration status">
        <StatusCard
          icon={<Cloud />}
          label="Google account"
          value={google.connectedEmail || (google.hasClientCredentials ? "Ready to connect" : "Setup required")}
          status={connected ? "Connected" : "Not connected"}
          ready={connected}
        />
        <StatusCard
          icon={<FileSpreadsheet />}
          label="Spreadsheet"
          value={google.spreadsheetTitle || "No spreadsheet selected"}
          status={google.lastSyncedAt ? `Synced ${formatTimestamp(google.lastSyncedAt)}` : "Never synced"}
          ready={Boolean(google.spreadsheetId && google.ordersTab && google.orderItemsTab && google.costsTab)}
        />
        <StatusCard
          icon={<Mail />}
          label="Email summaries"
          value={email.enabled ? email.recipientEmail || "Recipient required" : "Disabled"}
          status={email.enabled && email.sendDailySummary ? `Daily at ${email.sendTime || "21:00"}` : "Manual only"}
          ready={Boolean(email.enabled && email.recipientEmail && connected)}
        />
      </section>

      {(error || notice) && (
        <div
          role={error ? "alert" : "status"}
          aria-live="polite"
          className={`rounded-xl border px-4 py-3 text-sm ${error ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-emerald-200 bg-emerald-50 text-emerald-950"}`}
        >
          {error || notice}
        </div>
      )}

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" />Google workspace connection</CardTitle>
          <CardDescription>Save your own Google OAuth client on this computer. Yamzo never displays the saved secret again.</CardDescription>
          <CardAction><Badge variant={connected ? "default" : "secondary"}>{connected ? "Connected" : google.hasClientCredentials ? "Client saved" : "Setup required"}</Badge></CardAction>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <IntegrationField id="google-client-id" label="OAuth client ID" helper="Google Cloud → APIs & Services → Credentials">
              <Input id="google-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" placeholder="...apps.googleusercontent.com" />
            </IntegrationField>
            <IntegrationField id="google-client-secret" label="OAuth client secret" helper={google.hasClientCredentials && clientId.trim() === google.clientId ? "Leave blank to keep the securely saved secret" : "Required for a new client ID"}>
              <Input id="google-client-secret" type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" placeholder={google.hasClientCredentials ? "Saved securely" : "Enter client secret"} />
            </IntegrationField>
          </div>
          <div className="rounded-xl border bg-muted/30 p-4">
            <p className="text-sm font-medium">Authorized redirect URI</p>
            <code className="mt-2 block overflow-x-auto rounded-lg border bg-background px-3 py-2 text-xs">{google.redirectUri}</code>
            <p className="mt-2 text-xs text-muted-foreground">Add this exact URI to the Web application OAuth client in Google Cloud. No JavaScript origin is required for the desktop flow.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={saveCredentials} disabled={Boolean(busy) || (!clientIsDirty && google.hasClientCredentials)}>{busy === "credentials" ? "Saving..." : "Save OAuth Client"}</Button>
            <Button variant="secondary" onClick={connectGoogle} disabled={Boolean(busy) || (!google.hasClientCredentials && (!clientId.trim() || !clientSecret.trim()))}>{busy === "connect" ? "Waiting for Google..." : connected ? "Reconnect Google" : "Connect Google"}</Button>
            {connected && <Button variant="outline" onClick={() => setDisconnectOpen(true)} disabled={Boolean(busy)}><Unplug />Disconnect</Button>}
          </div>
          <p className="text-xs text-muted-foreground">One connection authorizes spreadsheet sync and discovery, the optional spreadsheet report installer, and Gmail sending. Google will show each requested permission before you approve it.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2"><FileSpreadsheet className="size-4" />Orders and costs spreadsheet</CardTitle>
          <CardDescription>Choose a spreadsheet, then map the exact tabs. Yamzo POS remains the source of truth; the Sheet never writes back.</CardDescription>
          <CardAction><Badge variant={google.syncStatus === "error" ? "destructive" : google.pending ? "secondary" : "outline"}>{google.pending ? "Sync pending" : humanize(google.syncStatus)}</Badge></CardAction>
        </CardHeader>
        <CardContent className="grid gap-5">
          <label className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
            <Checkbox checked={google.enabled} onCheckedChange={(checked) => setGoogle({ ...google, enabled: Boolean(checked) })} />
            <span className="grid gap-1"><strong>Sync POS changes automatically</strong><small className="text-muted-foreground">Order and cost create, edit, and delete actions schedule a one-way reconciliation.</small></span>
          </label>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <IntegrationField id="google-spreadsheet" label="Spreadsheet" helper={connected ? "Search all spreadsheets available to the connected Google account" : "Connect Google before choosing a spreadsheet"}>
              <SearchableSelect
                id="google-spreadsheet"
                value={google.spreadsheetId}
                onValueChange={chooseSpreadsheet}
                options={spreadsheetOptions}
                placeholder={connected ? "Choose a spreadsheet" : "Connect Google first"}
                searchPlaceholder="Search spreadsheets..."
                emptyText="No spreadsheets found."
                ariaLabel="Spreadsheet"
                disabled={!connected || busy === "discover"}
                className="h-9"
              />
            </IntegrationField>
            <Button variant="secondary" onClick={() => discoverSpreadsheets()} disabled={!connected || Boolean(busy)}>{busy === "discover" ? <RefreshCw className="animate-spin" /> : <RefreshCw />}Refresh list</Button>
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <IntegrationField id="google-spreadsheet-manual" label="Spreadsheet URL or ID" helper="Manual fallback when a spreadsheet is not returned by discovery">
              <Input id="google-spreadsheet-manual" value={google.spreadsheetId} onChange={(event) => setGoogle({ ...google, spreadsheetId: event.target.value, spreadsheetTitle: null })} placeholder="Paste a Google Sheets URL or spreadsheet ID" />
            </IntegrationField>
            <Button variant="outline" onClick={() => discoverTabs(google.spreadsheetId)} disabled={!connected || !google.spreadsheetId.trim() || Boolean(busy)}>{busy === "tabs" ? "Loading tabs..." : "Load Tabs"}</Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <IntegrationField id="orders-tab" label="Orders tab">
              <SearchableSelect id="orders-tab" value={google.ordersTab} onValueChange={(value) => setGoogle({ ...google, ordersTab: value })} options={tabOptions} placeholder="Choose Orders tab" searchPlaceholder="Search tabs..." ariaLabel="Orders tab" disabled={!google.spreadsheetId || !tabs.length} className="h-9" />
            </IntegrationField>
            <IntegrationField id="order-items-tab" label="Order items tab">
              <SearchableSelect id="order-items-tab" value={google.orderItemsTab} onValueChange={(value) => setGoogle({ ...google, orderItemsTab: value })} options={tabOptions} placeholder="Choose Order Items tab" searchPlaceholder="Search tabs..." ariaLabel="Order items tab" disabled={!google.spreadsheetId || !tabs.length} className="h-9" />
            </IntegrationField>
            <IntegrationField id="costs-tab" label="Costs tab">
              <SearchableSelect id="costs-tab" value={google.costsTab} onValueChange={(value) => setGoogle({ ...google, costsTab: value })} options={tabOptions} placeholder="Choose Costs tab" searchPlaceholder="Search tabs..." ariaLabel="Costs tab" disabled={!google.spreadsheetId || !tabs.length} className="h-9" />
            </IntegrationField>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={saveMapping} disabled={!connected || Boolean(busy)}>{busy === "mapping" ? "Saving..." : "Save Mapping"}</Button>
            <Button variant="secondary" onClick={syncNow} disabled={!connected || !google.spreadsheetId || Boolean(busy)}>{busy === "sync" ? "Syncing..." : "Sync Now"}</Button>
            <Button variant="outline" onClick={installReportMenu} disabled={!connected || !google.spreadsheetId || Boolean(busy)}>{busy === "report" ? "Installing..." : google.reportToolInstalled ? "Reinstall Yamzo Reports" : "Install Yamzo Reports"}</Button>
          </div>
          {(appsScriptNeedsAccess || google.lastErrorCode === "permission_missing") && (
            <div className="grid gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 md:grid-cols-[1fr_auto] md:items-center">
              <div><strong>One Google permission still needs attention</strong><p className="mt-1 text-sm">Cloud API enablement and the Google account’s Apps Script access are separate. Turn on Apps Script API access for the connected account, then retry the report installer.</p></div>
              <Button variant="outline" onClick={() => window.yamzo?.settings.openGoogleAppsScriptSettings()}><ExternalLink />Open Apps Script access</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2"><Mail className="size-4" />Email summaries</CardTitle>
          <CardDescription>Use the same connected Google account to send management summaries on a predictable schedule.</CardDescription>
          <CardAction><Badge variant={email.enabled ? "default" : "secondary"}>{email.enabled ? "Enabled" : "Disabled"}</Badge></CardAction>
        </CardHeader>
        <CardContent className="grid gap-5">
          <label className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
            <Checkbox checked={email.enabled} onCheckedChange={(checked) => setEmail({ ...email, enabled: Boolean(checked) })} />
            <span className="grid gap-1"><strong>Enable email delivery</strong><small className="text-muted-foreground">Messages are sent from {google.connectedEmail || "the connected Google account"} while Yamzo POS is running.</small></span>
          </label>
          <div className="grid gap-4 lg:grid-cols-[minmax(240px,1fr)_180px]">
            <IntegrationField id="summary-recipient" label="Send summaries to">
              <Input id="summary-recipient" type="email" value={email.recipientEmail} onChange={(event) => setEmail({ ...email, recipientEmail: event.target.value })} placeholder="manager@example.com" autoComplete="email" />
            </IntegrationField>
            <IntegrationField id="summary-time" label="Daily send time" helper="This computer's local time">
              <Input id="summary-time" type="time" value={email.sendTime || "21:00"} onChange={(event) => setEmail({ ...email, sendTime: event.target.value })} />
            </IntegrationField>
          </div>
          <label className="flex items-start gap-3 rounded-xl border p-4"><Checkbox checked={email.sendDailySummary} onCheckedChange={(checked) => setEmail({ ...email, sendDailySummary: Boolean(checked) })} /><span><strong className="flex items-center gap-2"><Clock3 className="size-4" />Daily sales summary</strong><small className="mt-1 block text-muted-foreground">Sent once per business day at or after the selected time.</small></span></label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={saveEmailSettings} disabled={Boolean(busy)}>{busy === "email" ? "Saving..." : "Save Email Settings"}</Button>
            <Button variant="secondary" onClick={previewEmail} disabled={Boolean(busy)}>{busy === "preview" ? "Building..." : "Preview Summary"}</Button>
            <Button variant="outline" onClick={sendTestEmail} disabled={!connected || !email.recipientEmail.trim() || Boolean(busy)}>{busy === "send" ? "Sending..." : "Send Test Summary"}</Button>
          </div>
          {emailPreview && <><Separator /><div><p className="mb-2 text-sm font-medium">Summary preview</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border bg-muted/30 p-4 text-xs leading-relaxed">{emailPreview}</pre></div></>}
          {(email.lastDailySummarySentAt || email.lastError) && <p className="text-xs text-muted-foreground">{email.lastError ? `Last delivery issue: ${email.lastError}` : `Last daily summary: ${formatTimestamp(email.lastDailySummarySentAt || "")}`}</p>}
        </CardContent>
      </Card>

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Google?</AlertDialogTitle>
            <AlertDialogDescription>The local authorization token will be removed. Spreadsheet mapping and email preferences remain saved, but syncing and email stop until Google is connected again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction onClick={disconnectGoogle}>Disconnect Google</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IntegrationField({ id, label, helper, children }: { id: string; label: string; helper?: string; children: React.ReactNode }) {
  return <div className="grid gap-1.5"><Label htmlFor={id}>{label}</Label>{children}{helper && <p className="text-xs text-muted-foreground">{helper}</p>}</div>;
}

function StatusCard({ icon, label, value, status, ready }: { icon: React.ReactNode; label: string; value: string; status: string; ready: boolean }) {
  return (
    <Card size="sm" className={ready ? "bg-emerald-50/40 ring-emerald-200" : "bg-muted/10"}>
      <CardContent className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <span className={`grid size-9 place-items-center rounded-lg ${ready ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>{icon}</span>
        <span className="min-w-0"><span className="block text-xs text-muted-foreground">{label}</span><strong className="block truncate">{value}</strong><small className="block truncate text-muted-foreground">{status}</small></span>
        {ready && <CheckCircle2 className="size-4 text-emerald-700" aria-label="Ready" />}
      </CardContent>
    </Card>
  );
}

function readableError(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  const cleaned = caught.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  return cleaned || fallback;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: string): string {
  if (!value) return "Never";
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
