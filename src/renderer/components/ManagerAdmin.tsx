import { useEffect, useState } from "react";
import type { Manager } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ManagerAdmin({ onMessage }: { onMessage: (message: string) => void }) {
  const [managers, setManagers] = useState<Manager[]>([]);
  const [draft, setDraft] = useState({ id: 0, managerCode: "", name: "", pin: "", active: true });

  async function refresh() {
    setManagers(await window.yamzo?.managers.list(true) ?? []);
  }

  useEffect(() => { void refresh(); }, []);

  async function save() {
    try {
      await window.yamzo?.managers.save({
        id: draft.id || undefined,
        managerCode: draft.managerCode,
        name: draft.name,
        pin: draft.pin || undefined,
        active: draft.active
      });
      setDraft({ id: 0, managerCode: "", name: "", pin: "", active: true });
      await refresh();
      onMessage("Manager saved. PIN is stored as a secure hash.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Could not save manager.");
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.8fr)_minmax(420px,1.2fr)]">
      <Card>
        <CardHeader>
          <CardTitle>{draft.id ? "Edit manager" : "Add manager"}</CardTitle>
          <CardDescription>Managers authorize protected areas and every post-KOT Swap / Change.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2"><Label>Manager ID</Label><Input value={draft.managerCode} onChange={(event) => setDraft({ ...draft, managerCode: event.target.value.toUpperCase() })} placeholder="MGR-002" /></div>
          <div className="grid gap-2"><Label>Name</Label><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Manager name" /></div>
          <div className="grid gap-2"><Label>{draft.id ? "New PIN (optional)" : "PIN"}</Label><Input type="password" inputMode="numeric" autoComplete="new-password" value={draft.pin} onChange={(event) => setDraft({ ...draft, pin: event.target.value.replace(/\D/g, "").slice(0, 8) })} placeholder="4-8 digits" /></div>
          <label className="flex items-center gap-3 rounded-lg border p-3 text-sm font-medium"><Checkbox checked={draft.active} onCheckedChange={(checked) => setDraft({ ...draft, active: checked === true })} /> Active manager</label>
          <div className="flex gap-2"><Button onClick={save}>{draft.id ? "Update Manager" : "Add Manager"}</Button>{draft.id > 0 && <Button variant="secondary" onClick={() => setDraft({ id: 0, managerCode: "", name: "", pin: "", active: true })}>Cancel</Button>}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Manager identities</CardTitle><CardDescription>PIN hashes never leave the Electron main process.</CardDescription></CardHeader>
        <CardContent className="grid gap-2">
          {managers.map((manager) => (
            <button key={manager.id} type="button" className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-xl border p-3 text-left hover:bg-muted" onClick={() => setDraft({ id: manager.id, managerCode: manager.managerCode, name: manager.name, pin: "", active: manager.active })}>
              <span><strong className="block">{manager.name}</strong><span className="text-xs text-muted-foreground">{manager.managerCode}</span></span>
              <span className={manager.active ? "text-emerald-700" : "text-slate-500"}>{manager.active ? "Active" : "Disabled"}</span>
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
